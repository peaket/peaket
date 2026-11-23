// J-T35 정산서 통지·이의·확정(F-07-5 LCH-100, ADR-0368, docs/features/settlement.md §4.2·§13 J-T35·J-T2·J-T10).
// 기대값은 정본에서 가져온다: 이의 기간 2영업일·다시 알림 1영업일(§4.2), 30분 점검(§4.2·ADR-0368 결정 12),
// 사건 칸(docs/api/asyncapi.yaml SettlementEvent), 이의 응답 202(openapi createPartnerSettlementDispute).
// 시험 시각은 수요일 10:00 KST라 주말·KST 날짜 경계가 끼지 않는 기본 경우다. 달력 경계는 settlement-business-calendar.test.ts가 본다.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import {
  calculateEventStatement,
  HttpSettlementCaseNotice,
  SettlementDueWorker,
  type SettlementDueTimer,
  type StatementRecord,
  type StatementStatus,
} from '../src/modules/settlement/index.js';
import { CountingProducts, fact, FlakyMarkStore, productItem, settlementFlow, UUID_RE, type SettlementFlow } from './settlement-flow-support.js';
import { seedTossSellers } from './settlement-support.js';

const HOUR = 60 * 60 * 1_000;
/** 2026-11-18(수) 10:00 KST */
const NOTIFY_AT = Date.parse('2026-11-18T01:00:00.000Z');
/** 정본 §4.2: 통지 시각 + 2영업일 같은 시각 = 2026-11-20(금) 10:00 KST */
const DUE_AT = Date.parse('2026-11-20T01:00:00.000Z');

let flow: SettlementFlow | undefined;
afterEach(async () => {
  await flow?.close();
  flow = undefined;
});

const open = async (o: Parameters<typeof settlementFlow>[0] = { now: NOTIFY_AT }) => {
  flow = await settlementFlow(o);
  return flow;
};

const eventsOf = (f: SettlementFlow, statementId: string) => f.store.outbox.filter((m) => m.value.statementId === statementId);
const auditsOf = (f: SettlementFlow, statementId: string) => f.store.statementAudits.filter((a) => a.statementId === statementId).map((a) => ({ from: a.fromStatus, to: a.toStatus }));

/** 계산 경로로 NOTIFIED 정산서 하나(J-T1 금액: 판매 3,000만·환급 200만·10% → 지급 2,492만) */
const notified = async (f: SettlementFlow, o: { promoterId?: string; eventId?: string; pg?: 'TOSS' | 'PORTONE'; kyc?: 'VERIFIED' | 'PENDING' } = {}) => {
  const promoterId = o.promoterId ?? randomUUID();
  const eventId = o.eventId ?? randomUUID();
  const pg = o.pg ?? 'TOSS';
  await f.settlements.recordKyc(promoterId, o.kyc ?? 'VERIFIED');
  await seedTossSellers(f.store, promoterId); // F-07-6: 토스 정산서는 그 상점 토스 셀러가 PARTIALLY_APPROVED 이상이어야 묶인다(ADR-0369 결정 4)
  f.payments.set(eventId, pg, [fact({ amount: 30_000_000, cancelledAmount: 2_000_000, status: 'PARTIAL_CANCELED' })]);
  const s = await f.settlements.calculateEvent({ promoterId, eventId, pg, pgStore: 'STANDARD' });
  return { ...s, promoterId, eventId };
};

/** 시험 자료: 상태만 바꾼다(포트가 시험 자료용으로 둔 saveStatement) */
const force = async (f: SettlementFlow, statementId: string, patch: Partial<StatementRecord>) => {
  const s = await f.store.findStatementById(statementId);
  await f.store.saveStatement({ ...s!, ...patch });
};

describe('J-T35 ① 계산과 통지는 한 트랜잭션', () => {
  test('[ASVS v5.0.0-2.3.1] J-T35 ① 회차 정산서는 NOTIFIED·감사 CALCULATED→NOTIFIED 한 줄·STATEMENT_NOTIFIED 한 건이고 사건 칸이 정산서와 같다', async () => {
    const f = await open();
    const s = await notified(f);
    const stored = await f.store.findStatementById(s.statementId);
    expect(stored).toMatchObject({ status: 'NOTIFIED', holdReason: null, grossAmount: 30_000_000, refundAmount: 2_000_000, commissionAmount: 2_800_000, commissionVat: 280_000, payoutAmount: 24_920_000, revision: 1 });
    expect(stored!.disputeDueAt?.getTime()).toBe(DUE_AT);
    expect(auditsOf(f, s.statementId)).toEqual([{ from: 'CALCULATED', to: 'NOTIFIED' }]);
    const events = eventsOf(f, s.statementId);
    expect(events).toHaveLength(1);
    expect(events[0]!.topic).toBe('trade.settlements');
    expect(events[0]!.key).toBe(s.promoterId);
    expect(events[0]!.value).toStrictEqual({
      promoterId: s.promoterId,
      statementId: s.statementId,
      kind: 'EVENT',
      eventId: s.eventId,
      pg: 'TOSS',
      pgStore: 'STANDARD',
      salesAmount: 30_000_000,
      refundAmount: 2_000_000,
      feeAmount: 2_800_000,
      revision: 1,
      supersedesId: null,
      type: 'STATEMENT_NOTIFIED',
      occurredAt: new Date(NOTIFY_AT).toISOString(),
      eventKey: expect.stringMatching(UUID_RE),
    });
    // 같은 회차를 다시 계산해도 정산서·사건이 늘지 않는다
    await f.settlements.calculateEvent({ promoterId: s.promoterId, eventId: s.eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(eventsOf(f, s.statementId)).toHaveLength(1);
    expect(f.store.statements.size).toBe(1);
  });

  test('J-T35 ① KYC 전 정산서와 지급액 0인 정산서도 계산 때 NOTIFIED이고 사건이 나간다(계산 때 HELD·CARRIED_OVER 없음)', async () => {
    const f = await open();
    const beforeKyc = await notified(f, { kyc: 'PENDING' });
    expect(await f.store.findStatementById(beforeKyc.statementId)).toMatchObject({ status: 'NOTIFIED', holdReason: null });
    expect(eventsOf(f, beforeKyc.statementId).map((e) => e.value.type)).toEqual(['STATEMENT_NOTIFIED']);

    const zeroPromoter = randomUUID();
    const zeroEvent = randomUUID();
    await f.settlements.recordKyc(zeroPromoter, 'VERIFIED');
    await seedTossSellers(f.store, zeroPromoter); // F-07-6: 토스 정산서는 그 상점 토스 셀러가 PARTIALLY_APPROVED 이상이어야 묶인다(ADR-0369 결정 4)
    f.payments.set(zeroEvent, 'TOSS', [fact({ amount: 50_000, cancelledAmount: 50_000, status: 'CANCELED' })]);
    const zero = await f.settlements.calculateEvent({ promoterId: zeroPromoter, eventId: zeroEvent, pg: 'TOSS', pgStore: 'STANDARD' });
    expect(await f.store.findStatementById(zero.statementId)).toMatchObject({ status: 'NOTIFIED', payoutAmount: 0, holdReason: null });
    expect(eventsOf(f, zero.statementId).map((e) => e.value.type)).toEqual(['STATEMENT_NOTIFIED']);
    // 승인 뒤 전액 취소는 판매 대금·환급 모두 원금이다(정본 §4.1 '전액 취소된 결제', 리뷰 RV-01)
    expect(eventsOf(f, zero.statementId)[0]!.value).toMatchObject({ salesAmount: 50_000, refundAmount: 50_000, feeAmount: 0 });
  });

  test('J-T35 ① 포트원 정산서의 사건에는 pgStore 칸이 없다(asyncapi x-present-when: pg TOSS)', async () => {
    const f = await open();
    const s = await notified(f, { pg: 'PORTONE' });
    const value = eventsOf(f, s.statementId)[0]!.value;
    expect(value).toMatchObject({ pg: 'PORTONE', type: 'STATEMENT_NOTIFIED', eventId: s.eventId });
    expect(Object.keys(value)).not.toContain('pgStore');
  });

  test('J-T35 ① 끝난 회차 계산은 결제가 있는 결제사·상점만 정산서를 만들고, 결제 없는 결제사·상점은 정산서·사건이 0건이다', async () => {
    const promoterId = randomUUID();
    const eventId = randomUUID();
    const f = await open({ now: NOTIFY_AT, events: { listDue: async () => [{ promoterId, eventId, endsAt: '2026-11-15T12:00:00.000Z' }] } });
    await f.settlements.recordKyc(promoterId, 'VERIFIED');
    await seedTossSellers(f.store, promoterId); // F-07-6: 토스 정산서는 그 상점 토스 셀러가 PARTIALLY_APPROVED 이상이어야 묶인다(ADR-0369 결정 4)
    f.payments.set(eventId, 'TOSS', [fact({ amount: 5_000_000 })], 'ESCROW');
    const out = await f.settlements.calculateDueEvents('2026-11-17');
    expect(out.calculated).toBe(1);
    const all = [...f.store.statements.values()];
    expect(all.map((s) => ({ pg: s.pg, pgStore: s.pgStore, status: s.status }))).toEqual([{ pg: 'TOSS', pgStore: 'ESCROW', status: 'NOTIFIED' }]);
    expect(f.store.outbox.map((m) => ({ statementId: m.value.statementId, type: m.value.type, pgStore: m.value.pgStore }))).toEqual([{ statementId: all[0]!.statementId, type: 'STATEMENT_NOTIFIED', pgStore: 'ESCROW' }]);
  });

  test('J-T35 ① 상품 정산서도 계산 = 통지이고 사건은 kind PRODUCT·주 시작·끝을 싣고 eventId 칸이 없다', async () => {
    const products = new CountingProducts();
    const promoterId = randomUUID();
    products.rows = [productItem({ promoterId, grossAmount: 50_000, refundedAmount: 5_000, basisDate: '2026-11-10' })];
    const f = await open({ now: NOTIFY_AT, products });
    const out = await f.settlements.calculateProduct({ periodStart: '2026-11-09', periodEnd: '2026-11-15' });
    expect(out.created).toBe(1);
    const s = out.items[0]!;
    expect(await f.store.findStatementById(s.statementId)).toMatchObject({ status: 'NOTIFIED', kind: 'PRODUCT' });
    expect(auditsOf(f, s.statementId)).toEqual([{ from: 'CALCULATED', to: 'NOTIFIED' }]);
    const value = eventsOf(f, s.statementId)[0]!.value;
    expect(value).toMatchObject({ kind: 'PRODUCT', periodStart: '2026-11-09', periodEnd: '2026-11-15', salesAmount: 50_000, refundAmount: 5_000, feeAmount: 4_500, revision: 1, supersedesId: null, type: 'STATEMENT_NOTIFIED' });
    expect(Object.keys(value)).not.toContain('eventId');
  });
});

describe('J-T35 ② 이의 받기', () => {
  test('[ASVS v5.0.0-2.3.4] J-T35 ② 기한 1밀리초 전 이의는 202이고 이의 행·DISPUTED·감사·STATEMENT_DISPUTED가 함께 남는다', async () => {
    const f = await open();
    const s = await notified(f);
    f.at(DUE_AT - 1);
    const headers = f.partnerHeaders(s.promoterId);
    const res = await f.dispute(s.promoterId, s.statementId, { reasonCode: 'REFUND_AMOUNT', detail: '환급 두 건이 빠졌습니다' }, headers);
    expect(res.statusCode, res.payload).toBe(202);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await f.store.findStatementById(s.statementId)).toMatchObject({ status: 'DISPUTED' });
    const disputes = await f.store.listDisputes(s.statementId);
    expect(disputes).toHaveLength(1);
    expect(disputes[0]).toMatchObject({ statementId: s.statementId, reasonCode: 'REFUND_AMOUNT', detail: '환급 두 건이 빠졌습니다', submittedBy: headers['x-user-id'], result: null });
    expect(disputes[0]!.submittedAt.getTime()).toBe(DUE_AT - 1);
    expect(auditsOf(f, s.statementId)).toEqual([
      { from: 'CALCULATED', to: 'NOTIFIED' },
      { from: 'NOTIFIED', to: 'DISPUTED' },
    ]);
    const events = eventsOf(f, s.statementId).map((e) => e.value);
    expect(events.map((e) => e.type)).toEqual(['STATEMENT_NOTIFIED', 'STATEMENT_DISPUTED']);
    expect(events[1]).toMatchObject({ promoterId: s.promoterId, statementId: s.statementId, occurredAt: new Date(DUE_AT - 1).toISOString(), eventKey: expect.stringMatching(UUID_RE) });
    expect(events[1]!.eventKey).not.toBe(events[0]!.eventKey);
    // STATEMENT_NOTIFIED 때만 싣는 칸(asyncapi x-present-when)은 이의 사건에 없다
    expect(Object.keys(events[1]!)).not.toContain('salesAmount');
  });

  test('J-T35 ② 기한 시각의 이의는 409 settlement-dispute-window-closed이고 아무것도 남지 않는다', async () => {
    const f = await open();
    const s = await notified(f);
    f.at(DUE_AT);
    const res = await f.dispute(s.promoterId, s.statementId, { reasonCode: 'GROSS_AMOUNT' });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).type).toContain('settlement-dispute-window-closed');
    expect(await f.store.findStatementById(s.statementId)).toMatchObject({ status: 'NOTIFIED' });
    expect(await f.store.listDisputes(s.statementId)).toEqual([]);
    expect(eventsOf(f, s.statementId).map((e) => e.value.type)).toEqual(['STATEMENT_NOTIFIED']);
  });

  test('J-T35 ② HELD·CONFIRMED·DISPUTED 정산서의 이의는 기한 전이라도 409이고 이의 행이 생기지 않는다', async () => {
    const f = await open();
    for (const status of ['HELD', 'CONFIRMED', 'DISPUTED'] as const satisfies readonly StatementStatus[]) {
      const s = await notified(f);
      await force(f, s.statementId, { status, holdReason: status === 'HELD' ? 'KYC' : null });
      const res = await f.dispute(s.promoterId, s.statementId, { reasonCode: 'COMMISSION' });
      expect({ status, code: res.statusCode }).toEqual({ status, code: 409 });
      expect(JSON.parse(res.payload).type).toContain('settlement-not-disputable');
      expect((await f.store.findStatementById(s.statementId))?.status).toBe(status);
      expect(await f.store.listDisputes(s.statementId)).toEqual([]);
    }
  });

  test('J-T35 ② 사유 코드 다섯 밖은 400, 설명 2,000자는 받고 2,001자는 400, OTHER에 빈 설명은 422다', async () => {
    const f = await open();
    const outside = await notified(f);
    for (const reasonCode of ['PAYOUT_DATE', 'LEDGER_ERROR', 'gross_amount', '']) {
      const res = await f.dispute(outside.promoterId, outside.statementId, { reasonCode });
      expect({ reasonCode, code: res.statusCode }).toEqual({ reasonCode, code: 400 });
    }
    const tooLong = await f.dispute(outside.promoterId, outside.statementId, { reasonCode: 'OFFSET', detail: '가'.repeat(2_001) });
    expect(tooLong.statusCode).toBe(400);
    for (const detail of [undefined, '', '   ']) {
      const res = await f.dispute(outside.promoterId, outside.statementId, { reasonCode: 'OTHER', ...(detail === undefined ? {} : { detail }) });
      expect({ detail, code: res.statusCode }).toEqual({ detail, code: 422 });
    }
    expect(await f.store.listDisputes(outside.statementId)).toEqual([]);
    expect((await f.store.findStatementById(outside.statementId))?.status).toBe('NOTIFIED');

    const longest = await f.dispute(outside.promoterId, outside.statementId, { reasonCode: 'OTHER', detail: '가'.repeat(2_000) });
    expect(longest.statusCode).toBe(202);
    expect((await f.store.listDisputes(outside.statementId))[0]?.detail).toHaveLength(2_000);
  });
});

describe('J-T2 이의 낸 정산서만 묶음에서 빠진다', () => {
  test('J-T2 이의 기간 안에 이의를 낸 정산서는 DISPUTED로 남고 같은 파트너의 다른 정산서만 지급 묶음에 든다', async () => {
    const f = await open();
    const promoterId = randomUUID();
    const disputed = await notified(f, { promoterId });
    const other = await notified(f, { promoterId });
    expect(disputed.payoutDate).toBe(other.payoutDate);
    f.at(NOTIFY_AT + 3 * HOUR);
    expect((await f.dispute(promoterId, disputed.statementId, { reasonCode: 'GROSS_AMOUNT' })).statusCode).toBe(202);
    f.at(DUE_AT);
    const confirmed = await f.settlements.confirmDueStatements();
    expect(confirmed.items.map((s) => s.statementId)).toEqual([other.statementId]);
    const batch = await f.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: other.payoutDate!, actor: randomUUID() });
    expect(batch).toMatchObject({ statementCount: 1, totalAmount: 24_920_000 });
    expect((await f.store.listStatementsByBatch(batch.batchId)).map((s) => s.statementId)).toEqual([other.statementId]);
    expect(await f.store.findStatementById(disputed.statementId)).toMatchObject({ status: 'DISPUTED', payoutBatchId: null });
  });
});

describe('J-T35 ③ 이의를 받으면 CS 처리함 정산 이의 건', () => {
  test('J-T35 ③ 이의를 받은 뒤 그 이의·정산서로 CS 건을 열고 case_requested_at을 채운다', async () => {
    const f = await open();
    const s = await notified(f);
    f.at(NOTIFY_AT + HOUR);
    expect((await f.dispute(s.promoterId, s.statementId, { reasonCode: 'COMMISSION' })).statusCode).toBe(202);
    const [d] = await f.store.listDisputes(s.statementId);
    expect(f.caseNotice.opened).toEqual([{ disputeId: d!.disputeId, statementId: s.statementId, createdAt: new Date(NOTIFY_AT + HOUR) }]);
    expect(d!.caseRequestedAt?.getTime()).toBe(NOTIFY_AT + HOUR);
  });

  test('J-T35 ③ ops가 503이어도 이의는 202로 남고, 다음 30분 점검이 건을 연 뒤 다시 보내지 않는다', async () => {
    const f = await open();
    const s = await notified(f);
    f.caseNotice.failing = true;
    f.at(NOTIFY_AT + HOUR);
    const res = await f.dispute(s.promoterId, s.statementId, { reasonCode: 'COMMISSION' });
    expect(res.statusCode).toBe(202);
    const [d] = await f.store.listDisputes(s.statementId);
    expect(d).toMatchObject({ result: null });
    expect(d!.caseRequestedAt ?? null).toBeNull();
    expect((await f.store.findStatementById(s.statementId))?.status).toBe('DISPUTED');
    expect(f.lines.filter((l) => l.event === 'settlement_dispute_case_deferred')).toEqual([expect.objectContaining({ disputeId: d!.disputeId, statementId: s.statementId })]);

    f.caseNotice.failing = false;
    const timer = new ManualTimer();
    const worker = new SettlementDueWorker({ settlements: f.settlements, leader: { isLeader: () => true }, clock: f.clock, timer });
    worker.start();
    // 정본 §4.2: 건을 열지 못한 이의는 30분 [가정]마다 다시 보낸다
    expect(timer.intervalMs).toBe(30 * 60 * 1_000);
    f.at(NOTIFY_AT + HOUR + 30 * 60 * 1_000);
    await worker.tick(false);
    expect(f.caseNotice.opened).toEqual([{ disputeId: d!.disputeId, statementId: s.statementId, createdAt: new Date(NOTIFY_AT + HOUR) }]);
    expect((await f.store.listDisputes(s.statementId))[0]!.caseRequestedAt?.getTime()).toBe(NOTIFY_AT + HOUR + 30 * 60 * 1_000);
    f.at(NOTIFY_AT + 2 * HOUR);
    await worker.tick(false);
    expect(f.caseNotice.opened).toHaveLength(1);
    await worker.stop();
  });

  test('J-T35 ③(어댑터) ops 내부 경로에 STATEMENT_DISPUTE·대상 정산서·이의 ID를 보내고, 5xx·받지 않음은 던진다', async () => {
    const seen: { url: string; method: string; body: Record<string, unknown>; token: string | null }[] = [];
    const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const notice = (reply: () => Response) =>
      new HttpSettlementCaseNotice('http://ops-svc:8080', 'internal-token', async (input, init) => {
        const req = new Request(input, init);
        seen.push({ url: req.url, method: req.method, body: (await req.json()) as Record<string, unknown>, token: req.headers.get('x-peaket-internal-token') });
        return reply();
      });
    const disputeId = randomUUID();
    const statementId = randomUUID();
    const createdAt = new Date(NOTIFY_AT);
    await notice(() => answer(202, { accepted: true, caseId: 'case-1' })).openDispute({ disputeId, statementId, createdAt });
    expect(seen).toEqual([
      { url: 'http://ops-svc:8080/internal/v1/cs-cases', method: 'POST', body: expect.objectContaining({ eventKey: disputeId, kind: 'STATEMENT_DISPUTE', sourceId: statementId, createdAt: createdAt.toISOString() }), token: 'internal-token' },
    ]);
    await expect(notice(() => answer(503, {})).openDispute({ disputeId, statementId, createdAt })).rejects.toMatchObject({ status: 503 });
    await expect(notice(() => answer(202, { accepted: false })).openDispute({ disputeId, statementId, createdAt })).rejects.toMatchObject({ status: 503 });
  });
});

describe('J-T35 ⑪ 커밋 뒤 CS 건 표시 쓰기 실패(리뷰 RV-05)', () => {
  // 정본 §4.2 '이의 받기': 건을 연 뒤 case_requested_at을 쓰지 못해도 이의 응답은 202이고 다음 점검이 다시 보낸다.
  test('J-T35 ⑪ 표시 쓰기가 한 번 실패해도 이의는 202·DISPUTED·이의 행 하나이고, 다음 점검이 다시 보내 표시가 채워지며 ops 건은 하나다', async () => {
    const store = new FlakyMarkStore();
    const f = await open({ now: NOTIFY_AT, store });
    const s = await notified(f);
    store.failNextMarks = 1;
    f.at(NOTIFY_AT + HOUR);
    const res = await f.dispute(s.promoterId, s.statementId, { reasonCode: 'COMMISSION' });
    expect(res.statusCode, res.payload).toBe(202);
    expect((await f.store.findStatementById(s.statementId))?.status).toBe('DISPUTED');
    const disputes = await f.store.listDisputes(s.statementId);
    expect(disputes).toHaveLength(1);
    expect(disputes[0]!.caseRequestedAt ?? null).toBeNull();
    // 다시 내면 이미 이의 중이라 409(첫 이의가 남았다)
    expect((await f.dispute(s.promoterId, s.statementId, { reasonCode: 'COMMISSION' })).statusCode).toBe(409);

    const worker = new SettlementDueWorker({ settlements: f.settlements, leader: { isLeader: () => true }, clock: f.clock, timer: new ManualTimer() });
    f.at(NOTIFY_AT + HOUR + 30 * 60 * 1_000);
    await worker.tick(false);
    expect((await f.store.listDisputes(s.statementId))[0]!.caseRequestedAt?.getTime()).toBe(NOTIFY_AT + HOUR + 30 * 60 * 1_000);
    // ops는 eventKey(이의 ID)로 같은 건을 한 번만 연다: 보낸 이의 ID는 하나뿐이다
    expect(new Set(f.caseNotice.opened.map((o) => o.disputeId))).toEqual(new Set([disputes[0]!.disputeId]));
    const sent = f.caseNotice.opened.length;
    f.at(NOTIFY_AT + 2 * HOUR);
    await worker.tick(false);
    expect(f.caseNotice.opened).toHaveLength(sent);
  });

  test('J-T35 ⑪ 다시 보내기 중 가운데 이의의 표시 쓰기가 실패해도 같은 점검의 나머지 이의는 보내고 표시한다', async () => {
    const store = new FlakyMarkStore();
    const f = await open({ now: NOTIFY_AT, store });
    f.caseNotice.failing = true;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const s = await notified(f);
      f.at(NOTIFY_AT + (i + 1) * 60_000);
      expect((await f.dispute(s.promoterId, s.statementId, { reasonCode: 'GROSS_AMOUNT' })).statusCode).toBe(202);
      ids.push((await f.store.listDisputes(s.statementId))[0]!.disputeId);
    }
    f.caseNotice.failing = false;
    store.failMarkFor.add(ids[1]!);
    f.at(NOTIFY_AT + HOUR);
    await expect(f.settlements.retryDisputeCases()).resolves.toBeDefined();
    expect(f.caseNotice.opened.map((o) => o.disputeId).sort()).toEqual([...ids].sort());
    const marked = (id: string) => (store.disputes.get(id)?.caseRequestedAt ?? null) !== null;
    expect(ids.map(marked)).toEqual([true, false, true]);
  });
});

describe('J-T35 ④ 기각(payment 내부 경로)', () => {
  const dismissUrl = (id: string) => `/internal/v1/settlements/statements/${id}/dispute-dismissal`;

  test('J-T35 ④ 기각하면 이의가 DISMISSED·사유·처리자로 닫히고 NOTIFIED·처리 시각 + 1영업일, STATEMENT_NOTIFIED가 판본 그대로 다시 나간다', async () => {
    const f = await open();
    const s = await notified(f);
    // 판본 두 자리(10)로 글자 비교 결함을 잡는다
    await force(f, s.statementId, { revision: 10 });
    f.at(NOTIFY_AT + HOUR);
    expect((await f.dispute(s.promoterId, s.statementId, { reasonCode: 'GROSS_AMOUNT' })).statusCode).toBe(202);
    const actorId = randomUUID();
    // 2026-11-19(목) 15:00 KST에 기각 → 1영업일 뒤 2026-11-20(금) 15:00 KST
    const dismissAt = Date.parse('2026-11-19T06:00:00.000Z');
    f.at(dismissAt);
    const res = await f.internal(dismissUrl(s.statementId), { reason: '판매 대금은 원장과 같습니다', actorId });
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const stored = await f.store.findStatementById(s.statementId);
    expect(stored).toMatchObject({ status: 'NOTIFIED', revision: 10 });
    expect(stored!.disputeDueAt?.toISOString()).toBe('2026-11-20T06:00:00.000Z');
    const [d] = await f.store.listDisputes(s.statementId);
    expect(d).toMatchObject({ result: 'DISMISSED', resolutionNote: '판매 대금은 원장과 같습니다', resolvedBy: actorId });
    expect(d!.resolvedAt?.getTime()).toBe(dismissAt);
    const events = eventsOf(f, s.statementId).map((e) => e.value);
    expect(events.map((e) => e.type)).toEqual(['STATEMENT_NOTIFIED', 'STATEMENT_DISPUTED', 'STATEMENT_NOTIFIED']);
    expect(events[2]).toMatchObject({ revision: 10, supersedesId: null, salesAmount: 30_000_000, refundAmount: 2_000_000, feeAmount: 2_800_000, occurredAt: new Date(dismissAt).toISOString() });
    // 검증 보강 X-10(asyncapi SettlementEvent.eventKey '같은 사건을 다시 보내면 같은 값', ADR-0052): 다시 알림은 처음 통지와 다른 사건이라
    // 중복 제거 키가 달라야 한다. 같으면 받는 쪽이 다시 알림을 처음 통지의 중복으로 버린다
    expect(events[2]!.eventKey).toMatch(UUID_RE);
    expect(events[2]!.eventKey).not.toBe(events[0]!.eventKey);
    expect(new Set(events.map((e) => e.eventKey)).size).toBe(events.length);
    expect(auditsOf(f, s.statementId).at(-1)).toEqual({ from: 'DISPUTED', to: 'NOTIFIED' });
    // 다시 알린 1영업일 안에는 다시 이의할 수 있다
    f.at(Date.parse('2026-11-20T06:00:00.000Z') - 1);
    expect((await f.dispute(s.promoterId, s.statementId, { reasonCode: 'OFFSET' })).statusCode).toBe(202);
  });

  test('J-T35 ④ 사유가 비거나 2,001자면 400, DISPUTED가 아니면 409이고 정산서·이의가 그대로다', async () => {
    const f = await open();
    const s = await notified(f);
    const actorId = randomUUID();
    const notDisputed = await f.internal(dismissUrl(s.statementId), { reason: '사유', actorId });
    expect(notDisputed.statusCode).toBe(409);
    expect((await f.store.findStatementById(s.statementId))?.status).toBe('NOTIFIED');

    expect((await f.dispute(s.promoterId, s.statementId, { reasonCode: 'GROSS_AMOUNT' })).statusCode).toBe(202);
    for (const reason of ['', '   ', '가'.repeat(2_001)]) {
      const res = await f.internal(dismissUrl(s.statementId), { reason, actorId });
      expect({ len: reason.length, code: res.statusCode }).toEqual({ len: reason.length, code: 400 });
    }
    expect((await f.store.findStatementById(s.statementId))?.status).toBe('DISPUTED');
    expect((await f.store.listDisputes(s.statementId))[0]).toMatchObject({ result: null });
    const ok = await f.internal(dismissUrl(s.statementId), { reason: '가'.repeat(2_000), actorId });
    expect(ok.statusCode).toBe(200);
  });

  test('J-T35 ④ 이의 결과를 ADJUSTED로 바로 적던 옛 내부 경로는 404다', async () => {
    const f = await open();
    const s = await notified(f);
    expect((await f.dispute(s.promoterId, s.statementId, { reasonCode: 'GROSS_AMOUNT' })).statusCode).toBe(202);
    const [d] = await f.store.listDisputes(s.statementId);
    for (const result of ['ADJUSTED', 'DISMISSED']) {
      const res = await f.internal(`/internal/v1/settlements/statements/${s.statementId}/disputes/${d!.disputeId}/resolution`, { result, actor: randomUUID() });
      expect({ result, code: res.statusCode }).toEqual({ result, code: 404 });
    }
    expect((await f.store.findStatementById(s.statementId))?.status).toBe('DISPUTED');
    expect((await f.store.listDisputes(s.statementId))[0]).toMatchObject({ result: null });
  });
});

describe('J-T35 ⑤ 자동 확정', () => {
  test('J-T35 ⑤ 기한이 지난 NOTIFIED만 CONFIRMED·STATEMENT_CONFIRMED이고 DISPUTED·HELD·기한 전 NOTIFIED는 그대로다', async () => {
    const f = await open();
    const due = await notified(f);
    const disputed = await notified(f);
    const held = await notified(f);
    await force(f, disputed.statementId, { status: 'DISPUTED' });
    await force(f, held.statementId, { status: 'HELD', holdReason: 'BALANCE' });
    // 기한 1밀리초 전에는 아무것도 확정하지 않는다
    f.at(DUE_AT - 1);
    expect((await f.settlements.confirmDueStatements()).confirmed).toBe(0);
    expect((await f.store.findStatementById(due.statementId))?.status).toBe('NOTIFIED');
    // 나중에 통지한 정산서(기한 전)를 하나 더 둔다
    const later = await notified(f);
    f.at(DUE_AT);
    const out = await f.settlements.confirmDueStatements();
    expect(out.items.map((s) => ({ id: s.statementId, status: s.status }))).toEqual([{ id: due.statementId, status: 'CONFIRMED' }]);
    expect((await f.store.findStatementById(due.statementId))?.status).toBe('CONFIRMED');
    expect(eventsOf(f, due.statementId).map((e) => e.value.type)).toEqual(['STATEMENT_NOTIFIED', 'STATEMENT_CONFIRMED']);
    expect(auditsOf(f, due.statementId).at(-1)).toEqual({ from: 'NOTIFIED', to: 'CONFIRMED' });
    expect((await f.store.findStatementById(disputed.statementId))?.status).toBe('DISPUTED');
    expect(await f.store.findStatementById(held.statementId)).toMatchObject({ status: 'HELD', holdReason: 'BALANCE' });
    expect((await f.store.findStatementById(later.statementId))?.status).toBe('NOTIFIED');
    for (const id of [disputed.statementId, held.statementId, later.statementId]) expect(eventsOf(f, id).map((e) => e.value.type)).toEqual(['STATEMENT_NOTIFIED']);
  });

  test('J-T35 ⑤ 지급액 0인 정산서는 확정 때 CARRIED_OVER·STATEMENT_CARRIED_OVER이고 미수금이 없다', async () => {
    const f = await open();
    const promoterId = randomUUID();
    const eventId = randomUUID();
    await f.settlements.recordKyc(promoterId, 'VERIFIED');
    await seedTossSellers(f.store, promoterId); // F-07-6: 토스 정산서는 그 상점 토스 셀러가 PARTIALLY_APPROVED 이상이어야 묶인다(ADR-0369 결정 4)
    f.payments.set(eventId, 'TOSS', [fact({ amount: 80_000, cancelledAmount: 80_000, status: 'CANCELED' })]);
    const s = await f.settlements.calculateEvent({ promoterId, eventId, pg: 'TOSS', pgStore: 'STANDARD' });
    f.at(DUE_AT);
    await f.settlements.confirmDueStatements();
    expect(await f.store.findStatementById(s.statementId)).toMatchObject({ status: 'CARRIED_OVER', payoutAmount: 0 });
    const types = eventsOf(f, s.statementId).map((e) => e.value.type);
    expect(types.at(-1)).toBe('STATEMENT_CARRIED_OVER');
    expect(types).not.toContain('RECEIVABLE_OPENED');
    expect(f.store.receivables.size).toBe(0);
  });

  test('J-T35 ⑤ 자동 확정은 06시가 아닌 30분 점검에서도 돈다', async () => {
    const f = await open();
    const s = await notified(f);
    const worker = new SettlementDueWorker({ settlements: f.settlements, leader: { isLeader: () => true }, clock: f.clock, timer: new ManualTimer() });
    // 기한(금 10:00 KST)이 지난 금요일 14:30 KST 정기 점검
    f.at(Date.parse('2026-11-20T05:30:00.000Z'));
    await worker.tick(false);
    expect((await f.store.findStatementById(s.statementId))?.status).toBe('CONFIRMED');
  });
});

describe('J-T35 ⑧ 상품 정산서 일꾼', () => {
  /** 2026-11-23(월) 06:00 KST */
  const MONDAY_6 = Date.parse('2026-11-22T21:00:00.000Z');
  const LAST_WEEK = { from: '2026-11-16', to: '2026-11-22' };

  test('J-T35 ⑧ 주의 첫 영업일 06시에 지난주 월~일을 계산·통지하고 같은 날 다시 돌아도 한 장이며 화요일에는 계산하지 않는다', async () => {
    const products = new CountingProducts();
    const promoterId = randomUUID();
    products.rows = [productItem({ promoterId, basisDate: '2026-11-18' }), productItem({ promoterId, basisDate: '2026-11-23' })];
    const f = await open({ now: MONDAY_6 - 30 * 60 * 1_000, products });
    const worker = new SettlementDueWorker({ settlements: f.settlements, leader: { isLeader: () => true }, clock: f.clock, timer: new ManualTimer() });
    await worker.tick(false); // 05:30 KST
    expect(products.calls).toEqual([]);
    f.at(MONDAY_6);
    await worker.tick(false);
    expect(products.calls).toEqual([LAST_WEEK]);
    const made = [...f.store.statements.values()].filter((s) => s.kind === 'PRODUCT');
    expect(made.map((s) => ({ periodStart: s.periodStart, periodEnd: s.periodEnd, status: s.status, grossAmount: s.grossAmount }))).toEqual([
      { periodStart: '2026-11-16', periodEnd: '2026-11-22', status: 'NOTIFIED', grossAmount: 40_000 },
    ]);
    expect(f.store.outbox.filter((m) => m.value.kind === 'PRODUCT').map((m) => m.value.type)).toEqual(['STATEMENT_NOTIFIED']);
    f.at(MONDAY_6 + 30 * 60 * 1_000);
    await worker.tick(false);
    expect([...f.store.statements.values()].filter((s) => s.kind === 'PRODUCT')).toHaveLength(1);
    f.at(MONDAY_6 + 24 * HOUR);
    await worker.tick(false);
    expect(products.calls.filter((c) => c.from !== LAST_WEEK.from)).toEqual([]);
    expect([...f.store.statements.values()].filter((s) => s.kind === 'PRODUCT')).toHaveLength(1);
  });

  test('J-T35 ⑧ 월요일이 공휴일이면 월요일 06시에는 돌지 않고 화요일 06시에 지난주를 계산한다', async () => {
    const products = new CountingProducts();
    products.rows = [productItem({ basisDate: '2026-11-20' })];
    const f = await open({ now: MONDAY_6, products, holidays: new Set(['2026-11-23']) });
    const worker = new SettlementDueWorker({ settlements: f.settlements, leader: { isLeader: () => true }, clock: f.clock, timer: new ManualTimer() });
    await worker.tick(false);
    expect(products.calls).toEqual([]);
    expect(f.store.statements.size).toBe(0);
    f.at(MONDAY_6 + 24 * HOUR);
    await worker.tick(false);
    expect(products.calls).toEqual([LAST_WEEK]);
    expect([...f.store.statements.values()].map((s) => ({ kind: s.kind, periodStart: s.periodStart, status: s.status }))).toEqual([{ kind: 'PRODUCT', periodStart: '2026-11-16', status: 'NOTIFIED' }]);
  });
});

describe('J-T10 테넌트 격리', () => {
  test('[ASVS v5.0.0-8.2.1] J-T10 파트너 B가 A의 정산서 ID로 이의하면 없는 ID와 같은 404이고 settlement_authz_denied 한 줄을 남긴다', async () => {
    const f = await open();
    const a = await notified(f);
    const b = randomUUID();
    const missing = await f.dispute(b, randomUUID(), { reasonCode: 'GROSS_AMOUNT' });
    f.lines.length = 0;
    const headers = f.partnerHeaders(b);
    const foreign = await f.dispute(b, a.statementId, { reasonCode: 'GROSS_AMOUNT' }, headers);
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    const body = (r: { payload: string }) => {
      const { instance: _i, traceId: _t, ...rest } = JSON.parse(r.payload) as Record<string, unknown>;
      return rest;
    };
    expect(body(foreign)).toEqual(body(missing));
    const denied = f.lines.filter((l) => l.event === 'settlement_authz_denied');
    // 계정 ID 칸은 있되 플랫폼 로거가 값을 가린다(로그 가림 규칙)
    expect(denied).toEqual([expect.objectContaining({ level: 'warn', partnerId: b, accountId: expect.any(String), statementId: a.statementId, action: 'dispute' })]);
    // 금액은 로그에 싣지 않는다
    expect(JSON.stringify(denied)).not.toContain('24920000');
    expect(await f.store.listDisputes(a.statementId)).toEqual([]);
    expect((await f.store.findStatementById(a.statementId))?.status).toBe('NOTIFIED');
  });

  test('J-T10 파트너 B가 A의 회차 정산서를 조회하면 B의 것은 없고(빈 목록) 인가 실패 로그를 남긴다', async () => {
    const f = await open();
    const a = await notified(f);
    const b = randomUUID();
    f.lines.length = 0;
    const headers = f.partnerHeaders(b);
    const res = await f.svc.http.inject({ method: 'GET', url: `/v1/partner/events/${a.eventId}/settlements`, headers });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual([]);
    expect(f.lines.filter((l) => l.event === 'settlement_authz_denied')).toEqual([expect.objectContaining({ level: 'warn', partnerId: b, accountId: expect.any(String), eventId: a.eventId, action: 'list-event' })]);
    // A 자신의 조회는 정산서를 보고 로그를 남기지 않는다
    f.lines.length = 0;
    const own = await f.svc.http.inject({ method: 'GET', url: `/v1/partner/events/${a.eventId}/settlements`, headers: f.partnerHeaders(a.promoterId) });
    expect(JSON.parse(own.payload)).toHaveLength(1);
    expect(f.lines.filter((l) => l.event === 'settlement_authz_denied')).toEqual([]);
  });
});

describe('J-T1 계산(리뷰 RV-01 재현)', () => {
  // F-07-5 리뷰 RV-01(시험 담당 2026-11-23): 첫 시험은 승인 3,000만 + 전액 취소 200만을 '판매 대금 3,000만'으로 단언해 이중 차감을 굳혔다.
  // 정본 §13 J-T1(리뷰 반영으로 더한 섞인 예)대로 승인 2,800만 + 승인 뒤 전액 취소 200만(부정 예매 취소 포함)이면 판매 대금 3,000만·환급 200만·지급 2,492만이다.
  test('J-T1 승인 2,800만 + 승인 뒤 전액 취소 200만(FRAUD 포함)은 판매 대금 3,000만·환급 200만·수수료 280만·부가세 28만·지급 2,492만이고 원본 목록 합도 같다', () => {
    const approved = [fact({ amount: 20_000_000, status: 'APPROVED' }), fact({ amount: 8_000_000, status: 'APPROVED' })];
    // 부정 예매 운영자 취소(FRAUD) 1,200,000원과 일반 전액 취소 800,000원
    const cancelled = [fact({ amount: 1_200_000, cancelledAmount: 1_200_000, status: 'CANCELED' }), fact({ amount: 800_000, cancelledAmount: 800_000, status: 'CANCELED' })];
    const neverApproved = fact({ amount: 500_000, cancelledAmount: 0, status: 'CANCELED', approvedAt: null });
    const unreconciled = fact({ amount: 7_000_000, excludedReason: 'RECONCILIATION_MISMATCH' });
    const calc = (payments: ReturnType<typeof fact>[]) =>
      calculateEventStatement({ promoterId: randomUUID(), eventId: randomUUID(), pg: 'TOSS', pgStore: 'STANDARD', commissionRateBp: 1000, payments, kyc: undefined, account: undefined, now: new Date(NOTIFY_AT), statementId: randomUUID() });
    const { record, sources } = calc([...approved, ...cancelled, unreconciled]);
    expect(record).toMatchObject({ grossAmount: 30_000_000, refundAmount: 2_000_000, commissionAmount: 2_800_000, commissionVat: 280_000, payoutAmount: 24_920_000 });
    expect(sources.filter((x) => x.kind === 'GROSS').reduce((n, x) => n + x.amount, 0)).toBe(30_000_000);
    expect(sources.filter((x) => x.kind === 'REFUND').reduce((n, x) => n + x.amount, 0)).toBe(2_000_000);
    expect(record.excludedPayments).toEqual([`${unreconciled.paymentId}:RECONCILIATION_MISMATCH`]);
    // 승인된 적 없이 대사가 취소로 닫은 결제를 더해도 값·원본 목록이 같다(판매 대금·환급·원본 목록 어디에도 없다)
    const withNever = calc([...approved, ...cancelled, neverApproved, unreconciled]);
    expect(withNever.record).toMatchObject({ grossAmount: 30_000_000, refundAmount: 2_000_000, commissionAmount: 2_800_000, commissionVat: 280_000, payoutAmount: 24_920_000 });
    expect(withNever.sources.some((x) => x.paymentId === neverApproved.paymentId)).toBe(false);
    // 같은 회차를 전액 취소 없이 승인 3,000만 + 부분 환불 200만으로 만든 정산서와 금액이 같다(J-T1 첫 예)
    const partial = calc([fact({ amount: 30_000_000, cancelledAmount: 2_000_000, status: 'PARTIAL_CANCELED' })]);
    expect(withNever.record).toMatchObject({ grossAmount: partial.record.grossAmount, refundAmount: partial.record.refundAmount, payoutAmount: partial.record.payoutAmount });
  });
});

class ManualTimer implements SettlementDueTimer {
  intervalMs: number | undefined;
  setInterval(_fn: () => void, ms: number): unknown {
    this.intervalMs = ms;
    return 1;
  }
  clearInterval(): void {
    this.intervalMs = undefined;
  }
}
