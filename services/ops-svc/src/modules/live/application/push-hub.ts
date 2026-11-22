// 파드 하나의 알림 표 읽기(ADR-0100 결정 4, ADR-0360 결정 1). 연결이 하나라도 있으면 0.5초 [가정]마다 마지막으로 읽은 seq 뒤를 읽어 모든 연결에 나눠 준다.
// 순번은 커밋 차례와 다를 수 있다(먼저 번호를 받은 트랜잭션이 늦게 커밋). 그래서 빈 번호를 만나면 거기서 멈추고 2초 [가정] 기다린 뒤에도 비면 건너뛴다
// (되돌린 트랜잭션의 번호는 영영 비기 때문이다). 연결마다 다시 붙기(Last-Event-ID 뒤 다시 보내기)는 이 허브가 '정한 번호'(settled)까지를 표에서 직접 읽는다.
import { OPS_LIVE_GAP_WAIT_MS, OPS_LIVE_POLL_MS, OPS_LIVE_READ_LIMIT, type PushEventRow } from '../domain/live.js';
import type { PushEventSource } from '../domain/ports.js';
import type { OpsLiveFeed, PushDelivery } from './ops-live-feed.js';

export type PushListener = (batch: readonly PushDelivery[]) => void;

export interface PushHubOptions {
  readonly pollMs?: number;
  readonly gapWaitMs?: number;
  readonly now?: () => number;
}

/**
 * 빈 번호 판정. cursor 뒤로 이어진 행만 내고, 빈 번호가 gapWaitMs 넘게 이어지면 그 번호를 건너뛴다.
 * @returns ready: 낼 행, cursor: 새 커서, gapSince: 지금 기다리는 빈 번호를 처음 본 시각(없으면 undefined)
 */
export function settleRows(rows: readonly PushEventRow[], cursor: number, gapSince: number | undefined, nowMs: number, gapWaitMs: number): { ready: PushEventRow[]; cursor: number; gapSince: number | undefined } {
  const ready: PushEventRow[] = [];
  let at = cursor;
  let since = gapSince;
  for (const r of rows) {
    if (r.seq <= at) continue;
    if (r.seq !== at + 1) {
      // 빈 번호: 처음 보면 시각을 적고 기다린다. 오래 비었으면 건너뛴다
      since ??= nowMs;
      if (nowMs - since < gapWaitMs) break;
    }
    ready.push(r);
    at = r.seq;
    since = undefined;
  }
  return { ready, cursor: at, gapSince: since };
}

export class PushHub {
  readonly #listeners = new Set<PushListener>();
  #timer: NodeJS.Timeout | undefined;
  #settled: number | undefined;
  #gapSince: number | undefined;
  #polling = false;
  #ready: Promise<void> | undefined;

  constructor(
    private readonly source: PushEventSource,
    private readonly feed: OpsLiveFeed,
    private readonly options: PushHubOptions = {},
  ) {}

  /** 지금 정한 번호(이 번호까지는 다시 읽어도 빈 번호가 없다고 본다) */
  get settled(): number {
    return this.#settled ?? 0;
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** 처음 커서를 시퀀스 마지막 값으로 잡는다(한 번만) */
  ready(): Promise<void> {
    this.#ready ??= this.source.latest().then(
      (v) => {
        this.#settled ??= v;
      },
      (err: unknown) => {
        this.#ready = undefined;
        throw err;
      },
    );
    return this.#ready;
  }

  /** 행 묶음을 받는다. 첫 구독이면 읽기를 켠다. 돌려준 함수로 끊는다 */
  subscribe(listener: PushListener): () => void {
    this.#listeners.add(listener);
    if (!this.#timer) {
      this.#timer = setInterval(() => void this.poll(), this.options.pollMs ?? OPS_LIVE_POLL_MS);
      this.#timer.unref();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.stop();
    };
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 한 번 읽는다(겹치지 않게). 읽기 실패는 다음 주기에 다시 한다 */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      await this.ready();
      for (;;) {
        const rows = await this.source.after(this.settled, OPS_LIVE_READ_LIMIT);
        const now = (this.options.now ?? Date.now)();
        const s = settleRows(rows, this.settled, this.#gapSince, now, this.options.gapWaitMs ?? OPS_LIVE_GAP_WAIT_MS);
        this.#settled = s.cursor;
        this.#gapSince = s.gapSince;
        if (s.ready.length > 0) {
          const batch = await this.feed.resolve(s.ready);
          for (const l of [...this.#listeners]) l(batch);
        }
        if (rows.length < OPS_LIVE_READ_LIMIT || s.ready.length === 0) break;
      }
    } catch {
      // 다음 주기에 다시 읽는다(흐름은 닫지 않는다)
    } finally {
      this.#polling = false;
    }
  }

  /** 다시 붙는 연결의 몫: cursor 뒤부터 upTo까지 표에서 읽는다(빈 번호는 기다리지 않는다, 허브가 이미 정한 범위다) */
  async replay(cursor: number, upTo: number): Promise<PushDelivery[]> {
    const out: PushDelivery[] = [];
    let at = cursor;
    while (at < upTo) {
      const rows = (await this.source.after(at, OPS_LIVE_READ_LIMIT)).filter((r) => r.seq <= upTo);
      if (rows.length === 0) break;
      out.push(...(await this.feed.resolve(rows)));
      at = rows[rows.length - 1]!.seq;
      if (rows.length < OPS_LIVE_READ_LIMIT) break;
    }
    return out;
  }
}
