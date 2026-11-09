// 구매 세션 정리 반복(BUILD_ORDER PRF-138, docs/features/seat-hold.md §2 '구매 세션 종료와 정리'). 1초 [가정]마다 회차 임대(s:{event:E}:sesweep)를 잡은 파드가
// 정리 색인 s:{event:E}:sessions에서 점검 시각이 된 세션을 100개 [가정]까지 읽어 하나씩 점검 Lua(store.sweep)로 끝내거나 다음 점검 시각으로 다시 놓는다.
// 시각은 주입 Clock, 반복은 주입 타이머다(시험은 tick()을 손으로 부른다).
import type { Clock } from '@peaket/platform';
import { SeatStoreUnavailable } from '../domain/hold.js';
import { seatLuaErrorOf } from '../domain/lua-errors.js';
import type { PurchaseSessionStore, SeatExpiries, SessionIndex, SweepLeases } from '../domain/ports.js';
import type { EndPurchaseSession } from './end-purchase-session.js';
import { type SweepTimer, systemSweepTimer } from './expiry-sweeper.js';

/** 한 번에 점검하는 세션 수 100 [가정] */
export const SESSION_SWEEP_BATCH = 100;
/** 한 틱에 회차 하나를 도는 묶음 수의 상한 5 [가정] */
export const SESSION_SWEEP_MAX_BATCHES = 5;
/** 반복 주기 1초 [가정] */
export const SESSION_SWEEP_TICK_MS = 1000;
/** 정리 임대 수명 3초 [가정](만료 임대와 같다) */
export const SESSION_SWEEP_LEASE_TTL_MS = 3000;
/** 직전 틱에서 실패한 회차를 쉬는 시간 5초 [가정] */
export const SESSION_SWEEP_BACKOFF_MS = 5000;
/** 점검이 일시 장애가 아닌 오류로 실패한 멤버를 뒤로 미루는 시간 60초 [가정](망가진 멤버 하나가 같은 회차의 정리를 막지 않게) */
export const SESSION_SWEEP_POISON_RETRY_MS = 60_000;
/** 한 틱에 동시에 돌리는 회차 수 4 [가정](만료 반복과 같다) */
const SESSION_SWEEP_CONCURRENCY = 4;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 회차 하나의 틱 결과 */
export type SessionSweepOutcome = 'DRAINED' | 'BATCH_LIMIT' | 'NOT_LEASED' | 'UNAVAILABLE' | 'ERROR' | 'BACKOFF' | 'STOPPED';

export interface SessionSweepEventReport {
  eventId: string;
  outcome: SessionSweepOutcome;
  /** 점검한 세션 수 */
  checked: number;
  /** 끝낸 세션 수(IDLE·MAX_STAY) */
  ended: number;
  /** 세션이 이미 없어 색인에서 뺀 수 */
  gone: number;
}

export interface SessionSweepTickReport {
  overlapped: boolean;
  listFailed?: 'UNAVAILABLE' | 'ERROR';
  events: SessionSweepEventReport[];
}

export interface SessionSweeperDeps {
  store: Pick<PurchaseSessionStore, 'sweep'>;
  index: SessionIndex;
  /** 회차 목록(s:ctl:events)을 읽는다 */
  expiries: Pick<SeatExpiries, 'saleEvents'>;
  leases: SweepLeases;
  ending: Pick<EndPurchaseSession, 'recordEnded'>;
  clock: Clock;
  /** 임대 값(KEY_PART 모양의 파드 ID) */
  podId: string;
  logger?: { warn(obj: object, msg: string): void; error(obj: object, msg: string): void };
  /** 반복 타이머(기본 systemSweepTimer, 만료 반복과 같은 SweepTimer: every(ms, run) → { cancel() }) */
  timer?: SweepTimer;
}

export class SessionSweeper {
  #timer: { cancel(): void } | undefined;
  #running: Promise<SessionSweepTickReport> | undefined;
  #stops = 0;
  /** 직전 틱에서 실패한 회차 → 실패한 시각(주입 Clock의 단조 시계가 아니라 벽시계) */
  readonly #failedAt = new Map<string, number>();

  constructor(private readonly deps: SessionSweeperDeps) {}

  /**
   * 한 틱. 던지지 않는다. 앞 틱이 아직 끝나지 않았으면 아무것도 부르지 않고 { overlapped: true, events: [] }다.
   * 회차 목록(expiries.saleEvents)을 못 읽으면 { listFailed: 'UNAVAILABLE'(SeatStoreUnavailable) | 'ERROR' }다.
   * 회차마다: 직전 틱에서 UNAVAILABLE·ERROR였고 SESSION_SWEEP_BACKOFF_MS가 안 지났으면 BACKOFF → 정리 임대(lane 'session')를 못 잡으면 NOT_LEASED →
   * 최대 SESSION_SWEEP_MAX_BATCHES묶음까지 index.due(지금, SESSION_SWEEP_BATCH)로 읽어 세션마다 점검한다: store.sweep이 GONE이면 index.drop,
   * LIVE이면 index.requeue(nextCheckMs), ENDED이면 ending.recordEnded(IDLE·MAX_STAY, 사건 더하기와 지표). 모양이 틀린 멤버(RangeError)는 index.drop한다.
   * 묶음이 BATCH 미만이면 DRAINED, 상한까지 꽉 차면 BATCH_LIMIT. stop()이 불렸으면 남은 일을 하지 않고 STOPPED다.
   */
  tick(): Promise<SessionSweepTickReport> {
    if (this.#running) return Promise.resolve({ overlapped: true, events: [] });
    const p: Promise<SessionSweepTickReport> = this.#tick(this.#stops).finally(() => {
      this.#running = undefined;
    });
    this.#running = p;
    return p;
  }

  /** 반복을 켠다(첫 틱은 1초 뒤). 이미 켜져 있으면 아무 일도 없다. 틱에서 BATCH_LIMIT이 나오면 1초를 기다리지 않고 다음 틱을 바로 연다 */
  start(): void {
    if (this.#timer) return;
    this.#timer = (this.deps.timer ?? systemSweepTimer).every(SESSION_SWEEP_TICK_MS, () => void this.#loop());
  }

  /** 반복을 멈추고 돌던 틱을 기다린다. 두 번 불러도 된다 */
  async stop(): Promise<void> {
    this.#stops += 1;
    const t = this.#timer;
    this.#timer = undefined;
    t?.cancel();
    await this.#running?.catch(() => undefined);
  }

  async #loop(): Promise<void> {
    const stops = this.#stops;
    try {
      for (;;) {
        const r = await this.tick();
        if (r.overlapped || stops !== this.#stops) return;
        if (!r.events.some((e) => e.outcome === 'BATCH_LIMIT')) return;
      }
    } catch (err) {
      this.deps.logger?.error({ step: 'loop', ...this.#codeOf(err) }, '구매 세션 정리 반복이 틱 밖에서 오류를 만나 이번 반복을 멈췄다');
    }
  }

  async #tick(stops: number): Promise<SessionSweepTickReport> {
    const stopped = () => stops !== this.#stops;
    let list: string[];
    try {
      list = await this.deps.expiries.saleEvents();
    } catch (err) {
      if (err instanceof SeatStoreUnavailable) return { overlapped: false, listFailed: 'UNAVAILABLE', events: [] };
      this.deps.logger?.error({ step: 'list', ...this.#codeOf(err) }, '구매 세션 정리 반복이 회차 목록을 읽지 못했다');
      return { overlapped: false, listFailed: 'ERROR', events: [] };
    }
    const ids = [...new Set(list)].sort(byCodeUnit);
    const reports = new Map<string, SessionSweepEventReport>();
    let next = 0;
    const lane = async () => {
      while (next < ids.length && !stopped()) {
        const eventId = ids[next++]!;
        reports.set(eventId, await this.#sweepEvent(eventId, stopped));
      }
    };
    await Promise.all(Array.from({ length: Math.min(SESSION_SWEEP_CONCURRENCY, ids.length) }, lane));
    return { overlapped: false, events: ids.filter((id) => reports.has(id)).map((id) => reports.get(id)!) };
  }

  /** 회차 하나를 이번 틱에 돈다(던지지 않는다) */
  async #sweepEvent(eventId: string, stopped: () => boolean): Promise<SessionSweepEventReport> {
    const { clock, leases, index, podId } = this.deps;
    const report: SessionSweepEventReport = { eventId, outcome: 'DRAINED', checked: 0, ended: 0, gone: 0 };
    const failedAt = this.#failedAt.get(eventId);
    if (failedAt !== undefined && clock.now() < failedAt + SESSION_SWEEP_BACKOFF_MS) return { ...report, outcome: 'BACKOFF' };
    const done = (outcome: SessionSweepOutcome): SessionSweepEventReport => {
      if (outcome === 'UNAVAILABLE' || outcome === 'ERROR') this.#failedAt.set(eventId, clock.now());
      else this.#failedAt.delete(eventId);
      return { ...report, outcome };
    };
    try {
      if (!(await leases.acquire(eventId, podId, SESSION_SWEEP_LEASE_TTL_MS, 'session'))) return done('NOT_LEASED');
      for (let batch = 0; batch < SESSION_SWEEP_MAX_BATCHES; batch++) {
        if (stopped()) return done('STOPPED');
        const due = await index.due(eventId, clock.now(), SESSION_SWEEP_BATCH);
        for (const jti of due) await this.#check(eventId, jti, report);
        if (due.length < SESSION_SWEEP_BATCH) return done('DRAINED');
      }
      return done('BATCH_LIMIT');
    } catch (err) {
      if (err instanceof SeatStoreUnavailable) return done('UNAVAILABLE');
      this.deps.logger?.error({ eventId, step: 'sweep', ...this.#codeOf(err) }, '구매 세션 정리 반복이 회차를 돌다 오류를 만났다');
      return done('ERROR');
    }
  }

  /** 세션 하나를 점검한다. 던지는 것은 좌석 Redis 장애와 버그(회차 하나를 UNAVAILABLE·ERROR로 만든다)뿐이다 */
  async #check(eventId: string, jti: string, report: SessionSweepEventReport): Promise<void> {
    const { store, index, ending } = this.deps;
    let r;
    try {
      r = await store.sweep(jti);
    } catch (err) {
      // 모양이 틀린 멤버(키 조각이 아님)는 영영 점검할 수 없어 색인에서 뺀다
      if (err instanceof RangeError) {
        await index.drop(eventId, jti);
        report.gone += 1;
        return;
      }
      if (err instanceof SeatStoreUnavailable) throw err;
      // 일시 장애가 아닌 오류(망가진 세션 상태 등)는 이 멤버만 뒤로 미루고 나머지를 계속 점검한다: 던지면 같은 멤버가 매 틱 맨 앞에 와서 회차 전체를 막는다
      this.deps.logger?.error({ eventId, step: 'check', ...this.#codeOf(err) }, '구매 세션 점검이 오류를 만나 이 세션을 뒤로 미룬다');
      await index.requeue(eventId, jti, this.deps.clock.now() + SESSION_SWEEP_POISON_RETRY_MS);
      return;
    }
    report.checked += 1;
    switch (r.kind) {
      case 'GONE':
        await index.drop(eventId, jti);
        report.gone += 1;
        return;
      case 'LIVE':
        await index.requeue(eventId, jti, r.nextCheckMs);
        return;
      case 'ENDED':
        // 세션 상태는 이미 지워졌다. 사건을 더하는 Lua가 색인에서도 뺀다(더하기가 실패하면 다음 틱의 점검이 GONE으로 뺀다)
        await ending.recordEnded({ eventId: r.eventId, sessionId: jti, reason: r.reason, endedAtMs: r.endedAtMs, accountId: r.accountId, holds: r.holds });
        report.ended += 1;
        return;
    }
  }

  /** 로그에 남기는 오류 갈래: code·키 종류만(계정 ID·구매 세션 ID가 든 키 이름·오류 글은 싣지 않는다, ASVS 16.2.5) */
  #codeOf(err: unknown): { code: string; keyKind?: string } {
    const info = seatLuaErrorOf(err);
    return info ? { code: info.code, ...(info.keyKind ? { keyKind: info.keyKind } : {}) } : { code: 'OTHER' };
  }
}
