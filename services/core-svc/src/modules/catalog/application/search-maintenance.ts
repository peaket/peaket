// 유스케이스: 검색 읽기 모델을 고치는 트랜잭션과 커밋 뒤 일, 정리 주기(ADR-0271 결정 2·3·6·7·8, docs/features/search.md §2.2·§2.3·§10).
// - withSearchSync: 카탈로그를 고친 트랜잭션 안에서 동기화를 부르고, 커밋 뒤 빠진 공연이 있으면 `/v1/search*`를 무효화하고 `search_removed` 줄을 남긴다.
// - SearchReadModelTimers: 1분 [가정] 정리(오픈·판매 종료 시각이 지난 공연 다시 동기화, 하루 지난 지운 표시 지우기), 1시간 [가정] 관심도, 10초 [가정] 사전 갱신.
import { type Clock, type Database, type DbTransaction, Gauge, type PlatformLogger, type Registry } from '@peaket/platform';
import type { CdnInvalidation } from '../domain/media-ports.js';
import type { SearchReadModelSync, SuggestionDictionary } from '../domain/search.js';

/** 검색에서 빠지면 비우는 CDN 경로(search.md:57) */
export const SEARCH_CDN_PATHS = ['/v1/search*'] as const;

/**
 * work가 카탈로그를 고치고 바뀐 공연 ID를 돌려주면, 같은 트랜잭션에서 sync.sync를 부른다.
 * 커밋 뒤 빠진 공연이 있으면 검색 경로 무효화를 한 번 부르고 빠진 공연마다 `search_removed` 줄(공연 ID·이유·판·무효화 요청 ID)을 남긴다.
 * 무효화가 실패하면 `cdn_invalidation_failed` 경고 줄을 남기고(요청 ID는 null) 처리는 성공이다. 트랜잭션이 되돌려지면 아무것도 하지 않는다.
 */
export async function withSearchSync<T>(
  o: { database: Pick<Database, 'transaction'>; sync: SearchReadModelSync; cdn: CdnInvalidation; logger: Pick<PlatformLogger, 'info' | 'warn'>; reason: string; at: Date },
  work: (tx: DbTransaction) => Promise<{ result: T; productionIds: readonly string[] }>,
): Promise<T> {
  let synced: { version: number; removed: string[] } | undefined;
  const result = await o.database.transaction(async (tx) => {
    const done = await work(tx);
    synced = await o.sync.sync(tx, done.productionIds, o.at);
    return done.result;
  });
  if (!synced || synced.removed.length === 0) return result;
  let invalidationRequestId: string | null = null;
  try {
    invalidationRequestId = (await o.cdn.invalidatePaths([...SEARCH_CDN_PATHS])).requestId;
  } catch (e) {
    safe(() => o.logger.warn({ event: 'cdn_invalidation_failed', paths: [...SEARCH_CDN_PATHS], err: e instanceof Error ? e.name : 'unknown' }, '검색 경로 CDN 무효화에 실패했다(캐시 수명이 지나면 빠진다)'));
  }
  for (const productionId of synced.removed) {
    safe(() => o.logger.info({ event: 'search_removed', productionId, reason: o.reason, searchVersion: synced!.version, invalidationRequestId }, '검색에서 공연이 빠졌다'));
  }
  return result;
}

const safe = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // 기록 실패는 처리를 바꾸지 않는다
  }
};

/** 정리 주기 값(docs/features/search.md §2.2·§2.3) */
export const SEARCH_TIMED_SYNC_MS = 60_000;
export const SEARCH_INTEREST_MS = 3_600_000;
export const SEARCH_DICTIONARY_REFRESH_MS = 10_000;

type Log = Pick<PlatformLogger, 'info' | 'warn'>;

/**
 * 검색 읽기 모델의 주기 일. 서비스 프로세스(main.ts)가 띄운다.
 * 정리·관심도는 쓰기 연결(sync)로, 사전 갱신은 읽기 연결의 사전으로 한다. 여러 파드가 함께 돌려도 동기화는 같은 값을 쓰므로 결과가 같다.
 */
export class SearchReadModelTimers {
  #timers: ReturnType<typeof setInterval>[] = [];
  #since: Date;
  #busy = new Set<string>();
  #drift = 0;
  /** 이 파드가 뜬 시각(따라잡기를 처음 시도한 때). 그 뒤에 끝까지 마친 따라잡기가 있어야 따라잡기를 마친 것으로 본다 */
  #startedAt: Date | undefined;
  /** 이 파드가 따라잡기를 마쳤거나 다른 파드가 마친 것을 보았다(start 전에는 할 일이 없다) */
  #reconciled = true;

  constructor(
    private readonly o: {
      sync: SearchReadModelSync;
      dictionary?: Pick<SuggestionDictionary, 'refresh' | 'entries' | 'readAt'>;
      /** 원천의 이름 줄 수(사전 어긋남 게이지). 없으면 게이지는 0 */
      termCount?: () => Promise<number>;
      clock: Clock;
      logger?: Log;
    },
  ) {
    this.#since = new Date(o.clock.now());
  }

  /**
   * 게이지(docs/features/search.md §10): search_dictionary_version_lag_seconds(마지막으로 원천을 읽은 뒤 지난 초),
   * search_dictionary_entries(사전 이름 항목 수), search_dictionary_drift_entries(원천 이름 줄 수와 사전 항목 수의 차, 1분 정리 때 센다)
   */
  register(registry: Registry): this {
    const d = this.o.dictionary;
    const clock = this.o.clock;
    const lag = new Gauge({
      name: 'search_dictionary_version_lag_seconds',
      help: '자동완성 사전이 마지막으로 원천을 읽은 뒤 지난 초',
      registers: [],
      collect() {
        const at = d?.readAt;
        this.set(at === undefined ? -1 : Math.max(0, (clock.now() - at) / 1000));
      },
    });
    const entries = new Gauge({
      name: 'search_dictionary_entries',
      help: '자동완성 사전의 이름 항목 수',
      registers: [],
      collect() {
        this.set(d?.entries ?? 0);
      },
    });
    const driftOf = () => this.#drift;
    const drift = new Gauge({
      name: 'search_dictionary_drift_entries',
      help: '원천 search_term 줄 수와 사전 항목 수의 차(1분 정리 때 센다)',
      registers: [],
      collect() {
        this.set(driftOf());
      },
    });
    for (const m of [lag, entries, drift]) registry.registerMetric(m);
    return this;
  }

  /** 1분 정리 한 번: 지난 정리 뒤 오픈·판매 종료 시각이 지난 공연을 다시 동기화하고, 하루 지난 지운 표시를 지운다 */
  async tidy(): Promise<{ version: number | null; productions: number; purged: number }> {
    const at = new Date(this.o.clock.now());
    // 시작 따라잡기를 마치지 못했으면(실패, 다른 파드가 쥐고 있었음) 정리 앞에 다시 본다(ADR-0271 결정 12 보탬, 리뷰 R165-14)
    if (!this.#reconciled) await this.#catchUp(at);
    const timed = await this.o.sync.syncTimed(at, this.#since);
    const purged = await this.o.sync.purgeRemovals(at);
    // 정리가 다 성공했을 때만 창을 앞으로 옮긴다. 실패하거나 잠금을 못 잡아 건너뛰었으면 다음 정리가 같은 창부터 다시 본다(ADR-0271 결정 12, 리뷰 R165-23)
    if (!timed.skipped) this.#since = at;
    if (this.o.termCount && this.o.dictionary) this.#drift = Math.abs((await this.o.termCount()) - this.o.dictionary.entries);
    return { ...timed, purged };
  }

  async recount(): Promise<number> {
    return this.o.sync.recountInterest(new Date(this.o.clock.now()));
  }

  /**
   * 시작(ADR-0271 결정 12·14): 시작 따라잡기(reconcileAll)를 먼저 하고, 자동완성 사전을 처음 읽은 뒤 주기 일을 건다.
   * 1분 정리의 시각 창은 따라잡기를 시작한 시각에서 잇는다. 따라잡기·첫 읽기가 실패해도 주기 일은 건다(사전은 10초 뒤 다시 읽는다)
   */
  async start(): Promise<void> {
    const at = new Date(this.o.clock.now());
    this.#since = at;
    this.#startedAt = at;
    this.#reconciled = false;
    await this.#reconcile(at);
    if (this.o.dictionary) {
      try {
        await this.o.dictionary.refresh();
      } catch (e) {
        safe(() => this.o.logger?.warn({ event: 'search_dictionary_refresh_failed', err: e instanceof Error ? e.name : 'unknown' }, '자동완성 사전을 처음 읽지 못했다(10초 뒤 다시 읽는다)'));
      }
    }
    this.#arm();
  }

  /** 따라잡기를 한 번 부른다. 끝까지 마쳤으면 기억한다. 실패는 기록만 한다(다음 정리 주기에 다시 한다) */
  async #reconcile(at: Date): Promise<void> {
    try {
      const r = await this.o.sync.reconcileAll(at);
      if (r.ran) this.#reconciled = true;
      safe(() => this.o.logger?.info({ event: 'search_reconciled', ran: r.ran, productions: r.productions, chunks: r.chunks, searchVersion: r.version }, '검색 읽기 모델 따라잡기'));
    } catch (e) {
      safe(() => this.o.logger?.warn({ event: 'search_maintenance_failed', task: 'search-reconcile', err: e instanceof Error ? e.name : 'unknown' }, '검색 읽기 모델 따라잡기가 실패했다(다음 정리 주기에 다시 한다)'));
    }
  }

  /** 다른 파드가 이 파드가 뜬 뒤에 따라잡기를 마쳤으면(같은 시각 포함) 그것으로 친다. 아니면 다시 한다 */
  async #catchUp(at: Date): Promise<void> {
    try {
      const last = await this.o.sync.lastReconciledAt();
      if (last && this.#startedAt && last.getTime() >= this.#startedAt.getTime()) {
        this.#reconciled = true;
        return;
      }
    } catch (e) {
      safe(() => this.o.logger?.warn({ event: 'search_maintenance_failed', task: 'search-reconcile-check', err: e instanceof Error ? e.name : 'unknown' }, '따라잡기를 마쳤는지 보지 못했다'));
    }
    await this.#reconcile(at);
  }

  #arm(): void {
    this.stop();
    const every = (name: string, ms: number, fn: () => Promise<unknown>) => {
      const t = setInterval(() => {
        if (this.#busy.has(name)) return;
        this.#busy.add(name);
        fn()
          .catch((e: unknown) => safe(() => this.o.logger?.warn({ event: 'search_maintenance_failed', task: name, err: e instanceof Error ? e.name : 'unknown' }, '검색 읽기 모델 주기 일이 실패했다(다음 주기에 다시 한다)')))
          .finally(() => this.#busy.delete(name));
      }, ms);
      t.unref?.();
      this.#timers.push(t);
    };
    every('search-timed-sync', SEARCH_TIMED_SYNC_MS, () => this.tidy());
    every('search-interest', SEARCH_INTEREST_MS, () => this.recount());
    const dictionary = this.o.dictionary;
    if (dictionary) every('search-dictionary', SEARCH_DICTIONARY_REFRESH_MS, () => dictionary.refresh());
  }

  stop(): void {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
  }
}
