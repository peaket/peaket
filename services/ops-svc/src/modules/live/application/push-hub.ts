// 파드 하나의 알림 표 읽기(ADR-0100 결정 4, ADR-0360 결정 1·2). 연결이 하나라도 있으면 0.5초 [가정]마다 마지막으로 읽은 seq 뒤를 읽어 모든 연결에 나눠 준다.
// 순번은 커밋 차례와 다를 수 있다(먼저 번호를 받은 트랜잭션이 늦게 커밋). 그래서 빈 번호를 만나면 거기서 멈추고 2초 [가정] 기다린 뒤에도 비면 건너뛴다
// (되돌린 트랜잭션의 번호는 영영 비기 때문이다). 건너뛴 번호는 1시간 [가정] 동안 읽을 때마다 같은 문장으로 다시 보고, 나타나면 늦게라도 보낸다(늦은 행).
// 연결이 0이 되어 멈추면 정한 번호를 버리고, 다음 연결이 '지금 순번'(커밋된 마지막 번호, 시퀀스 값 아님)부터 다시 잡는다(F-03-1 RV-01·RV-02).
// 다시 붙기(Last-Event-ID 뒤 다시 보내기)는 이 허브가 '정한 번호'(settled)까지를 표에서 직접 읽고, 늦은 행을 받았는지 모르는 커서는 그 행 앞으로 당긴다(rewind).
import type { PlatformLogger } from '@peaket/platform';
import { OPS_LIVE_GAP_WAIT_MS, OPS_LIVE_LATE_WATCH_MAX, OPS_LIVE_LATE_WATCH_MS, OPS_LIVE_POLL_MS, OPS_LIVE_READ_LIMIT, OPS_LIVE_START_LOOKBACK, type PushEventRow } from '../domain/live.js';
import type { PushEventSource } from '../domain/ports.js';
import type { OpsLiveFeed, PushDelivery } from './ops-live-feed.js';

/** 허브가 나눠 주는 행. late는 건너뛴 뒤 늦게 커밋되어 정한 번호 아래에서 나타난 행이다 */
export type HubDelivery = PushDelivery & { readonly late?: true };
export type PushListener = (batch: readonly HubDelivery[]) => void;

export interface PushHubOptions {
  readonly pollMs?: number;
  readonly gapWaitMs?: number;
  /** 건너뛴 번호를 다시 보는 시간(기본 1시간 [가정]) */
  readonly lateWatchMs?: number;
  readonly now?: () => number;
  /** 빈 번호를 건너뛸 때 정규 로그(ops-live-gap-skipped)를 남길 곳 */
  readonly logger?: Pick<PlatformLogger, 'warn'>;
}

/**
 * 빈 번호 판정. cursor 뒤로 이어진 행만 내고, 빈 번호가 gapWaitMs 넘게 이어지면 그 번호를 건너뛴다.
 * 빈 번호를 처음 본 시각은 '지금'과 빈 번호 뒤 행이 쓰인 시각 가운데 이른 쪽이다(읽지 않던 동안 생긴 빈 번호도 기다린 것으로 센다).
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
      since ??= Math.min(nowMs, r.createdAtMs);
      if (nowMs - since < gapWaitMs) break;
    }
    ready.push(r);
    at = r.seq;
    since = undefined;
  }
  return { ready, cursor: at, gapSince: since };
}

/** 늦게 나타난 행 하나: 그때 정한 번호(head) 이상 커서로 다시 붙는 연결은 그 행을 받았는지 모른다 */
interface LateRow {
  readonly seq: number;
  readonly head: number;
  readonly atMs: number;
}

export class PushHub {
  readonly #listeners = new Set<PushListener>();
  #timer: NodeJS.Timeout | undefined;
  #settled: number | undefined;
  #gapSince: number | undefined;
  #polling = false;
  #ready: Promise<void> | undefined;
  /** 멈출 때마다 올린다(멈추기 전에 시작한 읽기가 새 상태를 덮지 않게) */
  #epoch = 0;
  /** 건너뛴 번호 → 건너뛴 시각. 멈춰도 지우지 않는다(다시 시작할 때 그 사이 늦은 커밋을 가린다) */
  readonly #watch = new Map<number, number>();
  /** 늦게 나타난 행(다시 붙기 rewind용). 멈춰도 지우지 않는다 */
  #late: LateRow[] = [];

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

  #now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** 처음(멈춘 뒤면 다시) 커서를 커밋된 마지막 번호로 잡는다 */
  ready(): Promise<void> {
    const epoch = this.#epoch;
    this.#ready ??= this.#start().then(
      (head) => {
        if (epoch === this.#epoch) this.#settled ??= head;
      },
      (err: unknown) => {
        if (epoch === this.#epoch) this.#ready = undefined;
        throw err;
      },
    );
    return this.#ready;
  }

  /**
   * 지금 순번: 시퀀스 마지막 값(커밋 전 번호 포함)에서 OPS_LIVE_START_LOOKBACK만큼 거슬러 읽어 보이는 가장 큰 번호(하나도 없으면 시퀀스 값).
   * 그 아래 안 보이는 번호(진행 중일 수 있다)는 다시 보기에 올리고, 다시 보던 번호가 이미 보이면 늦은 행 기록으로만 옮긴다(새 연결에는 지난 사건이다).
   */
  async #start(): Promise<number> {
    const latest = await this.source.latest();
    if (latest <= 0) return 0;
    const from = Math.max(0, latest - OPS_LIVE_START_LOOKBACK);
    const rows = await this.#read(from, OPS_LIVE_START_LOOKBACK + OPS_LIVE_READ_LIMIT);
    const fresh = rows.filter((r) => r.seq > from);
    const head = fresh.length > 0 ? fresh[fresh.length - 1]!.seq : latest;
    const now = this.#now();
    for (const r of rows) {
      if (r.seq > from || !this.#watch.has(r.seq)) continue;
      this.#watch.delete(r.seq);
      this.#late.push({ seq: r.seq, head, atMs: now });
    }
    const seen = new Set(fresh.map((r) => r.seq));
    for (let s = from + 1; s <= head; s += 1) {
      if (seen.has(s)) {
        if (this.#watch.delete(s)) this.#late.push({ seq: s, head, atMs: now });
      } else if (!this.#watch.has(s)) this.#watch.set(s, now);
    }
    this.#trim(now);
    return head;
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

  /** 읽기를 멈추고 정한 번호를 버린다(다음 연결은 그때의 지금 순번부터) */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#epoch += 1;
    this.#settled = undefined;
    this.#gapSince = undefined;
    this.#ready = undefined;
  }

  /** from 뒤 행 + 다시 보는 번호(from 이하)의 행. 한 스냅숏이라 늦은 행이 그보다 뒤에 커밋된 같은 대상의 행보다 먼저 온다 */
  async #read(from: number, limit: number): Promise<readonly PushEventRow[]> {
    const extra = [...this.#watch.keys()].filter((s) => s <= from);
    if (extra.length === 0) return this.source.after(from, limit);
    if (this.source.afterOrAt) return this.source.afterOrAt(from, extra, limit);
    const lo = Math.min(...extra) - 1;
    const at = new Set(extra);
    const rows = await this.source.after(lo, limit + (from - lo));
    return rows.filter((r) => r.seq > from || at.has(r.seq)).slice(0, limit);
  }

  /** 오래된 다시 보기·늦은 행 기록을 버린다 */
  #trim(now: number): void {
    const keepMs = this.options.lateWatchMs ?? OPS_LIVE_LATE_WATCH_MS;
    for (const [s, at] of this.#watch) if (now - at >= keepMs) this.#watch.delete(s);
    if (this.#watch.size > OPS_LIVE_LATE_WATCH_MAX) {
      const drop = [...this.#watch.keys()].sort((a, b) => a - b).slice(0, this.#watch.size - OPS_LIVE_LATE_WATCH_MAX);
      for (const s of drop) this.#watch.delete(s);
      this.options.logger?.warn({ event: 'ops-live-gap-watch-dropped', count: drop.length, upTo: drop[drop.length - 1] }, '다시 보던 빈 번호가 상한을 넘어 오래된 것을 버렸다');
    }
    this.#late = this.#late.filter((l) => now - l.atMs < keepMs).slice(-OPS_LIVE_LATE_WATCH_MAX);
  }

  /** 한 번 읽는다(겹치지 않게). 읽기 실패는 다음 주기에 다시 한다 */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    const epoch = this.#epoch;
    try {
      await this.ready();
      for (;;) {
        if (epoch !== this.#epoch || this.#settled === undefined) return;
        const before = this.#settled;
        const rows = await this.#read(before, OPS_LIVE_READ_LIMIT);
        if (epoch !== this.#epoch) return;
        const now = this.#now();
        this.#trim(now);
        const late = rows.filter((r) => r.seq <= before && this.#watch.has(r.seq));
        const s = settleRows(
          rows.filter((r) => r.seq > before),
          before,
          this.#gapSince,
          now,
          this.options.gapWaitMs ?? OPS_LIVE_GAP_WAIT_MS,
        );
        // 건너뛴 번호는 다시 보기에 올리고 로그 한 줄을 남긴다(늦게 커밋되면 늦은 행으로 보낸다)
        const sent = new Set(s.ready.map((r) => r.seq));
        const skipped: number[] = [];
        for (let q = before + 1; q < s.cursor; q += 1) if (!sent.has(q)) skipped.push(q);
        for (const q of skipped) this.#watch.set(q, now);
        if (skipped.length > 0) {
          this.options.logger?.warn({ event: 'ops-live-gap-skipped', seqs: skipped.slice(0, 20), count: skipped.length }, '알림 표의 빈 번호를 기다린 뒤 건너뛰었다(늦게 커밋되면 늦게 보낸다)');
        }
        for (const r of late) {
          this.#watch.delete(r.seq);
          this.#late.push({ seq: r.seq, head: before, atMs: now });
        }
        this.#settled = s.cursor;
        this.#gapSince = s.gapSince;
        this.#trim(now);
        const out = [...late, ...s.ready];
        if (out.length > 0) {
          const lateSeqs = new Set(late.map((r) => r.seq));
          const batch: HubDelivery[] = (await this.feed.resolve(out)).map((d) => (lateSeqs.has(d.row.seq) ? { ...d, late: true as const } : d));
          if (epoch !== this.#epoch) return;
          for (const l of [...this.#listeners]) l(batch);
        }
        if (rows.length < OPS_LIVE_READ_LIMIT || out.length === 0) break;
      }
    } catch {
      // 다음 주기에 다시 읽는다(흐름은 닫지 않는다)
    } finally {
      this.#polling = false;
    }
  }

  /**
   * 다시 붙는 커서를 늦은 행 몫만큼 당긴다. 이 파드가 늦게 낸 행 가운데 그때 정한 번호가 cursor 이상인 것은
   * 그 연결이 끊기기 전에 받았는지 모르므로 그 행 바로 앞부터 다시 보낸다(같은 대상의 뒤 행도 차례대로 다시 가 상태가 뒤로 가지 않는다).
   */
  rewind(cursor: number): number {
    let at = cursor;
    for (const l of this.#late) if (l.seq <= cursor && l.head >= cursor) at = Math.min(at, l.seq - 1);
    return at;
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
