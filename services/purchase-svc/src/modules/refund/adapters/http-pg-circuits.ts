// payment-svc 내부 `GET /internal/v1/circuits`를 읽는 어댑터(BAT-425 GAT-120, transfer-refund §5 '스스로 멈춤' 3, docs/api/guidelines.md §8.1).
// 일괄 환불 실행기는 이 포트를 동기로 본다. 그래서 값은 뒤에서(비동기로) 주기적으로 새로 읽고, `circuitOpen`은 마지막으로 읽은 값을 준다.
// 10초 [가정] 캐시이고, `open`만 참(열림)이다. 읽기 실패·시간 초과는 모든 몫을 거짓으로 두고 경고 로그만 남긴다(환급을 읽기 장애로 세우지 않는다).
// 자동 재개는 없다(transfer-refund §5 '재개'). 이 어댑터는 상태만 읽고 멈춤 목록을 쓰지 않는다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { PgCircuits } from '../domain/ports.js';

/** 서킷 상태 읽기의 캐시 10초 [가정](R-T45 ②, ADR-0316·plan §6) */
export const PG_CIRCUIT_CACHE_MS = 10_000;
/** 한 번의 읽기 한도 3초 [가정](docs/api/guidelines.md §8.1 내부 HTTP 읽기 행) */
const READ_TIMEOUT_MS = 3_000;
const PGS = ['TOSS', 'PORTONE', 'SIMULATOR'] as const;

type CircuitPg = (typeof PGS)[number];

const isPg = (v: unknown): v is CircuitPg => typeof v === 'string' && (PGS as readonly string[]).includes(v);

export interface HttpPgCircuitsOptions {
  /** payment-svc 내부 HTTP(PEAKET_PAYMENT_HTTP_URL). baseUrl은 서비스 뿌리 주소다 */
  readonly client: Pick<ExternalHttpClient, 'request'>;
  readonly internalToken?: string;
  readonly nowMs?: () => number;
  readonly ttlMs?: number;
  readonly log?: { warn(o: object, msg: string): void };
}

export class HttpPgCircuits implements PgCircuits {
  readonly #client: Pick<ExternalHttpClient, 'request'>;
  readonly #internalToken?: string;
  readonly #nowMs: () => number;
  readonly #ttlMs: number;
  readonly #log?: { warn(o: object, msg: string): void };
  /** 마지막으로 성공한 읽기의 `open`인 결제사. 실패하면 비운다(=모든 몫이 거짓) */
  #open = new Set<CircuitPg>();
  /** 마지막 읽기 시도 시각. 실패해도 갱신해 틱마다 같은 실패를 되풀이하지 않는다 */
  #lastAttemptMs = Number.NEGATIVE_INFINITY;
  #refreshing: Promise<void> | undefined;

  constructor(o: HttpPgCircuitsOptions) {
    this.#client = o.client;
    this.#internalToken = o.internalToken;
    this.#nowMs = o.nowMs ?? (() => Date.now());
    this.#ttlMs = o.ttlMs ?? PG_CIRCUIT_CACHE_MS;
    this.#log = o.log;
  }

  /** 동기 판정. 캐시가 오래됐으면 다음 읽기를 뒤에서 시작하고 지금 값(없으면 거짓)을 준다 */
  circuitOpen(pg: 'TOSS' | 'PORTONE' | 'SIMULATOR'): boolean {
    if (this.#nowMs() - this.#lastAttemptMs >= this.#ttlMs) void this.refresh();
    return this.#open.has(pg);
  }

  /** 지금 읽는다(시작 조립·시험). 실패해도 던지지 않는다 */
  async refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    this.#lastAttemptMs = this.#nowMs();
    this.#refreshing = (async () => {
      try {
        const res = await this.#client.request({
          method: 'GET',
          path: '/internal/v1/circuits',
          headers: this.#internalToken ? { 'x-peaket-internal-token': this.#internalToken } : {},
          timeoutCapMs: READ_TIMEOUT_MS,
        });
        if (res.status < 200 || res.status > 299) throw new Error(`circuits ${res.status}`);
        const body = (await res.json()) as { items?: readonly { pg?: unknown; state?: unknown }[] };
        const items = Array.isArray(body.items) ? body.items : [];
        const open = new Set<CircuitPg>();
        for (const i of items) if (isPg(i.pg) && i.state === 'open') open.add(i.pg);
        this.#open = open;
      } catch (err) {
        // 읽기 장애로 환급을 멈추지 않는다: 모든 몫을 거짓으로 두고 경고만 남긴다
        this.#open = new Set();
        this.#log?.warn({ dep: 'payment-svc', event: 'event-refund-pg-circuits-read-failed', err: err instanceof Error ? err.name : 'unknown' }, '결제사 서킷 상태를 읽지 못해 모든 몫을 닫힌 것으로 본다(환급은 계속한다)');
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }
}
