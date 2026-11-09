// 자동 제어의 판단 입력을 클러스터 Prometheus에서 읽는다(ADR-0226 결정 4·5, docs/features/queue-admission.md §5). 플랫폼 HTTP 클라이언트로 PromQL 즉시 조회를 부른다.
// 값과 표본 시각을 따로 읽어 맞춘다: 즉시 조회의 value[0]은 평가 시각이라 표본 시각이 아니다(`timestamp()`를 쓴다, 기술 검토 높음-12).
// 실패와 빈 결과를 구분해 돌려준다. 빈 결과·숫자가 아닌 값을 0으로 읽지 않는다(ADR-0069 결정 1). 시계열이 여럿이면 쿼리가 최댓값(나쁜 쪽)으로 묶는다.
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import { ALL_JOURNEYS, type EventInputs, type Reading } from '../domain/aimd.js';
import type { ControlInputsReader, ControlSnapshot } from '../domain/ports.js';

/** 값과 표본 시각의 쿼리. 표본 시각은 묶기 전에 timestamp()를 건다(묶은 뒤에 걸면 평가 시각이 된다) */
const valueAndTime = (metric: string, by: string) => ({ value: `max${by}(${metric})`, time: `max${by}(timestamp(${metric}))` });
const BY_EVENT = ' by (event_id) ';
const BY_JOURNEY = ' by (event_id, journey) ';

/** 기록 규칙 이름 [가정, wbs 4.2.1에서 규칙을 만들 때 확정] */
export const CONTROL_QUERIES = {
  latency: valueAndTime('peaket:admission:downstream_p99_seconds:30s', ''),
  errors: valueAndTime('peaket:admission:downstream_error_ratio:30s', ''),
  /** 파드마다 나오므로 한 파드라도 1이면 1이다 */
  seatStore: valueAndTime('seat_store_unavailable', BY_EVENT),
  budgetAlert: valueAndTime('peaket:slo:budget_alert10x:state', BY_JOURNEY),
  budgetBurn50: valueAndTime('peaket:slo:budget_burn50:state', BY_JOURNEY),
  pgCause: `max${BY_EVENT}(peaket:payment:pg_cause:state)`,
} as const;

/** 응답 크기 상한 2MiB [가정]: 회차 수 × 여정 일곱 × 2의 줄이면 수백 KB 안이다 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface PrometheusControlInputsOptions {
  /** http(s) 주소만. 잘못된 주소·사용자 정보는 만들 때 던진다(시작이 실패한다) */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** 조회 마감 800ms [가정]: 1초 주기 안에서 끝낸다. 머리·본문 모두 이 안이다 */
  timeoutMs?: number;
}

type Series = { metric: Record<string, string>; value: [number, unknown] };
type QueryResult = Series[] | 'failed';
type Pair = { values: QueryResult; times: QueryResult };

const isSeries = (x: unknown): x is Series => typeof x === 'object' && x !== null && Array.isArray((x as { value?: unknown }).value);
const numberOf = (s: Series | undefined): number => {
  const raw = s?.value[1];
  return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
};

export class PrometheusControlInputs implements ControlInputsReader {
  readonly #http: ExternalHttpClient;
  readonly #timeoutMs: number;

  constructor(o: PrometheusControlInputsOptions) {
    this.#timeoutMs = o.timeoutMs ?? 800;
    // 주소 검사(http(s)만, 사용자 정보·쿼리 없음), 리디렉트 따르지 않음, 시간 초과 신호를 플랫폼 클라이언트가 건다
    this.#http = createExternalHttpClient({ provider: 'prometheus', baseUrl: o.baseUrl, timeoutCapMs: this.#timeoutMs, ...(o.fetchImpl ? { fetch: o.fetchImpl } : {}) });
  }

  async #query(expr: string): Promise<QueryResult> {
    let timer: NodeJS.Timeout | undefined;
    const work = (async (): Promise<QueryResult> => {
      const res = await this.#http.request({ method: 'GET', path: '/api/v1/query', query: { query: expr } });
      if (!res.ok) return 'failed';
      const body = JSON.parse(await readLimited(res)) as { status?: string; data?: { result?: unknown } };
      if (body.status !== 'success' || !Array.isArray(body.data?.result)) return 'failed';
      return body.data.result.filter(isSeries);
    })().catch((): QueryResult => 'failed');
    try {
      // 요청은 신호가 끊는다. 신호를 따르지 않는 본문도 마감에서 기다리기를 그만둔다
      return await Promise.race([work, new Promise<QueryResult>((r) => (timer = setTimeout(() => r('failed'), this.#timeoutMs)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #pair(q: { value: string; time: string }): Promise<Pair> {
    const [values, times] = await Promise.all([this.#query(q.value), this.#query(q.time)]);
    return { values, times };
  }

  async read(): Promise<ControlSnapshot> {
    const [latency, errors, seatStore, alert, burn50, pgCause] = await Promise.all([this.#pair(CONTROL_QUERIES.latency), this.#pair(CONTROL_QUERIES.errors), this.#pair(CONTROL_QUERIES.seatStore), this.#pair(CONTROL_QUERIES.budgetAlert), this.#pair(CONTROL_QUERIES.budgetBurn50), this.#query(CONTROL_QUERIES.pgCause)]);
    const lat = single(latency);
    const err = single(errors);
    const seat = indexed(seatStore, (m) => m.event_id ?? '');
    const budget = indexedBudget(alert, burn50);
    const pg = new Set<string>();
    if (pgCause !== 'failed') for (const s of pgCause) if (s.metric?.event_id && numberOf(s) >= 1) pg.add(s.metric.event_id);
    const seatMiss = missOf(seatStore);
    const budgetMiss = missOf(alert, burn50);
    return {
      forEvent(eventId: string): EventInputs {
        const b = new Map<string, Reading>();
        for (const j of ALL_JOURNEYS) for (const k of ['alert', 'burn50'] as const) b.set(`${j}:${k}`, budget.get(`${eventId}|${j}|${k}`) ?? budgetMiss);
        return { latency: lat, errors: err, seatStore: seat.get(eventId) ?? seatMiss, budget: b, pgCause: pg.has(eventId) };
      },
    };
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

const missOf = (...qs: Pair[]): Reading => (qs.some((q) => q.values === 'failed' || q.times === 'failed') ? { ok: false, why: 'failed' } : { ok: false, why: 'missing' });

function single(q: Pair): Reading {
  if (q.values === 'failed' || q.times === 'failed') return { ok: false, why: 'failed' };
  return reading(q.values[0], q.times[0]);
}

/** 숫자가 아니면(NaN·Inf·null·없음) 입력 없음이다. 기록 규칙은 요청이 없을 때 0을 낸다(OPS-090) */
function reading(v: Series | undefined, t: Series | undefined): Reading {
  const value = numberOf(v);
  const at = numberOf(t);
  if (!Number.isFinite(value) || !Number.isFinite(at)) return { ok: false, why: 'missing' };
  return { ok: true, value, atMs: at * 1000 };
}

function indexed(q: Pair, keyOf: (m: Record<string, string>) => string): Map<string, Reading> {
  const out = new Map<string, Reading>();
  if (q.values === 'failed' || q.times === 'failed') return out;
  const times = new Map(q.times.map((s) => [keyOf(s.metric ?? {}), s]));
  for (const v of q.values) {
    const key = keyOf(v.metric ?? {});
    if (key) out.set(key, reading(v, times.get(key)));
  }
  return out;
}

function indexedBudget(alert: Pair, burn50: Pair): Map<string, Reading> {
  const out = new Map<string, Reading>();
  const keyOf = (m: Record<string, string>) => `${m.event_id ?? ''}|${m.journey ?? ''}`;
  for (const [suffix, q] of [['alert', alert], ['burn50', burn50]] as const) for (const [k, r] of indexed(q, keyOf)) out.set(`${k}|${suffix}`, r);
  return out;
}
