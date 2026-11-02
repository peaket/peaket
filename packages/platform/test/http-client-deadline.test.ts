// 재현 시험(2026-11-03, BUILD_ORDER BSL-050 kind e2e): 외부 HTTP 클라이언트가 요청의 남은 시간을 그대로 AbortSignal.timeout에 넘겼다.
// 실제 단조 시계(performance.now())는 소수 밀리초라 남은 시간도 소수가 되고, AbortSignal.timeout은 정수만 받아 RangeError를 던졌다.
// 그래서 실제 배포에서 요청 안의 외부 호출(v0 결제의 PG 시뮬레이터 승인)이 보내지도 못하고 실패했다. 시험은 정수만 내는 가짜 시계를 써서 놓쳤다.
// 시각은 주입한 시계로 잰다(시간 의존 로직은 Clock 주입). 소수 단조 시각에서 시작해 실제 시계와 같은 모양을 만든다.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Deadline, ProblemError, createExternalHttpClient, fakeClock, runInRequestContext, type RequestContext } from '../src/index.js';

/** 요청 맥락(요청 기록은 의존성 시간만 받는다) */
function requestContextWith(deadline: Deadline): RequestContext {
  return {
    traceId: 'a'.repeat(32),
    deadline,
    route: '/v0/orders/{orderId}/payment',
    method: 'POST',
    log: { dependency: () => undefined, keep: () => undefined },
  } as unknown as RequestContext;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('외부 HTTP 클라이언트의 남은 시간', () => {
  test('GL5_요청안의_남은시간이소수밀리초여도_정수시간초과로보낸다(재현)', async () => {
    const clock = fakeClock({ monotonic: 1000.25 });
    const deadline = Deadline.after(15_000, clock);
    clock.advance(0.5); // 남은 시간 14,999.5ms(소수)
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      return real(ms);
    });
    const fetch = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createExternalHttpClient({ provider: 'pg-simulator', baseUrl: 'http://pg-simulator.v0.svc:8790', timeoutCapMs: 60_000, clock, fetch });

    const res = await runInRequestContext(requestContextWith(deadline), () => client.request({ method: 'POST', path: '/v1/payments/confirm', body: '{}' }));

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(timeouts).toHaveLength(1);
    const [ms] = timeouts;
    expect(Number.isInteger(ms)).toBe(true);
    // 남은 시간을 넘지 않는다(내림)
    expect(ms).toBe(14_999);
  });

  test('GL5_남은시간이1밀리초미만이면_보내지않고_504_deadline-exceeded(RangeError가아니다)', async () => {
    const clock = fakeClock({ monotonic: 0.25 });
    const deadline = Deadline.after(1, clock);
    clock.advance(0.5); // 남은 시간 0.5ms
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = createExternalHttpClient({ provider: 'pg-simulator', baseUrl: 'http://pg-simulator.v0.svc:8790', timeoutCapMs: 60_000, clock, fetch });

    const err = await runInRequestContext(requestContextWith(deadline), () => client.request({ method: 'GET', path: '/sim/ledger' })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProblemError);
    expect((err as ProblemError).status).toBe(504);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('GL5_요청밖에서는_호출상한을그대로_정수로쓴다', async () => {
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      return real(ms);
    });
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = createExternalHttpClient({ provider: 'pg-simulator', baseUrl: 'http://pg-simulator.v0.svc:8790', timeoutCapMs: 60_000, clock: fakeClock(), fetch });
    await client.request({ method: 'GET', path: '/sim/ledger' });
    expect(timeouts).toEqual([60_000]);
  });
});
