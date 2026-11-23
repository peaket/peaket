// 위젯 흐름의 원천 읽기가 첫 구독 요청의 남은 시간을 물려받지 않는지(F-03-1 브라우저 확인 결함 B-01).
// 정본: ADR-0100 결정 4·docs/frontend.md §4.4.5(위젯 흐름은 1초 [가정]마다 위젯의 전체 값을 보낸다), ADR-0360 결정 9(원천은 Prometheus),
// docs/api/guidelines.md §5(남은 시간은 그 요청의 것이다. 서비스 상한 기본 15초, packages/platform deadline.ts DEFAULT_MAX_DEADLINE_MS).
// 첫 구독은 SSE 요청 안에서 일어나고, 그 요청의 남은 시간은 15초 뒤 0이 된다. 위젯 읽기 주기가 그 남은 시간을 물려받으면
// 15초 뒤 모든 원천 호출이 보내기 전에 deadline-exceeded로 끝나 흐름이 늘 source-unavailable이 된다.
// 가짜는 경계 둘뿐이다: 시계(fakeClock)와 Prometheus HTTP 응답(fetch 주입, 실제 Prometheus 응답 모양 /api/v1/query vector).
// 실제 Prometheus 컨테이너 짝은 test-int/ops-live.int.test.ts의 B-01 ②다.
import { createExternalHttpClient, Deadline, DEFAULT_MAX_DEADLINE_MS, fakeClock, type RequestContext, runInRequestContext } from '@peaket/platform';
import { describe, expect, test, vi } from 'vitest';
import { PrometheusWidgetSource, WidgetFeed, type WidgetKey, type WidgetListener } from '../src/modules/live/index.js';

const T0 = Date.parse('2026-11-23T01:00:00.000Z');
const Q: WidgetKey = 'queue-admission-rate.summary';
/** 시험이 흐름을 열어 두는 시간: 서비스 상한 15초보다 길게 */
const OPEN_MS = 20_000;

/** Prometheus /api/v1/query의 vector 응답(회차 라벨이 없는 질의라 metric은 빈 객체) */
const promVector = (value: string): Response =>
  new Response(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [T0 / 1000, value] }] } }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('F-03-1 B-01 위젯 흐름의 원천 읽기와 요청 남은 시간', () => {
  test('F-03-1 B-01 ① SSE 요청 안에서 첫 구독을 한 위젯 주기는 그 요청의 남은 시간(15초)이 지난 뒤에도 원천을 실제로 묻고 원천 값을 낸다(source-unavailable 0)', async () => {
    const clock = fakeClock({ now: T0 });
    const asked: number[] = [];
    const fetchProm: typeof fetch = async () => {
      asked.push(clock.monotonicMs());
      return promVector('0.42');
    };
    const source = new PrometheusWidgetSource(createExternalHttpClient({ provider: 'prometheus', baseUrl: 'http://prometheus.test', timeoutCapMs: 2_000, fetch: fetchProm, clock }));
    // real-time: 요청 맥락(AsyncLocalStorage)이 타이머 콜백으로 넘어가는지가 결함이라 실제 setInterval을 쓴다. 가짜 타이머는 콜백을 맥락 밖에서 불러 결함을 가린다. 주기는 5ms로 줄이고 시간은 가짜 시계로 민다 F-03-1 B-01
    const feed = new WidgetFeed([source], { tickMs: 5, now: () => clock.now() });
    const got: Parameters<WidgetListener>[0][] = [];
    // SSE 요청 하나의 맥락(남은 시간은 서비스 상한 15초)
    // type-escape: RequestLogState는 platform 공개 면에 없어 요청 기록 칸만 빈 함수로 채운다(원천 호출은 dependency만 부른다) F-03-1 B-01
    const sse = { traceId: '0'.repeat(32), deadline: Deadline.after(DEFAULT_MAX_DEADLINE_MS, clock), route: '/v1/ops/events/{eventId}/live', method: 'GET', log: { set() {}, identify() {}, dependency() {}, keep() {} } } as unknown as RequestContext;
    const off = runInRequestContext(sse, () => feed.subscribe(null, Q, (v) => got.push(v)));
    try {
      await vi.waitFor(() => expect(got.length).toBeGreaterThan(0));
      expect(got[0]!.value).toMatchObject({ widgetKey: Q, source: 'prometheus', ratio: 0.42 });
      // 첫 구독 요청의 남은 시간이 지나도록 시계를 민다(흐름은 열려 있다)
      clock.advance(OPEN_MS);
      const afterDeadline = () => got.filter((v) => v.atMs - T0 > DEFAULT_MAX_DEADLINE_MS);
      await vi.waitFor(() => expect(afterDeadline().length).toBeGreaterThanOrEqual(3));
      expect(afterDeadline().map((v) => v.value), '요청 남은 시간이 지난 뒤의 위젯 값').toEqual(afterDeadline().map(() => expect.objectContaining({ widgetKey: Q, source: 'prometheus', ratio: 0.42 })));
      expect(afterDeadline().filter((v) => 'error' in v.value)).toEqual([]);
      // 15초 뒤에도 원천에 실제로 물었다(보내기 전에 끝나지 않았다)
      expect(asked.filter((ms) => ms > DEFAULT_MAX_DEADLINE_MS).length).toBeGreaterThan(0);
    } finally {
      off();
    }
  });
});
