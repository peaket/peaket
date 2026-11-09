// 정지 판정자의 입력을 클러스터 Prometheus에서 읽는다(docs/features/payment.md §2 '정지 판정자의 첫 구현', ADR-0105 결정 5·8, BUILD_ORDER PRF-202). admission-ctrl의 prometheus-control-inputs.ts와 같은 꼴이다(공통화는 범위 밖).
// 표본 시각은 묶기 전에 timestamp()를 건다(묶은 뒤에 걸면 평가 시각이 된다). 실패와 빈 결과를 0으로 읽지 않는다(ADR-0069 결정 1).
// 준비된 파드는 kube_pod_status_ready로 고른다. p99는 재시도 큐 건을 뺀 path="direct"만 본다(ADR-0105 결정 5).
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import type { ClusterPauseReading } from '../domain/entry-pause-judge.js';
import type { PgName } from '../domain/payment-gateway.js';
import type { EntryPauseClusterInputs } from '../domain/ports.js';

/** 응답 크기 상한 256KiB [가정](값이 하나뿐인 쿼리들이다) */
const MAX_BODY_BYTES = 256 * 1024;
/** 조회 마감 800ms [가정](1초 틱 안에서 끝낸다) */
const DEFAULT_TIMEOUT_MS = 800;
const READY_PODS = 'kube_pod_status_ready{condition="true"} == 1';

const circuit = (pg: PgName): string => `payment_pg_circuit_open{pg="${pg}"}`;
const openQuery = (pg: PgName): string => `sum(${circuit(pg)} and on (namespace, pod) (${READY_PODS}))`;
const readyQuery = (pg: PgName): string => `count(${circuit(pg)} and on (namespace, pod) (${READY_PODS}))`;
const timeQuery = (pg: PgName): string => `max(timestamp(${circuit(pg)}))`;
const p99Query = (pg: PgName, windowMs: number): string => `histogram_quantile(0.99, sum by (le) (rate(payment_confirm_resolution_seconds_bucket{pg="${pg}",path="direct"}[${Math.floor(windowMs / 1000)}s])))`;
const samplesQuery = (pg: PgName, windowMs: number): string => `sum(increase(payment_confirm_resolution_seconds_count{pg="${pg}",path="direct"}[${Math.floor(windowMs / 1000)}s]))`;

type Series = { value: [number, unknown] };

export interface PrometheusEntryPauseInputsOptions {
  /** http(s) 주소만. 잘못된 주소는 만들 때 던진다(시작이 실패한다) */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const isSeries = (x: unknown): x is Series => typeof x === 'object' && x !== null && Array.isArray((x as { value?: unknown }).value);

/** 값을 숫자로. 없음·숫자가 아님·NaN·Inf는 undefined다 */
const numberOf = (result: Series[]): number | undefined => {
  const raw = result[0]?.value[1];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : undefined;
};

export class PrometheusEntryPauseInputs implements EntryPauseClusterInputs {
  readonly #http: ExternalHttpClient;
  readonly #timeoutMs: number;

  /** @throws 주소가 http(s)가 아니거나 사용자 정보가 있음 */
  constructor(o: PrometheusEntryPauseInputsOptions) {
    this.#timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#http = createExternalHttpClient({ provider: 'prometheus', baseUrl: o.baseUrl, timeoutCapMs: this.#timeoutMs, ...(o.fetchImpl ? { fetch: o.fetchImpl } : {}) });
  }

  async read(pg: PgName, o: { readonly p99WindowMs?: number }): Promise<ClusterPauseReading | undefined> {
    const windowMs = o.p99WindowMs;
    const [open, ready, time, p99, samples] = await Promise.all([this.#query(openQuery(pg)), this.#query(readyQuery(pg)), this.#query(timeQuery(pg)), windowMs === undefined ? ([] as Series[]) : this.#query(p99Query(pg, windowMs)), windowMs === undefined ? ([] as Series[]) : this.#query(samplesQuery(pg, windowMs))]);
    if (open === 'failed' || ready === 'failed' || time === 'failed' || p99 === 'failed' || samples === 'failed') return undefined;
    const openPods = numberOf(open);
    const readyPods = numberOf(ready);
    const sampledAt = numberOf(time);
    if (openPods === undefined || readyPods === undefined || sampledAt === undefined) return undefined;
    const p99Seconds = numberOf(p99);
    const p99Samples = numberOf(samples);
    return { openPods, readyPods, sampledAtMs: sampledAt * 1000, ...(p99Seconds === undefined ? {} : { p99Seconds, ...(p99Samples === undefined ? {} : { p99Samples }) }) };
  }

  async #query(expr: string): Promise<Series[] | 'failed'> {
    let timer: NodeJS.Timeout | undefined;
    const work = (async (): Promise<Series[] | 'failed'> => {
      const res = await this.#http.request({ method: 'GET', path: '/api/v1/query', query: { query: expr } });
      if (!res.ok) return 'failed';
      const body = JSON.parse(await readLimited(res)) as { status?: string; data?: { result?: unknown } };
      if (body.status !== 'success' || !Array.isArray(body.data?.result)) return 'failed';
      return body.data.result.filter(isSeries);
    })().catch((): 'failed' => 'failed');
    try {
      return await Promise.race([work, new Promise<'failed'>((resolve) => (timer = setTimeout(() => resolve('failed'), this.#timeoutMs)))]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 본문을 크기 상한까지만 읽는다(넘으면 던져 failed가 된다) */
async function readLimited(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Prometheus 응답이 크기 상한을 넘었다');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 주소 설정이 없을 때의 입력: 언제나 입력 없음이다 */
export const NO_ENTRY_PAUSE_CLUSTER_INPUTS: EntryPauseClusterInputs = { read: async () => undefined };
