// 부정 예매 운영자 취소 쓰임새(fraud_cancellation.proto CancelFraudTickets·GetFraudCancellation, docs/features/transfer-refund.md §7.4 'purchase-svc·ticket-svc 쪽 세부',
// POL-032·POL-046, ADR-0171·ADR-0197, BUILD_ORDER GAT-080, BAT-415 몫 F). DB 없이 포트 가짜로 돈다. 실제 DB·ticket-svc·payment-svc는 test-int/fraud-cancellation.int.test.ts가 본다.
// 정본 값을 글자로 적는다: 대상 1~500장, 128자, 취소 마감 = 판매 종료 − 2시간(정각부터 막음), 공제 0원(권면 33,333원 그대로).
// 지금(2026-11-16 10:00)은 공연(2026-11-20 19:00) 4일 전이라 팬 취소(USER)였다면 20% 공제인 날이다. 공제를 켠 틀린 구현이 드러난다.
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  CancelFraudTickets,
  type CancelFraudTicketsInput,
  type CancellationOrderView,
  type CancellationWriteOutcome,
  type CancellationWrites,
  FraudCancellationError,
  type FraudCancellationRequestRecord,
  type FraudCancellationStore,
  type FraudCancelTarget,
  type FraudRefundProgress,
  type FraudTicketResult,
  fraudCancelDeadlineMs,
  fraudCancellationId,
  fraudTargetsFingerprint,
  GetFraudCancellation,
  type OperatorTicketCancellations,
  type OperatorTicketOutcome,
  type OperatorTicketResult,
  type SeatReturns,
  WeekendBusinessCalendar,
} from '../src/modules/refund/index.js';

const kst = (s: string): number => Date.parse(`${s}+09:00`);
const EVENT_STARTS = kst('2026-11-20T19:00:00');
const SALE_ENDS = kst('2026-11-19T19:00:00');
const NOW = kst('2026-11-16T10:00:00');
const EVENT = randomUUID();
const OTHER_EVENT = randomUUID();
const ORDER = randomUUID();
const PAYER = randomUUID();
const RECIPIENT = randomUUID();
const APPROVAL = randomUUID();
const FRAUD_CASE = randomUUID();
const PRICE = 33_333;
const calendar = new WeekendBusinessCalendar();

/** 표 하나: 주문 ORDER, 결제자 PAYER, 권면 33,333원 */
interface Seat {
  readonly ticketId: string;
  readonly seatId: string;
  readonly eventId: string;
}
const seat = (eventId = EVENT): Seat => ({ ticketId: randomUUID(), seatId: randomUUID(), eventId });
const viewOf = (s: Seat): CancellationOrderView => ({
  orderId: ORDER,
  eventId: s.eventId,
  ticketId: s.ticketId,
  seatId: s.seatId,
  payerAccountId: PAYER,
  ticketPrice: PRICE,
  bookedAtMs: kst('2026-11-01T10:00:00'),
  saleEndsAtMs: SALE_ENDS,
  entryOpensAtMs: kst('2026-11-20T18:00:00'),
  orderStatus: 'CONFIRMED',
});

/** 결과 저장소 가짜: 승인 ID마다 요청 기록과 (승인, 표) 결과 */
class Store implements FraudCancellationStore {
  readonly requests = new Map<string, FraudCancellationRequestRecord>();
  readonly saved = new Map<string, Map<string, FraudTicketResult & { readonly expectedHolderAccountId: string }>>();
  readonly saves: { approvalId: string; ticketIds: string[] }[] = [];
  refundRows: FraudRefundProgress[] = [];
  async find(approvalId: string): Promise<FraudCancellationRequestRecord | undefined> {
    return this.requests.get(approvalId);
  }
  async create(r: FraudCancellationRequestRecord): Promise<{ readonly status: 'CREATED' } | { readonly status: 'EXISTS'; readonly record: FraudCancellationRequestRecord }> {
    const existing = this.requests.get(r.approvalId);
    if (existing) return { status: 'EXISTS', record: existing };
    this.requests.set(r.approvalId, r);
    return { status: 'CREATED' };
  }
  async results(approvalId: string): Promise<readonly FraudTicketResult[]> {
    return [...(this.saved.get(approvalId)?.values() ?? [])].map(({ expectedHolderAccountId: _h, ...rest }) => rest);
  }
  async saveResults(approvalId: string, results: readonly (FraudTicketResult & { readonly expectedHolderAccountId: string })[]): Promise<void> {
    const m = this.saved.get(approvalId) ?? new Map();
    for (const r of results) m.set(r.ticketId, r);
    this.saved.set(approvalId, m);
    this.saves.push({ approvalId, ticketIds: results.map((r) => r.ticketId) });
  }
  async refunds(): Promise<readonly FraudRefundProgress[]> {
    return this.refundRows;
  }
}

/** ticket-svc OperatorCancelTickets 가짜: (승인, 표)마다 처음 결과를 기억한다(ticket-svc 멱등과 같다) */
class Tickets implements OperatorTicketCancellations {
  readonly calls: Parameters<OperatorTicketCancellations['operatorCancel']>[0][] = [];
  readonly results = new Map<string, OperatorTicketResult>();
  readonly recorded = new Map<string, OperatorTicketOutcome>();
  failNext = 0;
  async operatorCancel(q: Parameters<OperatorTicketCancellations['operatorCancel']>[0]): Promise<readonly OperatorTicketOutcome[]> {
    this.calls.push({ ...q, targets: q.targets.map((t) => ({ ...t })) });
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('ticket-svc UNAVAILABLE');
    }
    return q.targets.map((t) => {
      const key = `${q.approvalId}:${t.ticketId}`;
      const seen = this.recorded.get(key);
      if (seen) return seen;
      const out: OperatorTicketOutcome = { ticketId: t.ticketId, result: this.results.get(t.ticketId) ?? 'CANCELED', orderId: ORDER };
      this.recorded.set(key, out);
      return out;
    });
  }
}

class Seats implements SeatReturns {
  readonly calls: Parameters<SeatReturns['returnSold']>[0][] = [];
  readonly failFor = new Map<string, number>();
  async returnSold(q: Parameters<SeatReturns['returnSold']>[0]): Promise<number> {
    this.calls.push(q);
    const left = this.failFor.get(q.seatId) ?? 0;
    if (left > 0) {
      this.failFor.set(q.seatId, left - 1);
      throw new Error('좌석 되돌리기 실패');
    }
    return 1;
  }
}

class Writes implements CancellationWrites {
  readonly created: Parameters<CancellationWrites['create']>[0][] = [];
  readonly updates: Parameters<CancellationWrites['updateStatus']>[0][] = [];
  readonly answers = new Map<string, CancellationWriteOutcome | 'THROW'>();
  readonly byId = new Map<string, number>();
  async create(q: Parameters<CancellationWrites['create']>[0]): Promise<CancellationWriteOutcome> {
    this.created.push(q);
    const a = this.answers.get(q.ticketId);
    if (a === 'THROW') throw new Error('주문 상태 전이 실패');
    if (a) return a;
    const before = this.byId.get(q.cancellationId);
    if (before !== undefined) return { status: 'REPLAYED', cancellationId: q.cancellationId, refundAmount: before, state: 'REFUND_PENDING', refundAfterEntryClose: false, refundAttempts: 0 };
    this.byId.set(q.cancellationId, q.refundAmount);
    return { status: 'CREATED' };
  }
  async updateStatus(q: Parameters<CancellationWrites['updateStatus']>[0]): Promise<void> {
    this.updates.push(q);
  }
  async scheduleRefundRetry(): Promise<void> {}
  async markRefundFailed(): Promise<void> {}
  async dueRefunds(): Promise<[]> {
    return [];
  }
}

function fixture(seats: readonly Seat[], o: { configMissing?: boolean } = {}) {
  const views = new Map(seats.map((s) => [s.ticketId, viewOf(s)]));
  const store = new Store();
  const tickets = new Tickets();
  const seatReturns = new Seats();
  const writes = new Writes();
  const uc = new CancelFraudTickets({
    store,
    tickets,
    orders: { findByTicket: async (id) => views.get(id), findCancellation: async () => undefined },
    configs: { config: async (eventId) => (o.configMissing || eventId !== EVENT ? undefined : { saleEndsAtMs: SALE_ENDS, entryOpensAtMs: kst('2026-11-20T18:00:00') }) },
    writes,
    calendar,
    seats: seatReturns,
  });
  return { uc, store, tickets, seats: seatReturns, writes, views };
}

const input = (targets: readonly FraudCancelTarget[], over: Partial<CancelFraudTicketsInput> = {}): CancelFraudTicketsInput => ({
  approvalId: APPROVAL,
  fraudCaseId: FRAUD_CASE,
  eventId: EVENT,
  targets,
  requestedBy: 'investigator-1',
  approvedBy: 'commander-2',
  approvedAtMs: NOW - 60_000,
  nowMs: NOW,
  deadlineMs: 5_000,
  ...over,
});
const t = (s: Seat, holder = PAYER): FraudCancelTarget => ({ ticketId: s.ticketId, expectedHolderAccountId: holder });

/** 정본 공식을 시험에서 따로 계산한다: sha256("FraudCancel:{승인}:{표}") 앞 16바이트, 버전 8·RFC 변형 비트 */
const expectedCancellationId = (approvalId: string, ticketId: string): string => {
  const b = Buffer.from(createHash('sha256').update(`FraudCancel:${approvalId}:${ticketId}`).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const rejectsWith = async (p: Promise<unknown>, code: FraudCancellationError['code'], name?: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, name).toBeInstanceOf(FraudCancellationError);
  expect((err as FraudCancellationError).code, name).toBe(code);
};

describe('GAT-080 몫 F 부정 예매 운영자 취소: 값', () => {
  test('GAT-080 F8 취소 ID는 승인·표에서 정해지는 UUID 버전 8이다(같은 입력 같은 값, 승인·표가 다르면 다른 값)', () => {
    const a = randomUUID();
    const ticket = randomUUID();
    expect(fraudCancellationId(a, ticket)).toBe(expectedCancellationId(a, ticket));
    expect(fraudCancellationId(a, ticket)).toBe(fraudCancellationId(a, ticket));
    expect(fraudCancellationId(a, ticket)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(fraudCancellationId(randomUUID(), ticket)).not.toBe(fraudCancellationId(a, ticket));
    expect(fraudCancellationId(a, randomUUID())).not.toBe(fraudCancellationId(a, ticket));
  });

  test('GAT-080 F10 취소 마감은 판매 종료 − 2시간(7,200,000ms)이다', () => {
    expect(fraudCancelDeadlineMs(SALE_ENDS)).toBe(kst('2026-11-19T17:00:00'));
    expect(fraudCancelDeadlineMs(SALE_ENDS)).toBe(EVENT_STARTS - 26 * 3_600_000);
  });

  test('GAT-080 F11 지문은 대상 순서와 무관하고 표·기대 보유자·사건·회차가 다르면 다르다', () => {
    const [a, b] = [seat(), seat()];
    const base = fraudTargetsFingerprint(FRAUD_CASE, EVENT, [t(a!), t(b!)]);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(fraudTargetsFingerprint(FRAUD_CASE, EVENT, [t(b!), t(a!)])).toBe(base);
    expect(fraudTargetsFingerprint(FRAUD_CASE, EVENT, [t(a!), t(b!, RECIPIENT)])).not.toBe(base);
    expect(fraudTargetsFingerprint(FRAUD_CASE, EVENT, [t(a!), t(seat())])).not.toBe(base);
    expect(fraudTargetsFingerprint(randomUUID(), EVENT, [t(a!), t(b!)])).not.toBe(base);
    expect(fraudTargetsFingerprint(FRAUD_CASE, OTHER_EVENT, [t(a!), t(b!)])).not.toBe(base);
  });
});

describe('GAT-080 몫 F 부정 예매 운영자 취소: CancelFraudTickets', () => {
  test('GAT-080 F8 받은 표마다 FRAUD 취소 행을 공제 없이(33,333원) 만들고 좌석을 결제자 몫으로 되돌리며 결제사는 바로 부르지 않는다', async () => {
    const [mine, theirs] = [seat(), seat()];
    const f = fixture([mine!, theirs!]);
    const r = await f.uc.execute(input([t(mine!), t(theirs!, RECIPIENT)]));
    expect(r).toEqual([
      { ticketId: mine!.ticketId, outcome: 'ACCEPTED', cancellationId: expectedCancellationId(APPROVAL, mine!.ticketId), refundAmount: PRICE },
      { ticketId: theirs!.ticketId, outcome: 'ACCEPTED', cancellationId: expectedCancellationId(APPROVAL, theirs!.ticketId), refundAmount: PRICE },
    ]);
    expect(f.tickets.calls).toHaveLength(1);
    expect(f.tickets.calls[0]).toMatchObject({ approvalId: APPROVAL, fraudCaseId: FRAUD_CASE, eventId: EVENT, targets: [t(mine!), t(theirs!, RECIPIENT)] });
    expect(f.seats.calls).toEqual([
      { eventId: EVENT, orderId: ORDER, seatId: mine!.seatId, accountId: PAYER, saleEndsAtMs: SALE_ENDS },
      { eventId: EVENT, orderId: ORDER, seatId: theirs!.seatId, accountId: PAYER, saleEndsAtMs: SALE_ENDS },
    ]);
    expect(f.writes.created).toHaveLength(2);
    for (const [i, s] of [mine!, theirs!].entries()) {
      expect(f.writes.created[i]).toMatchObject({
        cancellationId: expectedCancellationId(APPROVAL, s.ticketId),
        orderId: ORDER,
        ticketId: s.ticketId,
        reason: 'FRAUD',
        fraudCaseId: FRAUD_CASE,
        approvalId: APPROVAL,
        deductionBp: 0,
        deductionAmount: 0,
        refundAmount: PRICE,
        status: 'REFUND_PENDING',
        nowMs: NOW,
        actor: 'system:fraud-cancellation',
      });
      expect(f.writes.created[i]!.refundDueAtMs).toBeUndefined();
    }
    // 이 호출 안에서 환급을 끝내지 않는다(REFUNDED로 바꾸지 않는다). 결제사 포트는 이 쓰임새의 의존성에 없다
    expect(f.writes.updates).toHaveLength(0);
    expect(f.store.requests.get(APPROVAL)).toMatchObject({ approvalId: APPROVAL, fraudCaseId: FRAUD_CASE, eventId: EVENT, requestedBy: 'investigator-1', approvedBy: 'commander-2', approvedAtMs: NOW - 60_000, createdAtMs: NOW });
    expect(f.store.requests.get(APPROVAL)!.fingerprint).toBe(fraudTargetsFingerprint(FRAUD_CASE, EVENT, [t(mine!), t(theirs!, RECIPIENT)]));
    expect(await f.store.results(APPROVAL)).toHaveLength(2);
  });

  test('GAT-080 F9 ticket-svc 건너뜀 셋을 계약 값으로 바꾸고(입장 기록은 SKIPPED_ENTRY_STARTED) 그 표의 좌석·취소 행은 만들지 않는다', async () => {
    const [ended, entered, moved] = [seat(), seat(), seat()];
    const f = fixture([ended!, entered!, moved!]);
    f.tickets.results.set(ended!.ticketId, 'SKIPPED_ALREADY_ENDED');
    f.tickets.results.set(entered!.ticketId, 'SKIPPED_ENTRY_RECORDED');
    f.tickets.results.set(moved!.ticketId, 'SKIPPED_HOLDER_CHANGED');
    const r = await f.uc.execute(input([t(ended!), t(entered!), t(moved!)]));
    expect(r).toEqual([
      { ticketId: ended!.ticketId, outcome: 'SKIPPED_ALREADY_ENDED' },
      { ticketId: entered!.ticketId, outcome: 'SKIPPED_ENTRY_STARTED' },
      { ticketId: moved!.ticketId, outcome: 'SKIPPED_HOLDER_CHANGED' },
    ]);
    expect(f.seats.calls).toHaveLength(0);
    expect(f.writes.created).toHaveLength(0);
  });

  test('GAT-080 F10 처음 호출은 판매 종료 − 2시간 정각(2026-11-19 17:00:00.000)부터 막고 1ms 전(16:59:59.999)은 받는다', async () => {
    const s = seat();
    const before = fixture([s]);
    const ok = await before.uc.execute(input([t(s)], { nowMs: kst('2026-11-19T16:59:59.999') }));
    expect(ok.map((x) => x.outcome)).toEqual(['ACCEPTED']);

    const at = fixture([s]);
    await rejectsWith(at.uc.execute(input([t(s)], { nowMs: kst('2026-11-19T17:00:00.000') })), 'DEADLINE_PASSED');
    expect(at.store.requests.size).toBe(0);
    expect(at.store.saves).toHaveLength(0);
    expect(at.tickets.calls).toHaveLength(0);
    expect(at.writes.created).toHaveLength(0);
  });

  test('GAT-080 F10 마감 전 첫 호출에 FAILED가 남으면 마감 뒤 다시 부르기는 ticket-svc를 부르지 않고 저장한 결과(FAILED 포함)를 그대로 준다', async () => {
    const [a, b] = [seat(), seat()];
    const f = fixture([a!, b!]);
    f.seats.failFor.set(b!.seatId, 1);
    const first = await f.uc.execute(input([t(a!), t(b!)], { nowMs: kst('2026-11-19T16:00:00') }));
    expect(first).toEqual([
      { ticketId: a!.ticketId, outcome: 'ACCEPTED', cancellationId: expectedCancellationId(APPROVAL, a!.ticketId), refundAmount: PRICE },
      { ticketId: b!.ticketId, outcome: 'FAILED', failureCode: 'SEAT_RETURN_FAILED' },
    ]);
    const calls = f.tickets.calls.length;
    const again = await f.uc.execute(input([t(a!), t(b!)], { nowMs: kst('2026-11-19T17:00:00') }));
    expect(again).toEqual(first);
    expect(f.tickets.calls).toHaveLength(calls);
    expect(f.writes.created).toHaveLength(1);
  });

  test('GAT-080 F10 마감 전 다시 부르기는 FAILED 표만 ticket-svc에 다시 보낸다', async () => {
    const [a, b] = [seat(), seat()];
    const f = fixture([a!, b!]);
    f.seats.failFor.set(b!.seatId, 1);
    await f.uc.execute(input([t(a!), t(b!)]));
    const again = await f.uc.execute(input([t(a!), t(b!)], { nowMs: NOW + 60_000 }));
    expect(f.tickets.calls).toHaveLength(2);
    expect(f.tickets.calls[1]!.targets).toEqual([t(b!)]);
    expect(again.map((x) => x.outcome)).toEqual(['ACCEPTED', 'ACCEPTED']);
  });

  test('GAT-080 F11 같은 승인 ID에 다른 대상(표 하나·기대 보유자·사건 ID·회차)이면 ALREADY_EXISTS이고 순서만 바꾸면 같은 답이다', async () => {
    const [a, b, c] = [seat(), seat(), seat()];
    const f = fixture([a!, b!, c!]);
    const first = await f.uc.execute(input([t(a!), t(b!)]));
    const calls = f.tickets.calls.length;
    await rejectsWith(f.uc.execute(input([t(a!), t(c!)])), 'ALREADY_EXISTS', '표 하나 다름');
    await rejectsWith(f.uc.execute(input([t(a!), t(b!, RECIPIENT)])), 'ALREADY_EXISTS', '기대 보유자 다름');
    await rejectsWith(f.uc.execute(input([t(a!), t(b!)], { fraudCaseId: randomUUID() })), 'ALREADY_EXISTS', '사건 ID 다름');
    await rejectsWith(f.uc.execute(input([t(a!), t(b!)], { eventId: OTHER_EVENT })), 'ALREADY_EXISTS', '회차 다름');
    expect(f.tickets.calls).toHaveLength(calls);
    const reordered = await f.uc.execute(input([t(b!), t(a!)]));
    expect(reordered).toEqual([first[1], first[0]]);
    expect(f.writes.created).toHaveLength(2);
  });

  test('GAT-080 F12 ticket-svc 호출이 첫 번에 실패하면 모든 표가 FAILED(TICKET_UNAVAILABLE)로 남고 다시 부르면 그 표들을 다시 한다', async () => {
    const [a, b] = [seat(), seat()];
    const f = fixture([a!, b!]);
    f.tickets.failNext = 1;
    const first = await f.uc.execute(input([t(a!), t(b!)]));
    expect(first).toEqual([
      { ticketId: a!.ticketId, outcome: 'FAILED', failureCode: 'TICKET_UNAVAILABLE' },
      { ticketId: b!.ticketId, outcome: 'FAILED', failureCode: 'TICKET_UNAVAILABLE' },
    ]);
    // 장애 주입이 실제로 있었다: 첫 호출이 ticket-svc에 닿아 실패했다
    expect(f.tickets.calls).toHaveLength(1);
    expect(await f.store.results(APPROVAL)).toEqual(first);
    expect(f.writes.created).toHaveLength(0);

    const again = await f.uc.execute(input([t(a!), t(b!)], { nowMs: NOW + 60_000 }));
    expect(f.tickets.calls).toHaveLength(2);
    expect(f.tickets.calls[1]!.targets).toEqual([t(a!), t(b!)]);
    expect(again.map((x) => x.outcome)).toEqual(['ACCEPTED', 'ACCEPTED']);
  });

  test('GAT-080 F12 좌석 되돌리기가 실패한 표만 FAILED(SEAT_RETURN_FAILED)이고 다시 부르면 ACCEPTED·SKIPPED 표는 다시 보내지 않으며 취소 행은 표마다 한 번 생긴다', async () => {
    const [ok, seatFails, moved] = [seat(), seat(), seat()];
    const f = fixture([ok!, seatFails!, moved!]);
    f.tickets.results.set(moved!.ticketId, 'SKIPPED_HOLDER_CHANGED');
    f.seats.failFor.set(seatFails!.seatId, 1);
    const first = await f.uc.execute(input([t(ok!), t(seatFails!), t(moved!)]));
    expect(first.map((x) => [x.outcome, x.failureCode])).toEqual([
      ['ACCEPTED', undefined],
      ['FAILED', 'SEAT_RETURN_FAILED'],
      ['SKIPPED_HOLDER_CHANGED', undefined],
    ]);
    expect(f.writes.created.map((c) => c.ticketId)).toEqual([ok!.ticketId]);

    const again = await f.uc.execute(input([t(ok!), t(seatFails!), t(moved!)], { nowMs: NOW + 60_000 }));
    expect(f.tickets.calls[1]!.targets).toEqual([t(seatFails!)]);
    expect(again).toEqual([
      first[0],
      { ticketId: seatFails!.ticketId, outcome: 'ACCEPTED', cancellationId: expectedCancellationId(APPROVAL, seatFails!.ticketId), refundAmount: PRICE },
      first[2],
    ]);
    expect(f.writes.created.map((c) => c.ticketId)).toEqual([ok!.ticketId, seatFails!.ticketId]);
    expect(f.seats.calls.filter((c) => c.seatId === ok!.seatId)).toHaveLength(1);
  });

  test('GAT-080 F12 취소 행 쓰기가 CONFLICT면 CANCELLATION_CONFLICT, 던지면 ORDER_STATE로 FAILED이고 REPLAYED면 저장된 금액으로 ACCEPTED다', async () => {
    const [conflict, broken, replayed] = [seat(), seat(), seat()];
    const f = fixture([conflict!, broken!, replayed!]);
    f.writes.answers.set(conflict!.ticketId, { status: 'CONFLICT' });
    f.writes.answers.set(broken!.ticketId, 'THROW');
    f.writes.answers.set(replayed!.ticketId, { status: 'REPLAYED', cancellationId: expectedCancellationId(APPROVAL, replayed!.ticketId), refundAmount: 30_000, state: 'REFUND_PENDING', refundAfterEntryClose: false, refundAttempts: 0 });
    const r = await f.uc.execute(input([t(conflict!), t(broken!), t(replayed!)]));
    expect(r).toEqual([
      { ticketId: conflict!.ticketId, outcome: 'FAILED', failureCode: 'CANCELLATION_CONFLICT' },
      { ticketId: broken!.ticketId, outcome: 'FAILED', failureCode: 'ORDER_STATE' },
      { ticketId: replayed!.ticketId, outcome: 'ACCEPTED', cancellationId: expectedCancellationId(APPROVAL, replayed!.ticketId), refundAmount: 30_000 },
    ]);
  });

  test('GAT-080 F13 입력이 틀리면 INVALID이고 아무것도 쓰지 않는다(0·501장, 같은 표 두 번, UUID 아님·대문자, 같은 사람, 빈 값, 129자, 다른 회차 표, 없는 표, 판매 설정 없는 회차)', async () => {
    const [a, b] = [seat(), seat()];
    const otherEventSeat = seat(OTHER_EVENT);
    const many = Array.from({ length: 501 }, () => seat());
    const cases: [string, CancelFraudTicketsInput, { configMissing?: boolean }?][] = [
      ['대상 0장', input([])],
      ['대상 501장', input(many.map((s) => t(s)))],
      ['같은 표 두 번', input([t(a!), t(a!)])],
      ['표 ID가 UUID 아님', input([{ ticketId: 'ticket-1', expectedHolderAccountId: PAYER }])],
      ['승인 ID가 대문자 UUID', input([t(a!)], { approvalId: APPROVAL.toUpperCase() })],
      ['기대 보유자가 UUID 아님', input([{ ticketId: a!.ticketId, expectedHolderAccountId: 'holder' }])],
      ['요청자 = 승인자', input([t(a!)], { requestedBy: 'same-person', approvedBy: 'same-person' })],
      ['요청자 빈 값', input([t(a!)], { requestedBy: '' })],
      ['승인자 129자', input([t(a!)], { approvedBy: 'x'.repeat(129) })],
      ['다른 회차 표', input([t(a!), t(otherEventSeat)])],
      ['없는 표', input([t(a!), { ticketId: randomUUID(), expectedHolderAccountId: PAYER }])],
      ['판매 설정 없는 회차', input([t(a!), t(b!)]), { configMissing: true }],
    ];
    for (const [name, i, o] of cases) {
      const f = fixture([a!, b!, otherEventSeat, ...many], o);
      await rejectsWith(f.uc.execute(i), 'INVALID', name);
      expect(f.store.requests.size, name).toBe(0);
      expect(f.store.saves, name).toHaveLength(0);
      expect(f.tickets.calls, name).toHaveLength(0);
      expect(f.writes.created, name).toHaveLength(0);
    }
  });

  test('GAT-080 F13 경계 안쪽은 받는다: 대상 500장, 128자 요청자·승인자', async () => {
    const many = Array.from({ length: 500 }, () => seat());
    const f = fixture(many);
    const r = await f.uc.execute(input(many.map((s) => t(s)), { requestedBy: 'r'.repeat(128), approvedBy: 'a'.repeat(128) }));
    expect(r).toHaveLength(500);
    expect(r.every((x) => x.outcome === 'ACCEPTED' && x.refundAmount === PRICE)).toBe(true);
    expect(r.map((x) => x.ticketId)).toEqual(many.map((s) => s.ticketId));
  });
});

describe('GAT-080 몫 F 부정 예매 운영자 취소: GetFraudCancellation', () => {
  test('GAT-080 F17 진행 읽기는 없는 승인을 NOT_FOUND로 주고, 있으면 저장된 표 결과와 환급 진행을 그대로 준다', async () => {
    const store = new Store();
    const get = new GetFraudCancellation(store);
    await rejectsWith(get.execute(randomUUID()), 'NOT_FOUND');

    const ticketId = randomUUID();
    const cancellationId = expectedCancellationId(APPROVAL, ticketId);
    await store.create({ approvalId: APPROVAL, fraudCaseId: FRAUD_CASE, eventId: EVENT, fingerprint: 'f', requestedBy: 'r', approvedBy: 'a', createdAtMs: NOW });
    await store.saveResults(APPROVAL, [{ ticketId, outcome: 'ACCEPTED', cancellationId, refundAmount: PRICE, expectedHolderAccountId: PAYER }]);
    store.refundRows = [{ ticketId, cancellationId, state: 'REFUNDED', refundedAtMs: NOW + 3_600_000 }];
    await expect(get.execute(APPROVAL)).resolves.toEqual({
      results: [{ ticketId, outcome: 'ACCEPTED', cancellationId, refundAmount: PRICE }],
      refunds: [{ ticketId, cancellationId, state: 'REFUNDED', refundedAtMs: NOW + 3_600_000 }],
    });
  });
});
