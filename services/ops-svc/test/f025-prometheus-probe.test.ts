// 적용 확인의 Prometheus 즉시 질의 어댑터(PrometheusSettingsProbe)와 환경 조립(settingsProbeFromEnv)을 본다
// (F-02-5 OPS-300, ADR-0365 결정 10·15, docs/security/asvs/control-tower.md 63행 1.3.6, 계획 6절 B12~B14, 9절 F025-PROM·ASVS 1.3.6).
// 정본 값:
// - 주소는 PEAKET_PROMETHEUS_URL에서만. 운영과 같은 환경(platform isProductionLikeEnv: NODE_ENV=production 또는 PEAKET_ENV prod·staging·production)에서
//   없으면 시작 실패(PlatformConfigError), local·ci(그리고 demo, isProductionLikeEnv가 거짓)에서 없으면 늘 UNKNOWN 사유 prometheus-not-wired(결정 15)
// - 질의는 GET /api/v1/query 즉시 질의 둘: up{service="<서비스>"} == 1(파드 목록)과 control_settings_applied_version{service="<서비스>",key="<키>"}(파드별 판), 파드는 pod 라벨로 잇는다
// - 한 질의 2초 [가정] 시간 초과·연결 실패·HTTP 오류·응답 꼴 오류는 모두 ok:false(호출 쪽이 UNKNOWN)
// - 라벨 값은 넣기 직전에 ^[A-Za-z0-9:_-]{1,200}$로 다시 보고, 어긋나면 부르지 않고 invalid-label(ASVS 1.3.6)
// 바깥 HTTP는 fetch 주입(typeof fetch)으로 바꾼다: 실제 포트를 열지 않는다. 답은 Prometheus HTTP API v1 즉시 질의 응답 꼴
// ({status:'success', data:{resultType:'vector', result:[{metric, value:[초, '글']}]}})이다. 시간은 setTimeout·clearTimeout만 가짜 타이머로 잰다.
import { PlatformConfigError } from '@peaket/platform';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PROMETHEUS_URL_ENV, PrometheusSettingsProbe, settingsProbeFromEnv, type ProbeResult } from '../src/modules/commands/index.js';

const BASE = 'http://prometheus.monitoring.svc:9090';
const KEY = 'PLATFORM:LOG_LEVEL:purchase-svc';
const V = 1_763_874_000_010;
const TS = 1_763_874_031.5;

type Fetch = typeof fetch;
type Vec = { metric: Record<string, string>; value: [number, string] }[];

const vector = (result: Vec): Response =>
  new Response(JSON.stringify({ status: 'success', data: { resultType: 'vector', result } }), { status: 200, headers: { 'content-type': 'application/json' } });

const upOf = (service: string, ...pods: string[]): Vec => pods.map((pod) => ({ metric: { __name__: 'up', service, pod, job: service }, value: [TS, '1'] }));
const versionsOf = (service: string, key: string, ...pods: [string, string][]): Vec =>
  pods.map(([pod, v]) => ({ metric: { __name__: 'control_settings_applied_version', service, key, pod }, value: [TS, v] }));

/** 질의 글로 답을 고르는 짝 가짜 fetch. 받은 URL·방법을 적는다 */
function fakeFetch(answer: (query: string) => Response | Promise<Response>) {
  const calls: { url: URL; method: string }[] = [];
  const fn: Fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, method: init?.method ?? 'GET' });
    return answer(url.searchParams.get('query') ?? '');
  };
  return { fn, calls };
}

const isUp = (q: string) => q.startsWith('up{');

afterEach(() => {
  vi.useRealTimers();
});

describe('F025-PROM 질의와 해석(결정 15, B12)', () => {
  test('F025-PROM ① 즉시 질의 둘을 정본 글 그대로 GET /api/v1/query로 보내고 pod 라벨로 파드와 판을 잇는다(지표 없는 파드는 판 없음)', async () => {
    const f = fakeFetch((q) =>
      isUp(q) ? vector(upOf('purchase-svc', 'purchase-svc-0', 'purchase-svc-1', 'purchase-svc-2')) : vector(versionsOf('purchase-svc', KEY, ['purchase-svc-0', String(V)], ['purchase-svc-2', String(V - 1)])),
    );
    const probe = new PrometheusSettingsProbe({ url: BASE, fetch: f.fn });
    const r = await probe.probe({ service: 'purchase-svc', messageKey: KEY, version: V });

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('ok가 아니다');
    const byPod = Object.fromEntries(r.pods.map((p) => [p.pod, p.version]));
    expect(byPod).toEqual({ 'purchase-svc-0': V, 'purchase-svc-1': undefined, 'purchase-svc-2': V - 1 });
    expect(r.pods).toHaveLength(3);

    expect(f.calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    for (const c of f.calls) {
      expect(c.url.origin).toBe(BASE);
      expect(c.url.pathname).toBe('/api/v1/query');
    }
    expect(f.calls.map((c) => c.url.searchParams.get('query')).sort()).toEqual([
      'control_settings_applied_version{service="purchase-svc",key="PLATFORM:LOG_LEVEL:purchase-svc"}',
      'up{service="purchase-svc"} == 1',
    ]);
  });

  test('F025-PROM ② up 결과가 0줄이면 ok이고 파드 목록이 비어 있다(호출 쪽이 no-targets로 본다)', async () => {
    const f = fakeFetch(() => vector([]));
    const r = await new PrometheusSettingsProbe({ url: BASE, fetch: f.fn }).probe({ service: 'core-svc', messageKey: 'PLATFORM:FEATURE_FLAG:reviews', version: V });
    expect(r).toEqual({ ok: true, pods: [] });
  });

  test('F025-PROM ③ 판 지표 글을 숫자로 읽는다: 판 10에 "9"를 낸 파드와 "10"을 낸 파드', async () => {
    const f = fakeFetch((q) => (isUp(q) ? vector(upOf('ticket-svc', 'ticket-svc-a', 'ticket-svc-b')) : vector(versionsOf('ticket-svc', 'PLATFORM:LOG_LEVEL:ticket-svc', ['ticket-svc-a', '9'], ['ticket-svc-b', '10']))));
    const r = await new PrometheusSettingsProbe({ url: BASE, fetch: f.fn }).probe({ service: 'ticket-svc', messageKey: 'PLATFORM:LOG_LEVEL:ticket-svc', version: 10 });
    if (!r.ok) throw new Error('ok가 아니다');
    expect(Object.fromEntries(r.pods.map((p) => [p.pod, p.version]))).toEqual({ 'ticket-svc-a': 9, 'ticket-svc-b': 10 });
    for (const p of r.pods) expect(typeof p.version).toBe('number');
  });
});

describe('F025-PROM 실패는 ok:false(결정 15, B13)', () => {
  const expectFail = (r: ProbeResult) => {
    expect(r).toEqual({ ok: false, reason: expect.any(String) });
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  };

  test('F025-PROM ④ 응답이 2초 − 1ms에 오면 성공이다(시간 한도 기본 2초)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fn: Fetch = (input, init) =>
      new Promise<Response>((resolve, reject) => {
        const q = new URL(String(input instanceof Request ? input.url : input)).searchParams.get('query') ?? '';
        const t = setTimeout(() => resolve(isUp(q) ? vector(upOf('purchase-svc', 'purchase-svc-0')) : vector(versionsOf('purchase-svc', KEY, ['purchase-svc-0', String(V)]))), isUp(q) ? 1_999 : 0);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(init.signal?.reason ?? new Error('aborted'));
        });
      });
    const pending = new PrometheusSettingsProbe({ url: BASE, fetch: fn }).probe({ service: 'purchase-svc', messageKey: KEY, version: V });
    await vi.advanceTimersByTimeAsync(1_999);
    await vi.advanceTimersByTimeAsync(0);
    const r = await pending;
    expect(r).toEqual({ ok: true, pods: [{ pod: 'purchase-svc-0', version: V }] });
  });

  test('F025-PROM ⑤ 답이 없으면 2초 − 1ms에는 아직 기다리고 2초 정각에 ok:false로 끝난다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const signals: AbortSignal[] = [];
    const fn: Fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal) {
          signals.push(init.signal);
          init.signal.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
        }
      });
    let settled: ProbeResult | undefined;
    const pending = new PrometheusSettingsProbe({ url: BASE, fetch: fn }).probe({ service: 'purchase-svc', messageKey: KEY, version: V }).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBeUndefined();
    expect(signals.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expectFail(settled!);
    expect(signals[0]!.aborted).toBe(true);
  });

  test('F025-PROM ⑥ 주어진 시간 한도(시험 값 1,700ms)를 쓴다: 1,699ms에는 기다리고 1,700ms에 ok:false', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fn: Fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    let settled: ProbeResult | undefined;
    const pending = new PrometheusSettingsProbe({ url: BASE, fetch: fn, timeoutMs: 1_700 }).probe({ service: 'purchase-svc', messageKey: KEY, version: V }).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(1_699);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expectFail(settled!);
  });

  test('F025-PROM ⑦ 연결 실패(ECONNREFUSED)는 ok:false다', async () => {
    const fn: Fetch = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:9090'), { code: 'ECONNREFUSED' }) });
    };
    expectFail(await new PrometheusSettingsProbe({ url: BASE, fetch: fn }).probe({ service: 'purchase-svc', messageKey: KEY, version: V }));
  });

  test('F025-PROM ⑧ HTTP 503은 ok:false다', async () => {
    const f = fakeFetch(() => new Response('service unavailable', { status: 503 }));
    expectFail(await new PrometheusSettingsProbe({ url: BASE, fetch: f.fn }).probe({ service: 'purchase-svc', messageKey: KEY, version: V }));
  });

  test('F025-PROM ⑨ 판 질의만 503이어도 ok:false다(파드 목록만으로 판정하지 않는다)', async () => {
    const f = fakeFetch((q) => (isUp(q) ? vector(upOf('purchase-svc', 'purchase-svc-0')) : new Response('', { status: 503 })));
    expectFail(await new PrometheusSettingsProbe({ url: BASE, fetch: f.fn }).probe({ service: 'purchase-svc', messageKey: KEY, version: V }));
  });

  test.each([
    ['data.result 없음', () => new Response(JSON.stringify({ status: 'success', data: { resultType: 'vector' } }), { status: 200 })],
    ['status error', () => new Response(JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'parse error' }), { status: 200 })],
    ['JSON 아님', () => new Response('<html>proxy</html>', { status: 200 })],
    ['판 값 NaN', () => vector(versionsOf('purchase-svc', KEY, ['purchase-svc-0', 'NaN']))],
    ['판 값이 숫자 아님', () => vector(versionsOf('purchase-svc', KEY, ['purchase-svc-0', 'abc']))],
  ])('F025-PROM ⑩ 판 질의 응답 꼴 오류(%s)는 ok:false다', async (_name, bad) => {
    const f = fakeFetch((q) => (isUp(q) ? vector(upOf('purchase-svc', 'purchase-svc-0')) : bad()));
    expectFail(await new PrometheusSettingsProbe({ url: BASE, fetch: f.fn }).probe({ service: 'purchase-svc', messageKey: KEY, version: V }));
  });

  test('F025-PROM ⑪ up 질의 응답 꼴 오류(result가 배열 아님)는 ok:false다', async () => {
    const f = fakeFetch((q) => (isUp(q) ? new Response(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: {} } }), { status: 200 }) : vector([])));
    expectFail(await new PrometheusSettingsProbe({ url: BASE, fetch: f.fn }).probe({ service: 'purchase-svc', messageKey: KEY, version: V }));
  });
});

describe('[ASVS v5.0.0-1.3.6] Prometheus 질의의 주소와 라벨(결정 15, B13·B14)', () => {
  test.each([
    [{ PEAKET_ENV: 'prod' }],
    [{ PEAKET_ENV: 'staging' }],
    [{ PEAKET_ENV: 'production' }],
    [{ NODE_ENV: 'production', PEAKET_ENV: 'local' }],
    [{ PEAKET_ENV: 'prod', [PROMETHEUS_URL_ENV]: '' }],
  ])('[ASVS v5.0.0-1.3.6] ① 운영과 같은 환경 %o에서 Prometheus 주소가 없으면 조립이 PlatformConfigError로 실패한다', (env) => {
    expect(PROMETHEUS_URL_ENV).toBe('PEAKET_PROMETHEUS_URL');
    expect(() => settingsProbeFromEnv(env)).toThrow(PlatformConfigError);
  });

  test.each([[{ PEAKET_ENV: 'local' }], [{ PEAKET_ENV: 'ci' }], [{ PEAKET_ENV: 'demo' }], [{}]])(
    '[ASVS v5.0.0-1.3.6] ① 운영과 같지 않은 환경 %o에서 주소가 없으면 늘 prometheus-not-wired다',
    async (env) => {
      const probe = settingsProbeFromEnv(env);
      expect(await probe.probe({ service: 'purchase-svc', messageKey: KEY, version: V })).toEqual({ ok: false, reason: 'prometheus-not-wired' });
      expect(await probe.probe({ service: 'core-svc', messageKey: 'PLATFORM:FEATURE_FLAG:reviews', version: V + 1 })).toEqual({ ok: false, reason: 'prometheus-not-wired' });
    },
  );

  test('[ASVS v5.0.0-1.3.6] ① 운영 환경에 주소가 있으면 그 주소의 질의 어댑터다', () => {
    expect(settingsProbeFromEnv({ PEAKET_ENV: 'prod', [PROMETHEUS_URL_ENV]: BASE })).toBeInstanceOf(PrometheusSettingsProbe);
  });

  test.each([
    ['따옴표가 든 서비스', { service: 'purchase-svc"} or vector(1) #', messageKey: KEY }],
    ['역슬래시가 든 서비스', { service: 'purchase-svc\\', messageKey: KEY }],
    ['줄바꿈이 든 서비스', { service: 'purchase-svc\nup', messageKey: KEY }],
    ['중괄호가 든 키', { service: 'purchase-svc', messageKey: 'PLATFORM:LOG_LEVEL:purchase-svc}' }],
    ['따옴표가 든 키', { service: 'purchase-svc', messageKey: 'PLATFORM:LOG_LEVEL:"x"' }],
    ['빈 서비스', { service: '', messageKey: KEY }],
    ['201자 키', { service: 'purchase-svc', messageKey: `PLATFORM:LOG_LEVEL:${'a'.repeat(201 - 'PLATFORM:LOG_LEVEL:'.length)}` }],
    ['설정을 읽지 않는 서비스 realtime-gw', { service: 'realtime-gw', messageKey: 'PLATFORM:LOG_LEVEL:realtime-gw' }],
    ['설정을 읽지 않는 서비스 admission-ctrl', { service: 'admission-ctrl', messageKey: 'PLATFORM:LOG_LEVEL:admission-ctrl' }],
    ['대문자 서비스', { service: 'Purchase-svc', messageKey: KEY }],
  ])('[ASVS v5.0.0-1.3.6] ② %s의 라벨은 질의하지 않고 invalid-label이다', async (_name, q) => {
    const f = fakeFetch(() => vector([]));
    const r = await new PrometheusSettingsProbe({ url: BASE, fetch: f.fn }).probe({ ...q, version: V });
    expect(r).toEqual({ ok: false, reason: 'invalid-label' });
    expect(f.calls).toHaveLength(0);
  });

  test('[ASVS v5.0.0-1.3.6] ② 200자 키와 trust-svc(명령 5 받는 쪽)는 허용 범위라 질의한다', async () => {
    const key200 = `PLATFORM:LOG_LEVEL:${'a'.repeat(200 - 'PLATFORM:LOG_LEVEL:'.length)}`;
    expect(key200).toHaveLength(200);
    const f = fakeFetch(() => vector([]));
    const probe = new PrometheusSettingsProbe({ url: BASE, fetch: f.fn });
    expect(await probe.probe({ service: 'purchase-svc', messageKey: key200, version: V })).toEqual({ ok: true, pods: [] });
    expect(await probe.probe({ service: 'trust-svc', messageKey: 'PLATFORM:BOT_LEVEL:', version: V })).toEqual({ ok: true, pods: [] });
    expect(f.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.calls.map((c) => c.url.searchParams.get('query'))).toContain('up{service="trust-svc"} == 1');
  });
});
