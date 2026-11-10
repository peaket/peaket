// 낮춘 결제사 채널 상한을 파드 사이에 맞춘다(docs/features/payment.md §2 '낮춘 상한의 유지·전파·회복', docs/data.md §5, BUILD_ORDER PRF-203).
// - 1초 [가정]마다 표 전체를 읽어 보호기에 건다. 읽기가 실패하면 보호기가 마지막 값을 그 만료까지 쓴다(보호기는 만료된 값을 스스로 걷는다).
// - 보호기가 직접 낮추면(lowered) 같은 값을 판 번호 조건으로 쓴다. 겨루어 지면 다시 읽어 보호기에 걸고, 그 행이 이미 이 낮춤을 담으면 멈추고 아니면 2번 [가정] 더 한다.
// - 표 쓰기가 실패해도 보호기의 값은 그대로다(같은 만료까지). 실패는 지표와 경고 로그로만 낸다(SEV2는 보호기의 pg-throttled-first 한 줄이다).
// - 저장소 호출마다 클라이언트 시간 한도(읽기 300ms·쓰기와 다시 읽기 600ms [가정])를 건다. 넘으면 그 단계의 실패로 세고, 다음 틱은 새 읽기를 시작하며, stop()은 걸린 호출을 기다리지 않는다(코드 리뷰 F4).
// - 멈춘 뒤에 온 낮춤은 쓰지 않고 쓰기 실패로 센다. 종료 때는 실행기가 멈춘 뒤에 멈춘다(main.ts SIGTERM의 drain 단계, shutdown.ts, 코드 리뷰 F5).
// 구현에서 정한 것(정본·설계에 없다):
// - 겹친 맞추기는 돌고 있는 읽기 하나를 함께 기다린다. 쓰기는 낮춤마다 따로 돈다(멈출 때 모두 기다린다).
// - 읽은 표에 행이 없는 결제사는 '행 없음'을 건다(보호기는 판 번호가 작은 행만 버린다).
import type { Clock } from '@peaket/platform';
import { safeErrorCode } from '../../../safe-error-code.js';
import type { PgName } from '../domain/payment-gateway.js';
import { PG_NAMES, type PgCallGuard, type PgCallGuards } from '../domain/pg-call-guard.js';
import { loweringCovered, PG_LIMIT_SYNC_MS, PG_LIMIT_WRITE_RETRIES, type PgChannelLimitRow, type PgLimitLowering } from '../domain/pg-channel-limit.js';
import type { PgChannelLimitStore, PgChannelLimitSyncLog, PgChannelLimitSyncSignals, PgChannelLimitSyncStep } from '../domain/ports.js';
import { withClientTimeout } from './client-timeout.js';

/** 표 전체 읽기의 클라이언트 시간 한도 300ms [가정](문장 한도 150ms에 연결 받기·BEGIN 여유) */
export const PG_LIMIT_READ_CLIENT_TIMEOUT_MS = 300;
/** 낮춤의 쓰기·다시 읽기의 클라이언트 시간 한도 600ms [가정](문장 한도 400ms에 여유) */
export const PG_LIMIT_WRITE_CLIENT_TIMEOUT_MS = 600;

/** 멈춘 뒤에 온 낮춤(쓰지 않는다, 안전한 오류 코드 STOPPED) */
class SyncStoppedError extends Error {
  readonly code = 'STOPPED' as const;
  constructor() {
    super('표 맞추기가 멈춘 뒤의 낮춤');
    this.name = 'SyncStoppedError';
  }
}

/** 반복 타이머(시험이 손으로 부르는 대역을 꽂는다. 기본은 unref한 setInterval) */
export interface PgChannelLimitSyncTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PgChannelLimitSyncDeps {
  readonly store: PgChannelLimitStore;
  readonly guards: PgCallGuards;
  readonly clock: Pick<Clock, 'now'>;
  readonly signals: PgChannelLimitSyncSignals;
  readonly log: PgChannelLimitSyncLog;
  readonly timer?: PgChannelLimitSyncTimer;
}

const DEFAULT_TIMER: PgChannelLimitSyncTimer = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class PgChannelLimitSync {
  readonly #inflight = new Set<Promise<unknown>>();
  #reading: Promise<boolean> | undefined;
  #handle: unknown;
  #stopped = false;

  constructor(private readonly deps: PgChannelLimitSyncDeps) {}

  /** 1초 [가정] 맞추기를 켠다(이미 켰거나 멈췄으면 아무것도 하지 않는다) */
  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    this.#handle = this.#timer().setInterval(() => {
      if (!this.#stopped) void this.refresh();
    }, PG_LIMIT_SYNC_MS);
  }

  /** 맞추기를 끄고 돌던 읽기·쓰기를 기다린다 */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#handle !== undefined) {
      this.#timer().clearInterval(this.#handle);
      this.#handle = undefined;
    }
    await this.whenIdle();
  }

  /** 돌고 있는 읽기·쓰기가 모두 끝나면 풀린다 */
  async whenIdle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  /** 표 전체를 읽어 보호기에 건다. 던지지 않는다. @returns 읽었으면 true(실패면 보호기는 마지막 값을 쓴다) */
  refresh(): Promise<boolean> {
    if (this.#reading !== undefined) return this.#reading;
    const p = this.#readAll().finally(() => {
      this.#reading = undefined;
    });
    this.#reading = p;
    return this.#track(p);
  }

  /** 보호기가 직접 낮췄다: 표에 쓴다(비동기, 던지지 않는다). 멈춘 뒤면 쓰지 않고 쓰기 실패로 센다 */
  lowered(e: PgLimitLowering): void {
    if (this.#stopped) {
      this.#failed('write', e.pg, new SyncStoppedError());
      return;
    }
    void this.#track(this.#write(e));
  }

  // ---- 안쪽 ----

  async #readAll(): Promise<boolean> {
    let rows: ReadonlyMap<PgName, PgChannelLimitRow>;
    try {
      rows = await withClientTimeout(this.deps.store.readAll(), PG_LIMIT_READ_CLIENT_TIMEOUT_MS);
    } catch (err) {
      this.#failed('read', undefined, err);
      return false;
    }
    for (const pg of PG_NAMES) this.#guardOf(pg)?.applyShared(rows.get(pg));
    return true;
  }

  async #write(e: PgLimitLowering): Promise<void> {
    const guard = this.#guardOf(e.pg);
    let basis = e.basis;
    for (let attempt = 0; attempt <= PG_LIMIT_WRITE_RETRIES; attempt += 1) {
      let written: PgChannelLimitRow | undefined;
      try {
        written = await withClientTimeout(this.deps.store.write(basis, e, this.deps.clock.now()), PG_LIMIT_WRITE_CLIENT_TIMEOUT_MS);
      } catch (err) {
        this.#failed('write', e.pg, err);
        return;
      }
      if (written !== undefined) {
        guard?.applyShared(written);
        return;
      }
      // 판 번호에 졌다: 다시 읽어 걸고, 그 행이 이미 이 낮춤을 담으면 쓰지 않는다(한 번만 낮춘다)
      let fresh: PgChannelLimitRow | undefined;
      try {
        fresh = await withClientTimeout(this.deps.store.read(e.pg), PG_LIMIT_WRITE_CLIENT_TIMEOUT_MS);
      } catch (err) {
        this.#failed('read', e.pg, err);
        return;
      }
      guard?.applyShared(fresh);
      if (loweringCovered(fresh, e)) return;
      basis = fresh;
    }
    this.#failed('conflict', e.pg, undefined);
  }

  #guardOf(pg: PgName): PgCallGuard | undefined {
    try {
      return this.deps.guards.of(pg);
    } catch {
      // capabilities()가 던졌다: 다음 맞추기가 다시 만든다
      return undefined;
    }
  }

  #failed(step: PgChannelLimitSyncStep, pg: PgName | undefined, err: unknown): void {
    try {
      this.deps.signals.limitSyncFailed(step);
    } catch {
      // 지표가 맞추기를 막지 않는다
    }
    try {
      this.deps.log.limitSyncFailed({ step, ...(pg === undefined ? {} : { pg }), code: err === undefined ? 'conflict' : safeErrorCode(err) });
    } catch {
      // 로그가 맞추기를 막지 않는다
    }
  }

  #track<T>(p: Promise<T>): Promise<T> {
    this.#inflight.add(p);
    void p.finally(() => this.#inflight.delete(p)).catch(() => undefined);
    return p;
  }

  #timer(): PgChannelLimitSyncTimer {
    return this.deps.timer ?? DEFAULT_TIMER;
  }
}
