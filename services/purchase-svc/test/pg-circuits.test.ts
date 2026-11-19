// 회차 취소 일괄 환불의 결제사 서킷 연결(R-T45 ①~③, BAT-425 GAT-120, docs/features/transfer-refund.md §5 '서킷 연결').
// payment-svc 내부 `GET /internal/v1/circuits`의 상태를 purchase-svc가 10초 [가정] 캐시로 읽는다.
// `open`만 그 결제사 몫을 AUTO_CIRCUIT_OPEN으로 멈추고, half_open·closed는 계속한다.
// 읽기 실패·시간 초과는 모든 몫을 거짓으로 두고 환급은 계속하며 경고 로그 event-refund-pg-circuits-read-failed만 남긴다.
// 자동 재개는 없고 수동 재개(EVENT_REFUND_RESUME) 뒤에도 서킷이 열려 있으면 바로 다시 멈춘다.
// 단위 시험이며 실제 HTTP·DB·통합은 BAT-425 통합 시험 몫이다.
import { describe, expect, test } from 'vitest';
import { HttpPgCircuits, PG_CIRCUIT_CACHE_MS } from '../src/modules/refund/adapters/http-pg-circuits.js';
import { MemoryEventRefundAttemptStore, MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import type { EventRefundAlert, EventRefundCanceller, EventRefundTargets } from '../src/modules/refund/domain/event-refund-ports.js';
import type { EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';

const NOW = Date.parse('2026-11-20T08:00:00.000Z');
const REQUEST = '0193b425-0000-7000-8000-000000000001';
const EVENT = '0193b425-0000-7000-8000-000000000002';
const T1 = '0193b425-0000-7000-8000-000000000011';
const T2 = '0193b425-0000-7000-8000-000000000012';

const target = (ticketId: string, over: Partial<EventRefundTarget> = {}): EventRefundTarget => ({
  orderId: `order-${ticketId}`,
  ticketId,
  seatId: `seat-${ticketId}`,
  payerAccountId: '0193b425-0000-7000-8000-000000000007',
  ticketPrice: 47_500,
  bookedAtMs: NOW - 86_400_000,
  saleEndsAtMs: NOW + 7 * 86_400_000,
  pg: 'TOSS',
  ...over,
});

interface Item {
  pg?: string;
  state?: string;
}
const clientOf = (items: Item[] | 'throw') => {
  const calls: { method: string; path: string; token?: string; timeoutCapMs?: number }[] = [];
  return {
    calls,
    client: {
      request: async (r: { method: string; path: string; headers?: Record<string, string>; timeoutCapMs?: number }) => {
        calls.push({ method: r.method, path: r.path, ...(r.headers?.['x-peaket-internal-token'] === undefined ? {} : { token: r.headers['x-peaket-internal-token'] }), ...(r.timeoutCapMs === undefined ? {} : { timeoutCapMs: r.timeoutCapMs }) });
        if (items === 'throw') throw new Error('payment-svc circuits 읽기 실패');
        return { status: 200, json: async () => ({ items }) };
      },
    },
  };
};

describe('R-T45 ① GET /internal/v1/circuits의 open만 멈춤', () => {
  test('R-T45 ①_open인_TOSS만_참이고_half_open·closed는_거짓이다_내부_토큰과_3초_한도로_한_번_읽는다', async () => {
    const c = clientOf([
      { pg: 'TOSS', state: 'open' },
      { pg: 'PORTONE', state: 'half_open' },
      { pg: 'SIMULATOR', state: 'closed' },
    ]);
    const circuits = new HttpPgCircuits({ client: c.client as never, internalToken: 'internal-test-token', nowMs: () => NOW });
    await circuits.refresh();
    expect(c.calls).toEqual([{ method: 'GET', path: '/internal/v1/circuits', token: 'internal-test-token', timeoutCapMs: 3_000 }]);
    expect(circuits.circuitOpen('TOSS')).toBe(true);
    expect(circuits.circuitOpen('PORTONE')).toBe(false);
    expect(circuits.circuitOpen('SIMULATOR')).toBe(false);
  });

  test('R-T45 ①_모르는_결제사_이름과_2xx_밖_답은_거짓이고_경고만_남긴다', async () => {
    const warns: object[] = [];
    const calls: string[] = [];
    const circuits = new HttpPgCircuits({
      client: {
        request: async () => {
          calls.push('read');
          return { status: 503, json: async () => ({ items: [{ pg: 'TOSS', state: 'open' }] }) };
        },
      } as never,
      nowMs: () => NOW,
      log: { warn: (o) => void warns.push(o) },
    });
    await circuits.refresh();
    expect(calls).toHaveLength(1);
    expect(circuits.circuitOpen('TOSS')).toBe(false);
    expect(warns).toEqual([expect.objectContaining({ dep: 'payment-svc', event: 'event-refund-pg-circuits-read-failed' })]);
  });
});

describe('R-T45 ② 캐시 10초와 읽기 실패', () => {
  test('R-T45 ②_10초_안(9,999ms)에는_다시_읽지_않고_정각(10,000ms)에_다시_읽는다', async () => {
    let now = NOW;
    const c = clientOf([{ pg: 'TOSS', state: 'open' }]);
    const circuits = new HttpPgCircuits({ client: c.client as never, nowMs: () => now });
    await circuits.refresh();
    expect(c.calls).toHaveLength(1);
    now += PG_CIRCUIT_CACHE_MS - 1;
    expect(circuits.circuitOpen('TOSS')).toBe(true);
    await Promise.resolve();
    expect(c.calls).toHaveLength(1);
    now += 1;
    expect(circuits.circuitOpen('TOSS')).toBe(true);
    await circuits.refresh();
    expect(c.calls).toHaveLength(2);
  });

  test('R-T45 ②_읽기_실패는_모든_몫을_거짓으로_두고_환급을_막지_않으며_경고를_한_번_남긴다', async () => {
    let now = NOW;
    let fail = false;
    const warns: object[] = [];
    let calls = 0;
    const circuits = new HttpPgCircuits({
      client: {
        request: async () => {
          calls++;
          if (fail) throw new Error('시간 초과');
          return { status: 200, json: async () => ({ items: [{ pg: 'TOSS', state: 'open' }] }) };
        },
      } as never,
      nowMs: () => now,
      log: { warn: (o) => void warns.push(o) },
    });
    await circuits.refresh();
    expect(circuits.circuitOpen('TOSS')).toBe(true);
    fail = true;
    now += PG_CIRCUIT_CACHE_MS;
    await circuits.refresh();
    expect(circuits.circuitOpen('TOSS')).toBe(false);
    expect(circuits.circuitOpen('PORTONE')).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ event: 'event-refund-pg-circuits-read-failed' });
    expect(calls).toBe(2);
    // 실패한 읽기도 캐시 시각을 갱신해 틱마다 같은 실패를 되풀이하지 않는다
    now += PG_CIRCUIT_CACHE_MS - 1;
    circuits.circuitOpen('TOSS');
    await Promise.resolve();
    expect(calls).toBe(2);
  });
});

describe('R-T45 ③ 일괄 환불의 자동 정지·재개', () => {
  const fixture = (o: { targets?: EventRefundTarget[]; open?: (pg: string) => boolean; outcomes?: Array<'REFUNDED' | 'REFUND_PENDING' | 'FAILED'> } = {}) => {
    let now = NOW;
    const store = new MemoryEventRefundStore();
    const attempts = new MemoryEventRefundAttemptStore();
    const calls: Parameters<EventRefundCanceller['cancel']>[] = [];
    const raises: Parameters<EventRefundAlert['raise']>[0][] = [];
    const paused: string[] = [];
    let i = 0;
    const outcomes = o.outcomes ?? [];
    const canceller: EventRefundCanceller = {
      cancel: async (t, q) => {
        calls.push([t, q]);
        const status = outcomes[i++] ?? 'REFUNDED';
        return status === 'FAILED' ? { status, error: 'REJECTED' } : { status };
      },
    };
    const targets: EventRefundTargets = { list: async () => o.targets ?? [target(T1)] };
    const service = new EventRefundService({
      store,
      targets,
      canceller,
      attempts,
      circuitOpen: (pg: string) => (o.open ? o.open(pg) : false),
      circuitPauses: { inc: (pg: string) => void paused.push(pg) },
      alert: { raise: async (q) => void raises.push(q) },
      nowMs: () => now,
      deadlineMs: () => now + 5_000,
      concurrency: 1,
    });
    return { store, attempts, service, calls, raises, paused, setNow: (ms: number) => (now = ms) };
  };
  const start = (service: EventRefundService) => service.start({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });

  test('R-T45 ③_open인_결제사_몫만_AUTO_CIRCUIT_OPEN으로_멈추고_다른_결제사는_계속_환급한다_지표도_1이다', async () => {
    const f = fixture({ targets: [target(T1), target(T2, { pg: 'PORTONE' })], open: (pg) => pg === 'TOSS' });
    const r = await start(f.service);
    // TOSS는 멈추고 PORTONE만 보낸다
    expect(f.calls.map(([t]) => t.ticketId)).toEqual([T2]);
    expect(r.status).toBe('PAUSED');
    expect(r.progress.perPg.find((p) => p.pg === 'TOSS')).toMatchObject({ state: 'PAUSED', pauseReason: 'AUTO_CIRCUIT_OPEN' });
    expect(r.progress.perPg.find((p) => p.pg === 'PORTONE')).toMatchObject({ state: 'COMPLETED' });
    expect(f.paused).toEqual(['TOSS']);
    expect(f.raises).toEqual([expect.objectContaining({ severity: 'SEV2', reason: 'AUTO_CIRCUIT_OPEN', pg: 'TOSS' })]);
  });

  test('R-T45 ③_half_open·closed(거짓)는_계속하고_재개_뒤에도_서킷이_열려_있으면_바로_다시_멈춘다', async () => {
    let open = false;
    const f = fixture({ targets: [target(T1), target(T2, { pg: 'PORTONE' })], open: () => false });
    const r = await start(f.service);
    expect(f.calls).toHaveLength(2);
    expect(r.status).toBe('COMPLETED');
    expect(r.progress.perPg.map((p) => [p.pg, p.state])).toEqual([
      ['PORTONE', 'COMPLETED'],
      ['TOSS', 'COMPLETED'],
    ]);

    // 서킷이 열린 채로 다시 실행하면 새 호출 0·AUTO_CIRCUIT_OPEN
    open = true;
    const second = fixture({ targets: [target(T1)], open: () => open });
    await start(second.service);
    expect(second.calls).toHaveLength(0);
    expect(second.paused).toEqual(['TOSS']);
    // 재개해도 서킷이 열려 있으면 다시 멈춘다
    const resumed = await second.service.resume({ requestId: REQUEST, reason: '서킷 확인' });
    expect(resumed.status).toBe('PAUSED');
    expect(second.calls).toHaveLength(0);
    // 서킷이 닫히면 재개가 실제로 보낸다
    open = false;
    const done = await second.service.resume({ requestId: REQUEST, reason: '서킷 닫힘 확인' });
    expect(done.status).toBe('COMPLETED');
    expect(second.calls).toHaveLength(1);
  });
});
