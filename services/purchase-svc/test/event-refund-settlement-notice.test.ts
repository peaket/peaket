// J-T23 ① purchase-svc가 정산에 회차 취소·연기를 알리기(F-07-8 계획 I-04, ADR-0380 결정 1~3, transfer-refund §5 '정산 다시 계산 알리기').
// StartEventRefund 커밋 뒤 payment-svc 내부 `PUT /internal/v1/settlements/event-recalculations/{requestId}`(보류 열기)를 한 번 부르고,
// 요청이 COMPLETED가 된 뒤 `POST …/{requestId}/completion`(완료)을 한 번 부른다(보류 열기가 먼저 성공했을 때만).
// 실패는 확정·환급을 막지 않고 실행기 틱이 다시 부른다: 1분 → 5분 → 15분, 그 뒤 15분마다 [가정]. 확정 + 3영업일 [가정]이 지나도 COMPLETED가 아니면 partial: true로 한 번 완료를 알린다.
// 정산 포트는 대역(SettlementRecalculationPort를 implements, 실패 주입)이고, HTTP 어댑터는 내부 HTTP 클라이언트 대역으로 경로·머리·본문·오류를 본다.
// 단언 값은 정본·계획 값(1분·5분·15분, 3영업일, 3초)을 적고 경계 직전(−1ms)과 경계를 둘 다 잰다.
// 기준 트리: settlement 의존·HttpSettlementRecalculation이 없어 실패한다(계획 §7).
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { HttpSettlementRecalculation } from '../src/modules/refund/adapters/http-settlement-recalculation.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import type { SettlementRecalculationPort } from '../src/modules/refund/domain/event-refund-ports.js';
import type { EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';

const MINUTE = 60_000;
const DAY = 86_400_000;
/** 2026-11-23(월) 10:00 KST */
const MONDAY = Date.parse('2026-11-23T01:00:00.000Z');
/** 2026-11-27(금) 10:00 KST. + 3영업일 = 2026-12-02(수) 10:00 KST(달력 3일이면 월요일) */
const FRIDAY = Date.parse('2026-11-27T01:00:00.000Z');
const FRIDAY_PLUS_3BD = Date.parse('2026-12-02T01:00:00.000Z');
const REQUEST = '0194f078-0000-7000-8000-0000000000b1';
const EVENT = '0194f078-0000-7000-8000-0000000000b2';

const target = (n: number): EventRefundTarget => ({
  orderId: `0194f078-0000-7000-8000-0000000005${String(n).padStart(2, '0')}`,
  ticketId: `0194f078-0000-7000-8000-0000000006${String(n).padStart(2, '0')}`,
  seatId: `seat-${n}`,
  payerAccountId: '0194f078-0000-7000-8000-000000000007',
  ticketPrice: 47_500,
  bookedAtMs: MONDAY - DAY,
  saleEndsAtMs: MONDAY + 7 * DAY,
  pg: 'TOSS',
});

class RecordingSettlement implements SettlementRecalculationPort {
  readonly opens: { requestId: string; eventId: string; kind: 'CANCEL' | 'POSTPONE'; confirmedAt: Date; atMs: number }[] = [];
  readonly completes: { requestId: string; completedAt: Date; partial: boolean; atMs: number }[] = [];
  failOpen = 0;
  failComplete = 0;
  constructor(private readonly now: () => number) {}
  async open(input: { requestId: string; eventId: string; kind: 'CANCEL' | 'POSTPONE'; confirmedAt: Date }): Promise<void> {
    this.opens.push({ ...input, atMs: this.now() });
    if (this.failOpen > 0) {
      this.failOpen -= 1;
      throw new Error('payment-svc 503');
    }
  }
  async complete(requestId: string, input: { completedAt: Date; partial: boolean }): Promise<void> {
    this.completes.push({ requestId, ...input, atMs: this.now() });
    if (this.failComplete > 0) {
      this.failComplete -= 1;
      throw new Error('payment-svc 시간 초과');
    }
  }
}

function fixture(o: { start: number; open?: number; refunded?: boolean }) {
  const clock = { now: o.start };
  const store = new MemoryEventRefundStore();
  const world = { targets: [target(1)], open: o.open ?? 0 };
  const settlement = new RecordingSettlement(() => clock.now);
  const warns: { o: object; msg: string }[] = [];
  const cancels: string[] = [];
  const service = new EventRefundService({
    store,
    targets: { list: async () => world.targets },
    canceller: {
      cancel: async (t) => {
        cancels.push(t.ticketId);
        return { status: 'REFUNDED' };
      },
    },
    items: store,
    openOrders: { count: async () => world.open },
    settlement,
    log: { warn: (wo, msg) => void warns.push({ o: wo, msg }) },
    nowMs: () => clock.now,
    deadlineMs: () => clock.now + 5_000,
  });
  const at = (t: number) => (clock.now = t);
  const start = () => service.start({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
  return { clock, at, store, world, settlement, warns, cancels, service, start };
}

describe('J-T23 ① 정산 보류 열기·완료 알리기', () => {
  test('J-T23 ① 확정 뒤 보류 열기 한 번(요청·회차·CANCEL·확정 시각), 요청이 COMPLETED면 완료 한 번(partial false)', async () => {
    const f = fixture({ start: MONDAY });
    const r = await f.start();
    expect(r.status).toBe('COMPLETED');
    expect(f.settlement.opens).toEqual([{ requestId: REQUEST, eventId: EVENT, kind: 'CANCEL', confirmedAt: new Date(MONDAY), atMs: MONDAY }]);
    expect(f.settlement.completes.map((c) => ({ requestId: c.requestId, completedAt: c.completedAt.toISOString(), partial: c.partial }))).toEqual([{ requestId: REQUEST, completedAt: new Date(MONDAY).toISOString(), partial: false }]);
    // 다시 돌려도 더 부르지 않는다
    f.at(MONDAY + 30 * MINUTE);
    await f.service.runDue();
    await f.service.runDue();
    expect(f.settlement.opens).toHaveLength(1);
    expect(f.settlement.completes).toHaveLength(1);
  });

  test('J-T23 ① 같은 요청을 다시 확정해도 보류 열기는 한 번이다', async () => {
    const f = fixture({ start: MONDAY, open: 1 });
    await f.start();
    await f.start();
    expect(f.settlement.opens).toHaveLength(1);
    expect(f.settlement.completes).toEqual([]);
  });

  test('J-T23 ① RUNNING 동안은 완료를 부르지 않고, COMPLETED가 된 틱 뒤에 한 번 부른다', async () => {
    const f = fixture({ start: MONDAY, open: 1 });
    expect((await f.start()).status).toBe('RUNNING');
    expect(f.settlement.completes).toEqual([]);
    f.at(MONDAY + 10 * MINUTE);
    f.world.open = 0;
    await f.service.runDue();
    expect((await f.service.get(REQUEST)).status).toBe('COMPLETED');
    await f.service.runDue();
    expect(f.settlement.completes).toEqual([expect.objectContaining({ requestId: REQUEST, partial: false })]);
  });

  // F-15: payment 내부 경로 503·시간 초과 → purchase가 다시 하고, 환급은 계속한다. F-06: 1분·5분·15분 − 1ms
  test('J-T23 ① 보류 열기가 실패해도 환급은 끝나고, 실행기 틱이 1분·5분·15분·15분 간격으로 다시 부르며(− 1ms에는 안 부름) 경고 로그는 요청 ID만 싣는다', async () => {
    const f = fixture({ start: MONDAY, open: 1 });
    f.settlement.failOpen = 99;
    await f.start();
    expect(f.cancels).toEqual([target(1).ticketId]);
    expect((await f.store.items(REQUEST)).map((i) => i.status)).toEqual(['REFUNDED']);
    expect(f.settlement.opens).toHaveLength(1);
    const failedLogs = f.warns.filter((w) => JSON.stringify(w).includes('event-refund-settlement-notice-failed'));
    expect(failedLogs.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(failedLogs[0])).toContain(REQUEST);
    expect(JSON.stringify(failedLogs[0])).not.toContain(EVENT);
    let t = MONDAY;
    for (const gap of [1 * MINUTE, 5 * MINUTE, 15 * MINUTE, 15 * MINUTE]) {
      const before = f.settlement.opens.length;
      f.at(t + gap - 1);
      await f.service.runDue();
      expect(f.settlement.opens, `${gap / MINUTE}분 − 1ms`).toHaveLength(before);
      f.at(t + gap);
      await f.service.runDue();
      expect(f.settlement.opens, `${gap / MINUTE}분`).toHaveLength(before + 1);
      t += gap;
    }
    expect(f.settlement.completes).toEqual([]);
  });

  test('J-T23 ① 보류 열기가 먼저 실패하고 요청이 COMPLETED가 됐으면, 다시 한 보류 열기가 성공한 뒤에만 완료를 부른다', async () => {
    const f = fixture({ start: MONDAY });
    f.settlement.failOpen = 1;
    expect((await f.start()).status).toBe('COMPLETED');
    expect(f.settlement.completes).toEqual([]);
    f.at(MONDAY + MINUTE);
    await f.service.runDue();
    await f.service.runDue();
    expect(f.settlement.opens).toHaveLength(2);
    expect(f.settlement.completes).toEqual([expect.objectContaining({ requestId: REQUEST, partial: false })]);
  });

  test('J-T23 ① 완료 알리기가 실패하면 1분 뒤 다시 부르고, 성공하면 더 부르지 않는다', async () => {
    const f = fixture({ start: MONDAY });
    f.settlement.failComplete = 1;
    await f.start();
    expect(f.settlement.completes).toHaveLength(1);
    f.at(MONDAY + MINUTE - 1);
    await f.service.runDue();
    expect(f.settlement.completes).toHaveLength(1);
    f.at(MONDAY + MINUTE);
    await f.service.runDue();
    expect(f.settlement.completes).toHaveLength(2);
    f.at(MONDAY + 20 * MINUTE);
    await f.service.runDue();
    expect(f.settlement.completes).toHaveLength(2);
  });

  // F-07: 확정 + 3영업일 − 1ms 부분 완료 없음·3영업일 한 번. 금요일 확정이라 달력 3일(월요일)이 아니라 수요일이다
  test('J-T23 ① 금요일 확정 + 3영업일(수요일)이 지나도 COMPLETED가 아니면 partial: true 완료를 한 번 부르고, 월요일·수요일 − 1ms에는 부르지 않는다', async () => {
    const f = fixture({ start: FRIDAY, open: 1 });
    expect((await f.start()).status).toBe('RUNNING');
    f.at(Date.parse('2026-11-30T01:00:00.000Z'));
    await f.service.runDue();
    f.at(FRIDAY_PLUS_3BD - 1);
    await f.service.runDue();
    expect(f.settlement.completes).toEqual([]);
    f.at(FRIDAY_PLUS_3BD);
    await f.service.runDue();
    expect(f.settlement.completes.map((c) => ({ requestId: c.requestId, partial: c.partial, completedAt: c.completedAt.toISOString() }))).toEqual([{ requestId: REQUEST, partial: true, completedAt: new Date(FRIDAY_PLUS_3BD).toISOString() }]);
    expect(f.warns.some((w) => JSON.stringify(w).includes('event-refund-settlement-partial'))).toBe(true);
    f.at(FRIDAY_PLUS_3BD + 30 * MINUTE);
    await f.service.runDue();
    f.world.open = 0;
    await f.service.runDue();
    expect(f.settlement.completes).toHaveLength(1);
  });

  test('J-T23 ① 연기(POSTPONE)는 확정 때 보류 열기(kind POSTPONE)이고, 신청 창이 닫혀 COMPLETED가 된 뒤에 완료를 부른다', async () => {
    const f = fixture({ start: MONDAY });
    await f.service.start({ eventId: EVENT, requestId: REQUEST, fault: 'CONTENT_CHANGE', ruledBy: 'commander-1', confirmedBy: 'operator-2', kind: 'POSTPONE', postponedToMs: MONDAY + 7 * DAY, refundWindowClosesAtMs: MONDAY + 3 * DAY });
    expect(f.settlement.opens).toEqual([expect.objectContaining({ requestId: REQUEST, eventId: EVENT, kind: 'POSTPONE' })]);
    f.at(MONDAY + DAY);
    await f.service.runDue();
    expect(f.settlement.completes).toEqual([]);
    await f.service.closeWindow({ requestId: REQUEST, reason: '신청 마감', closedBy: 'operator-2' });
    expect((await f.service.get(REQUEST)).status).toBe('COMPLETED');
    await f.service.runDue();
    expect(f.settlement.completes).toEqual([expect.objectContaining({ requestId: REQUEST, partial: false })]);
  });
});

describe('J-T23 ① 정산 알리기 HTTP 어댑터(HttpSettlementRecalculation)', () => {
  const client = (status: number | 'throw') => {
    const calls: { method: string; path: string; params?: Readonly<Record<string, string | number>>; headers?: Readonly<Record<string, string>>; body?: string; timeoutCapMs?: number }[] = [];
    return {
      calls,
      client: {
        request: async (r: { method: string; path: string; params?: Readonly<Record<string, string | number>>; headers?: Readonly<Record<string, string>>; body?: string | Uint8Array; timeoutCapMs?: number }) => {
          calls.push({ method: r.method, path: r.path, ...(r.params ? { params: r.params } : {}), ...(r.headers ? { headers: r.headers } : {}), ...(typeof r.body === 'string' ? { body: r.body } : {}), ...(r.timeoutCapMs === undefined ? {} : { timeoutCapMs: r.timeoutCapMs }) });
          if (status === 'throw') throw Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:8080'), { code: 'ETIMEDOUT' });
          return new Response(JSON.stringify({ requestId: REQUEST }), { status, headers: { 'content-type': 'application/json' } });
        },
      },
    };
  };
  const resolvedPath = (c: { path: string; params?: Readonly<Record<string, string | number>> }) => c.path.replace(/\{(\w+)\}/g, (_m, k: string) => String(c.params?.[k] ?? `{${k}}`));

  test('J-T23 ① 보류 열기는 PUT …/event-recalculations/{requestId}, 내부 토큰 머리, 본문 { eventId, kind, confirmedAt }, 시간 한도 3초다', async () => {
    const c = client(200);
    const port = new HttpSettlementRecalculation(c.client, 'internal-f078');
    await port.open({ requestId: REQUEST, eventId: EVENT, kind: 'CANCEL', confirmedAt: new Date(MONDAY) });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.method).toBe('PUT');
    expect(resolvedPath(c.calls[0]!)).toBe(`/internal/v1/settlements/event-recalculations/${REQUEST}`);
    expect(c.calls[0]!.headers?.['x-peaket-internal-token']).toBe('internal-f078');
    expect(JSON.parse(c.calls[0]!.body!)).toEqual({ eventId: EVENT, kind: 'CANCEL', confirmedAt: new Date(MONDAY).toISOString() });
    expect(c.calls[0]!.timeoutCapMs).toBe(3_000);
  });

  test('J-T23 ① 완료는 POST …/{requestId}/completion, 본문 { completedAt, partial }', async () => {
    const c = client(200);
    const port = new HttpSettlementRecalculation(c.client, 'internal-f078');
    await port.complete(REQUEST, { completedAt: new Date(FRIDAY), partial: true });
    expect(c.calls[0]!.method).toBe('POST');
    expect(resolvedPath(c.calls[0]!)).toBe(`/internal/v1/settlements/event-recalculations/${REQUEST}/completion`);
    expect(JSON.parse(c.calls[0]!.body!)).toEqual({ completedAt: new Date(FRIDAY).toISOString(), partial: true });
  });

  test('J-T23 ① 503·시간 초과는 SettlementNoticeError로 던지고 메시지에는 요청 ID만 있다(회차 ID·주소 없음)', async () => {
    for (const status of [503, 'throw'] as const) {
      const c = client(status);
      const port = new HttpSettlementRecalculation(c.client, 'internal-f078');
      const err = await port.open({ requestId: REQUEST, eventId: EVENT, kind: 'CANCEL', confirmedAt: new Date(MONDAY) }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, String(status)).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('SettlementNoticeError');
      expect((err as Error).message).toContain(REQUEST);
      expect((err as Error).message).not.toContain(EVENT);
      expect((err as Error).message).not.toContain('10.0.0.1');
    }
  });
});
