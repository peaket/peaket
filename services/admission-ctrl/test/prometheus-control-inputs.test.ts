// Prometheus 판단 입력(ADR-0226 결정 4·5, docs/features/queue-admission.md §5, Q-T42). 가짜 fetch로 PromQL 응답을 돌려준다.
import { describe, expect, test } from 'vitest';
import { CONTROL_QUERIES, PrometheusControlInputs } from '../src/modules/leader/adapters/prometheus-control-inputs.js';

const T = 1_700_000_000;
type Vec = { metric?: Record<string, string>; value?: unknown }[];
const vec = (metric: Record<string, string>, value: unknown): Vec[number] => ({ metric, value: [T, typeof value === 'number' ? String(value) : value] });
type Answer = Vec | 'fail' | 'bad-json' | 'throw';

function fakeFetch(answers: Record<string, Answer>): typeof fetch {
  return (async (url: string | URL) => {
    const query = new URL(String(url)).searchParams.get('query') ?? '';
    const a = answers[query];
    if (a === 'throw') throw new Error('연결 실패');
    if (a === 'fail') return new Response('{"status":"error"}', { status: 503 });
    if (a === 'bad-json') return new Response('아니다', { status: 200 });
    return new Response(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: a ?? [] } }), { status: 200 });
  }) as typeof fetch;
}

const q = CONTROL_QUERIES;
const all = (o: { lat?: Answer; latTs?: Answer } = {}): Record<string, Answer> => ({
  [q.latency.value]: o.lat ?? [vec({}, 0.05)],
  [q.latency.time]: o.latTs ?? [vec({}, T - 2)],
  [q.errors.value]: [vec({}, 0.001)],
  [q.errors.time]: [vec({}, T - 3)],
  [q.seatStore.value]: [vec({ event_id: 'e1' }, 0)],
  [q.seatStore.time]: [vec({ event_id: 'e1' }, T - 1)],
  [q.budgetAlert.value]: [vec({ event_id: 'e1', journey: 'hold' }, 1)],
  [q.budgetAlert.time]: [vec({ event_id: 'e1', journey: 'hold' }, T - 1)],
  [q.budgetBurn50.value]: [vec({ event_id: 'e1', journey: 'hold' }, 0)],
  [q.budgetBurn50.time]: [vec({ event_id: 'e1', journey: 'hold' }, T - 1)],
  [q.pgCause]: [vec({ event_id: 'e1' }, 1)],
});
const reader = (fetchImpl: typeof fetch, timeoutMs?: number) => new PrometheusControlInputs({ baseUrl: 'http://prom.test', fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });

describe('Prometheus 판단 입력', () => {
  test('[Q-T42] 값과_timestamp표본시각을_열쇠로맞춘다', async () => {
    const r = await reader(fakeFetch(all())).read();
    const e = r.forEvent('e1');
    expect(e.latency).toEqual({ ok: true, value: 0.05, atMs: (T - 2) * 1000 });
    expect(e.errors).toEqual({ ok: true, value: 0.001, atMs: (T - 3) * 1000 });
    expect(e.seatStore).toEqual({ ok: true, value: 0, atMs: (T - 1) * 1000 });
    expect(e.budget.get('hold:alert')).toEqual({ ok: true, value: 1, atMs: (T - 1) * 1000 });
    expect(e.pgCause).toBe(true);
    // 다른 회차는 그 회차의 줄이 없으므로 missing이고 전역 입력은 같다
    const other = r.forEvent('e2');
    expect(other.seatStore).toEqual({ ok: false, why: 'missing' });
    expect(other.latency.ok).toBe(true);
    expect(other.pgCause).toBe(false);
  });

  test('[Q-T42] [ASVS v5.0.0-16.5.2] 빈결과는_missing이고_쿼리실패와연결실패와틀린응답은_failed다', async () => {
    expect((await reader(fakeFetch(all({ lat: [] }))).read()).forEvent('e1').latency).toEqual({ ok: false, why: 'missing' });
    expect((await reader(fakeFetch(all({ latTs: [] }))).read()).forEvent('e1').latency).toEqual({ ok: false, why: 'missing' });
    for (const bad of ['fail', 'throw', 'bad-json'] as const) {
      const r = await reader(fakeFetch(all({ lat: bad }))).read();
      expect(r.forEvent('e1').latency).toEqual({ ok: false, why: 'failed' });
      expect(r.forEvent('e1').errors.ok).toBe(true);
    }
    const noBudget = await reader(fakeFetch({})).read();
    expect(noBudget.forEvent('e1').budget.get('hold:alert')).toEqual({ ok: false, why: 'missing' });
  });

  test('[Q-T42] 시계열이여럿이어도_쿼리가최댓값으로묶어_임의의하나를쓰지않는다', () => {
    expect(q.latency.value).toBe('max(peaket:admission:downstream_p99_seconds:30s)');
    expect(q.seatStore.value).toBe('max by (event_id) (seat_store_unavailable)');
    expect(q.seatStore.time).toBe('max by (event_id) (timestamp(seat_store_unavailable))');
    expect(q.budgetAlert.value).toContain('max by (event_id, journey)');
    expect(q.pgCause).toContain('max by (event_id)');
  });

  test('[Q-T42] [ASVS v5.0.0-16.5.2] 숫자가아닌값과_value없는시계열은_입력없음으로보고_read가던지지않는다', async () => {
    for (const bad of [[vec({}, null)], [vec({}, 'NaN')], [vec({}, '+Inf')], [{}], [{ metric: {} }]] as Vec[]) {
      const r = await reader(fakeFetch(all({ lat: bad }))).read();
      expect(r.forEvent('e1').latency).toEqual({ ok: false, why: 'missing' });
    }
  });

  test('[ASVS v5.0.0-16.5.2] 응답이늦으면_요청을끊고failed로본다', async () => {
    let signal: AbortSignal | undefined;
    const slow = ((_u: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => undefined);
    }) as unknown as typeof fetch;
    const r = await reader(slow, 5).read();
    expect(r.forEvent('e1').latency).toEqual({ ok: false, why: 'failed' });
    expect(signal?.aborted).toBe(true);
  });

  test('[ASVS v5.0.0-16.5.2] 머리는왔는데본문이끝나지않으면_마감에서failed다', async () => {
    const hang = (async () => new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch;
    const out = await Promise.race([reader(hang, 20).read().then((s) => s.forEvent('e1').latency), new Promise((res) => setTimeout(() => res('안 끝남'), 500))]);
    expect(out).toEqual({ ok: false, why: 'failed' });
  });

  test('[ASVS v5.0.0-16.5.2] 응답이너무크면_failed이고_리디렉트를따르지않는다', async () => {
    const huge = (async () => new Response(JSON.stringify({ status: 'success', data: { result: [], pad: 'x'.repeat(3_000_000) } }), { status: 200 })) as unknown as typeof fetch;
    expect((await reader(huge).read()).forEvent('e1').latency).toEqual({ ok: false, why: 'failed' });
    let redirect: string | undefined;
    const seen = (async (_u: unknown, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response('', { status: 302, headers: { location: 'http://evil.test' } });
    }) as unknown as typeof fetch;
    expect((await reader(seen).read()).forEvent('e1').latency).toEqual({ ok: false, why: 'failed' });
    expect(redirect).toBe('manual');
  });

  test('[ASVS v5.0.0-16.5.2] 주소가http(s)가아니거나_사용자정보가있으면_시작할때거절한다', () => {
    for (const bad of ['not a url', 'ftp://x', 'http://user:pw@x', 'http://x?y=1']) expect(() => new PrometheusControlInputs({ baseUrl: bad })).toThrow();
    expect(() => new PrometheusControlInputs({ baseUrl: 'http://prometheus.monitoring:9090' })).not.toThrow();
  });
});
