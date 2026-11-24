// 계정 연결 값 묶음(docs/streaming.md §6.4 '계정의 연결 값', ADR-0171 결정 4, LCH-240, F-04-10).
// identity-svc BatchGetInvestigationRefs를 500개 [가정]씩 부르고, 파드 메모리에 10분 [가정] 캐시한다.
// 답하지 않으면 그 묶음만 1분 [가정] 뒤에 다시 묻고, 사건 적재는 멈추지 않는다. 값은 inv_link에만 싣는다(분석 저장소로 보내지 않는다).
export interface InvestigationRefs {
  accountId: string;
  contactRefs: string[];
  deviceRefs: string[];
  identityConflicts: { otherAccountId: string; attemptedAt: number }[];
}

export interface AccountRefSource {
  get(accountIds: readonly string[]): Promise<InvestigationRefs[]>;
}

export interface BatchRefOptions {
  batchSize?: number;
  cacheTtlMs?: number;
  retryMs?: number;
  clock?: () => number;
}

/** 한 번에 묻는 계정 수 [가정](proto: 500개를 넘으면 INVALID_ARGUMENT) */
export const REF_BATCH = 500;
/** 캐시 수명 [가정] */
export const REF_CACHE_MS = 10 * 60_000;
/** 실패한 묶음을 다시 묻는 간격 [가정] */
export const REF_RETRY_MS = 60_000;

export class BatchRefResolver {
  readonly #source: AccountRefSource;
  readonly #batchSize: number;
  readonly #ttl: number;
  readonly #retry: number;
  readonly #clock: () => number;
  readonly #cache = new Map<string, { refs: InvestigationRefs; at: number }>();
  readonly #retryAt = new Map<string, number>();

  constructor(source: AccountRefSource, o: BatchRefOptions = {}) {
    this.#source = source;
    this.#batchSize = o.batchSize ?? REF_BATCH;
    this.#ttl = o.cacheTtlMs ?? REF_CACHE_MS;
    this.#retry = o.retryMs ?? REF_RETRY_MS;
    this.#clock = o.clock ?? Date.now;
  }

  async resolve(accountIds: readonly string[]): Promise<Map<string, InvestigationRefs>> {
    const now = this.#clock();
    const out = new Map<string, InvestigationRefs>();
    const missing: string[] = [];
    for (const id of new Set(accountIds)) {
      if (!id) continue;
      const hit = this.#cache.get(id);
      if (hit && now - hit.at < this.#ttl) {
        out.set(id, hit.refs);
        continue;
      }
      const retry = this.#retryAt.get(id);
      if (retry !== undefined && retry > now) continue;
      missing.push(id);
    }
    for (let i = 0; i < missing.length; i += this.#batchSize) {
      const batch = missing.slice(i, i + this.#batchSize);
      try {
        const items = await this.#source.get(batch);
        const at = this.#clock();
        for (const refs of items) {
          this.#cache.set(refs.accountId, { refs, at });
          this.#retryAt.delete(refs.accountId);
          if (batch.includes(refs.accountId)) out.set(refs.accountId, refs);
        }
        for (const id of batch) this.#retryAt.delete(id);
      } catch {
        const at = this.#clock() + this.#retry;
        for (const id of batch) this.#retryAt.set(id, at);
      }
    }
    return out;
  }
}
