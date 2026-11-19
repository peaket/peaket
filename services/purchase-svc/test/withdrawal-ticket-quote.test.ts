// 탈퇴 전 결제한 미사용 티켓의 견적(application/account-withdrawal-tickets.ts AccountWithdrawalTickets.quote,
// docs/features/payment.md §4.1 '미사용 티켓 견적', docs/features/identity.md §8 '미사용 티켓 확인과 취소' 확인(견적),
// docs/planning/03 §1.5 ①, ADR-0284 결정 7, POL-032, BUILD_ORDER PRF-174, I-T26 ①, BAT-013 시험 담당).
//
// 약속:
// - 값은 정본(POL-032, payment §4.1 '공제액과 환급액의 끝수')에서 적는다: 33,333원의 10% = 3,333/30,000, 20% = 6,666/26,667,
//   30% = 9,999/23,334, 90% = 29,999/3,334. 구간은 관람일 10·9·7·6·3·2·1·0일 전이고, 예매 뒤 영업시간 24시간 이내(공연 3일 전까지)는 공제가 없다.
// - 저장소가 돌려준 표(그 계정이 결제했고 취소 기록이 없고 주문이 CONFIRMED·PARTIALLY_REFUNDED)를 회차 판매 설정으로 가격 매긴다.
//   취소 기록·다른 계정·주문 상태로 거르는 SQL은 test-int/withdrawal-participant.int.test.ts가 실제 PostgreSQL로 본다.
// - 시계는 가짜 하나이고, 값이 코드 상수와 겹치지 않게 기준 시각은 60초·2초 같은 상수의 배수가 아닌 곳에서 시작한다.
import { describe, expect, test } from 'vitest';
import { WithdrawalOrdersUnavailable, type UnusedTicketsQuote } from '../src/modules/booking/index.js';
import { AccountWithdrawalTickets, type WithdrawalTicket, WeekendBusinessCalendar, withdrawalTicketCancellationId } from '../src/modules/refund/index.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** 기준 시각: 2026-11-19(목) 10:23:45.678 KST. 60초·2초의 배수가 아니다 */
const NOW = Date.parse('2026-11-19T01:23:45.678Z');
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000026a1';
const PRICE = 33_333;

interface EventConfig {
  saleEndsAtMs: number;
  entryOpensAtMs?: number;
}
interface QuoteCall {
  accountId: string;
  statementTimeoutMs: number;
}
interface CancelCall {
  accountId: string;
  ticketId: string;
  cancellationId: string;
  reason: string;
  nowMs: number;
  deadlineMs: number;
}

let seq = 0;
const row = (eventId: string, o: { price?: number; bookedAtMs?: number } = {}): WithdrawalTicket => ({
  ticketId: `0190f3a1-7c2e-7a00-8000-${String(100 + seq++).padStart(12, '0')}`,
  orderId: `0190f3a1-7c2e-7a00-8000-${String(500 + seq++).padStart(12, '0')}`,
  eventId,
  ticketPrice: o.price ?? PRICE,
  bookedAtMs: o.bookedAtMs ?? NOW - 20 * DAY,
});

/** 회차 시작(한국 12:00) → 판매 종료(24시간 전). entryOpensAt은 시험마다 정한다 */
const eventAt = (eventStartsAtMs: number, entryOpensAtMs?: number): EventConfig => ({
  saleEndsAtMs: eventStartsAtMs - DAY,
  ...(entryOpensAtMs !== undefined ? { entryOpensAtMs } : {}),
});
/** 기준일(2026-11-19)에서 N일 뒤의 한국 12:00(03:00Z). N=0은 같은 날 12:00이라 아직 공연 전이다 */
const startDaysAfter = (days: number): number => Date.parse('2026-11-19T03:00:00Z') + days * DAY;

function harness(o: { rows?: WithdrawalTicket[] | Error; configs?: Map<string, EventConfig>; withCancelTicket?: boolean; store?: (q: { accountId: string; statementTimeoutMs: number }) => Promise<WithdrawalTicket[]> } = {}) {
  const reads: QuoteCall[] = [];
  const cancels: CancelCall[] = [];
  const configs = o.configs ?? new Map<string, EventConfig>();
  const service = new AccountWithdrawalTickets({
    store: {
      unusedTicketsOf: async (accountId, q) => {
        reads.push({ accountId, statementTimeoutMs: q.statementTimeoutMs });
        if (o.store) return o.store({ accountId, statementTimeoutMs: q.statementTimeoutMs });
        if (o.rows instanceof Error) throw o.rows;
        return o.rows ?? [];
      },
      pendingRefunds: async () => 0,
      cancellationStatus: async () => undefined,
    },
    configs: { config: async (eventId) => configs.get(eventId) },
    calendar: new WeekendBusinessCalendar(),
    // 견적은 취소할 수 있는 조립(ticket-svc 주소 있음)에서만 난다
    ...(o.withCancelTicket === false
      ? {}
      : {
          cancelTicket: {
            execute: async (i: CancelCall): Promise<{ status: 'ACCEPTED'; cancellationId: string; refundAmount: number; refundAfterEntryClose: boolean }> => {
              cancels.push(i);
              return { status: 'ACCEPTED', cancellationId: i.cancellationId, refundAmount: 0, refundAfterEntryClose: false };
            },
          },
        }),
  });
  const quote = (nowMs = NOW, statementTimeoutMs = 400): Promise<UnusedTicketsQuote> => service.quote({ accountId: ACCOUNT, nowMs, statementTimeoutMs });
  return { service, reads, cancels, quote };
}

/** 표 한 장짜리 견적: 관람일 N일 전(공연 시작은 그날 12:00 KST) */
async function quoteOne(daysBefore: number, o: { price?: number; nowMs?: number; entryOpensAtMs?: number } = {}) {
  const eventId = `ev-${daysBefore}-${seq++}`;
  const eventStartsAtMs = startDaysAfter(daysBefore);
  const configs = new Map([[eventId, eventAt(eventStartsAtMs, o.entryOpensAtMs)]]);
  const h = harness({ rows: [row(eventId, { ...(o.price !== undefined ? { price: o.price } : {}) })], configs });
  return { q: await h.quote(o.nowMs ?? NOW), h, eventStartsAtMs };
}

describe('POL-032 구간과 끝수(I-T26 ①)', () => {
  const CASES: Array<[number, number, number]> = [
    // [관람일 N일 전, 공제액, 환급액]
    [10, 0, 33_333],
    [9, 3_333, 30_000],
    [7, 3_333, 30_000],
    [6, 6_666, 26_667],
    [3, 6_666, 26_667],
    [2, 9_999, 23_334],
    [1, 9_999, 23_334],
    [0, 29_999, 3_334],
  ];

  test.each(CASES)('I-T26①_관람일%d일전이면공제%d원·환급%d원이고_결제금액은권면가33333원이다', async (days, deduction, refund) => {
    const { q } = await quoteOne(days);
    // 관람일 당일 12:00은 지금(10:23)보다 뒤라 공연 전이지만 양도 마감(2시간 전 10:00)은 지났다
    expect(q).toEqual({ count: 1, ticketAmount: 33_333, deductionAmount: deduction, refundAmount: refund, transferableCount: days === 0 ? 0 : 1, deferredRefundCount: 0 });
  });

  test('I-T26①_공제액은원미만을버린다(100원10%=10원·99원10%=9원·1원90%=0원)', async () => {
    const ten = await quoteOne(9, { price: 100 });
    expect(ten.q).toMatchObject({ deductionAmount: 10, refundAmount: 90 });
    const almost = await quoteOne(9, { price: 99, nowMs: Date.parse('2026-11-20T04:00:00Z') });
    expect(almost.q).toMatchObject({ deductionAmount: 9, refundAmount: 90 });
    const ninety = await quoteOne(0, { price: 1 });
    expect(ninety.q).toMatchObject({ deductionAmount: 0, refundAmount: 1 });
  });

  test('I-T26①_예매뒤영업시간24시간이내이고공연3일전까지면공제가없다_24시간정각은없음_1ms넘으면20%다', async () => {
    // 공연 4일 뒤(11/23 월 12:00), 예매 11/19 목 10:00, 지금 11/20 금 10:00(영업일 24시간 정각)
    const eventStartsAtMs = startDaysAfter(4);
    const eventId = `ev-24h-${seq++}`;
    const bookedAtMs = Date.parse('2026-11-19T01:00:00Z');
    const configs = new Map([[eventId, eventAt(eventStartsAtMs)]]);
    const h = harness({ rows: [row(eventId, { bookedAtMs })], configs });
    const at24 = await h.quote(Date.parse('2026-11-20T01:00:00Z'));
    expect(at24).toEqual({ count: 1, ticketAmount: 33_333, deductionAmount: 0, refundAmount: 33_333, transferableCount: 1, deferredRefundCount: 0 });
    const over = await h.quote(Date.parse('2026-11-20T01:00:00.001Z'));
    expect(over).toMatchObject({ deductionAmount: 6_666, refundAmount: 26_667 });
  });

  test('I-T26①_24시간특례는공연3일전까지만이다(2일전이면24시간이내여도30%)', async () => {
    // 공연 11/20(금) 12:00, 지금 11/18(수) 10:00 → 관람일 2일 전이라 24시간 특례 밖이다
    const now = Date.parse('2026-11-18T01:00:00Z');
    const eventId = `ev-2days-${seq++}`;
    const h = harness({ rows: [row(eventId, { bookedAtMs: now - 12 * HOUR })], configs: new Map([[eventId, eventAt(Date.parse('2026-11-20T03:00:00Z'))]]) });
    expect(await h.quote(now)).toMatchObject({ deductionAmount: 9_999, refundAmount: 23_334 });
  });
});

describe('표 고르기와 회차 설정(I-T26 ①)', () => {
  test('I-T26①_표가없으면모든칸이0이고저장소를그계정으로한번읽는다', async () => {
    const h = harness({ rows: [] });
    expect(await h.quote()).toEqual({ count: 0, ticketAmount: 0, deductionAmount: 0, refundAmount: 0, transferableCount: 0, deferredRefundCount: 0 });
    expect(h.reads).toEqual([{ accountId: ACCOUNT, statementTimeoutMs: 400 }]);
  });

  test('I-T26①_공연이시작됐거나이미끝난표는견적에서빼고_남은표만센다', async () => {
    const started = `ev-started-${seq++}`;
    const live = `ev-live-${seq++}`;
    const configs = new Map([
      [started, eventAt(NOW - 1)],
      [live, eventAt(startDaysAfter(7))],
    ]);
    const h = harness({ rows: [row(started), row(live)], configs });
    expect(await h.quote()).toEqual({ count: 1, ticketAmount: 33_333, deductionAmount: 3_333, refundAmount: 30_000, transferableCount: 1, deferredRefundCount: 0 });
  });

  test('I-T26①_판매설정(회차시각)을읽지못한표가있으면낮은금액을보이지않고WithdrawalOrdersUnavailable이다', async () => {
    const eventId = `ev-missing-${seq++}`;
    const h = harness({ rows: [row(eventId)], configs: new Map() });
    await expect(h.quote()).rejects.toBeInstanceOf(WithdrawalOrdersUnavailable);
  });

  test('I-T26①_ticket-svc주소가없는조립은견적을내지않는다(취소할수없는표를안내하지않는다)', async () => {
    const eventId = `ev-no-ticket-${seq++}`;
    const h = harness({ rows: [row(eventId)], configs: new Map([[eventId, eventAt(startDaysAfter(7))]]), withCancelTicket: false });
    await expect(h.quote()).rejects.toBeInstanceOf(WithdrawalOrdersUnavailable);
  });

  test('I-T26①_저장소가던진일시오류는그대로WithdrawalOrdersUnavailable이고_그밖의오류는그대로던진다', async () => {
    const down = harness({ rows: new WithdrawalOrdersUnavailable(new Error('연결 끊김')) });
    await expect(down.quote()).rejects.toBeInstanceOf(WithdrawalOrdersUnavailable);
    const boom = new Error('SQL 문법 오류(주입)');
    const broken = harness({ rows: boom });
    await expect(broken.quote()).rejects.toBe(boom);
  });
});

describe('양도 가능·마감 뒤 환급(I-T26 ①)', () => {
  test('I-T26①_양도마감(공연2시간전과입장시작가운데이른때)전이면양도가능이고_입장이시작됐으면마감뒤환급으로센다', async () => {
    // 입장 시작 전: 공연 7일 뒤, 입장 시작은 공연 2시간 전보다 뒤(공연 1시간 전)
    const before = await quoteOne(7, { entryOpensAtMs: startDaysAfter(7) - HOUR });
    expect(before.q).toMatchObject({ count: 1, transferableCount: 1, deferredRefundCount: 0 });
    // 입장 시작 1ms 전: 아직 환급을 미루지 않는다
    const justBefore = await quoteOne(7, { entryOpensAtMs: NOW + 1 });
    expect(justBefore.q).toMatchObject({ transferableCount: 1, deferredRefundCount: 0 });
    // 입장 시작 정각: 환급은 입장 기록 마감 뒤로 미루고, 양도는 마감(입장 시작)이라 할 수 없다
    const atEntry = await quoteOne(7, { entryOpensAtMs: NOW });
    expect(atEntry.q).toMatchObject({ count: 1, transferableCount: 0, deferredRefundCount: 1 });
  });

  test('I-T26①_입장시작이공연2시간전보다이르면양도마감은입장시작이고_아니면공연2시간전이다', async () => {
    // 공연 7일 뒤: 마감은 공연 2시간 전. 그 1ms 전은 가능, 정각은 불가
    const eventId = `ev-transfer-${seq++}`;
    const eventStartsAtMs = startDaysAfter(7);
    const configs = new Map([[eventId, eventAt(eventStartsAtMs)]]);
    const h = harness({ rows: [row(eventId)], configs });
    const deadline = eventStartsAtMs - 2 * HOUR;
    expect(await h.quote(deadline - 1)).toMatchObject({ transferableCount: 1 });
    expect(await h.quote(deadline)).toMatchObject({ transferableCount: 0 });
    // 입장 시작이 공연 2시간 전보다 이르면(공연 3시간 전) 그때가 마감이다
    const earlyEntry = `ev-transfer-entry-${seq++}`;
    const earlyConfigs = new Map([[earlyEntry, eventAt(eventStartsAtMs, eventStartsAtMs - 3 * HOUR)]]);
    const eh = harness({ rows: [row(earlyEntry)], configs: earlyConfigs });
    expect(await eh.quote(eventStartsAtMs - 3 * HOUR - 1)).toMatchObject({ transferableCount: 1, deferredRefundCount: 0 });
    expect(await eh.quote(eventStartsAtMs - 3 * HOUR)).toMatchObject({ transferableCount: 0, deferredRefundCount: 1 });
  });

  test('I-T26①_여러표의값을더한다(결제금액·공제액·환급액·양도가능·마감뒤환급)', async () => {
    const a = `ev-sum-a-${seq++}`;
    const b = `ev-sum-b-${seq++}`;
    const configs = new Map([
      [a, eventAt(startDaysAfter(7))],
      [b, eventAt(NOW + 2 * HOUR, NOW - HOUR)],
    ]);
    // a: 공연 7일 전이라 10% 공제(33,333 → 3,333/30,000), b: 입장 시작 뒤라 90% 공제(33,333 → 29,999/3,334)
    const h = harness({ rows: [row(a), row(b, { price: 33_333 })], configs });
    expect(await h.quote()).toEqual({ count: 2, ticketAmount: 66_666, deductionAmount: 33_332, refundAmount: 33_334, transferableCount: 1, deferredRefundCount: 1 });
  });
});

describe('취소 ID는 표마다 고정 UUID다(I-T26 ②의 멱등)', () => {
  test('I-T26②_같은표는늘같은취소ID이고_표가다르면다르며_8-4-4-4-12 UUID 모양이다', () => {
    const ticket = '0190f3a1-7c2e-7a00-8000-0000000026b1';
    const id = withdrawalTicketCancellationId(ticket);
    expect(withdrawalTicketCancellationId(ticket)).toBe(id);
    expect(withdrawalTicketCancellationId('0190f3a1-7c2e-7a00-8000-0000000026b2')).not.toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // 버전 8(사용자 정의)과 RFC 4122 변형
    expect(id[14]).toBe('8');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
    // 결제사 멱등키(cancel-{취소 ID})가 9~64자의 ASCII 규격을 넘지 않는다(payment §6)
    expect(`cancel-${id}`.length).toBe(43);
  });
});
