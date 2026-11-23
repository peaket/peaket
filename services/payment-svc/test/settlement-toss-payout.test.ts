// J-T4·J-T34 토스페이먼츠 지급대행(BAT-630 LCH-110, settlement §5.2·§8, F-07-6 ADR-0369 결정 5·7로 고침).
// 10억 원 미만 분할·요청당 20건·같은 지급 건과 지급일의 같은 멱등키·실패 세 갈래·서명 웹훅과 단건 조회를 본다.
// F-07-6: 전송 포트는 상점을 첫 인자로 받고 결과 넷(ACCEPTED·REJECTED·NO_RESPONSE·PROCESSING)을 던지지 않고 돌려준다. 멱등키는 refPayoutId 목록과 지급일로 정한다.
// 게이트웨이 시험은 포트의 짝 가짜(아래 FakeTransport, 진짜 HttpTossPayoutTransport는 settlement-toss-transport.test.ts가 대역 서버로 본다)를 쓴다.
// 실행이 25억 원 정산서를 세 건으로 보내는 바깥 경계 시험은 settlement-toss-execute.test.ts J-T38 ①이 맡는다.
import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import type { PayoutBatchRecord, PayoutRecord, PgStore, TossSellerStatus } from '../src/modules/settlement/domain/settlement.js';
import { classifyTossFailure, groupTossPayoutRequests, splitTossPayoutAmount, verifyTossPayoutSignature } from '../src/modules/settlement/domain/payout-adapters.js';
import { TossPayoutGateway, tossIdempotencyKey } from '../src/modules/settlement/adapters/toss-payout-gateway.js';
import { ReceiveSettlementWebhook } from '../src/modules/settlement/application/receive-settlement-webhook.js';
import type { TossPayoutTransport, TossSellerRegistration, TossSendResult } from '../src/modules/settlement/domain/ports.js';
import { kst, tossHarness, type TossHarness } from './support/toss-harness.js';
import { tossWebhookBody } from './support/toss-payout-fake.js';

const AT = new Date('2026-11-22T00:00:00.000Z');

const payout = (amount: number, seq = 1, statementId = 'statement-1', payoutDate = '2026-12-01'): PayoutRecord => ({
  payoutId: randomUUID(),
  batchId: 'batch-1',
  statementId,
  seq,
  amount,
  refPayoutId: `${statementId}-${seq}`,
  pgPayoutId: null,
  status: 'REQUESTED',
  errorCode: null,
  pgTransferId: null,
  transferCheck: null,
  transferCheckedAt: null,
  payoutDate,
  failureClass: null,
  retryOfPayoutId: null,
  autoRetryCount: 0,
  createdAt: AT,
  updatedAt: AT,
});

function batch(): PayoutBatchRecord {
  return {
    batchId: 'batch-1',
    pg: 'TOSS',
    pgStore: 'STANDARD',
    payoutDate: '2026-12-01',
    totalAmount: 20_000,
    statementCount: 1,
    approvalId: 'approval-1',
    portoneBulkPayoutId: null,
    pgBalanceKrw: null,
    pgBalanceSource: null,
    pgBalanceObservedAt: null,
    pgBalanceObservedBy: null,
    pgBalanceLedgerKrw: null,
    status: 'APPROVED',
    submitAttempts: 0,
    nextSubmitAt: null,
    submitDeadlineAt: null,
    lastSubmitError: null,
    dateRetryUsed: false,
    createdAt: AT,
    updatedAt: AT,
  };
}

/** TossPayoutTransport 포트의 짝 가짜. 답은 시험이 줄 세운 결과(없으면 접수)다 */
class FakeTransport implements TossPayoutTransport {
  readonly requests: { pgStore: PgStore; payoutDate: string; idempotencyKey: string; refs: string[]; destinations: string[] }[] = [];
  readonly answers: TossSendResult[] = [];
  async requestPayouts(pgStore: PgStore, input: { payoutDate: string; idempotencyKey: string; items: readonly { refPayoutId: string; amount: number; tossSellerId: string }[] }): Promise<TossSendResult> {
    this.requests.push({ pgStore, payoutDate: input.payoutDate, idempotencyKey: input.idempotencyKey, refs: input.items.map((i) => i.refPayoutId), destinations: input.items.map((i) => i.tossSellerId) });
    return this.answers.shift() ?? { kind: 'ACCEPTED', payouts: input.items.map((i) => ({ refPayoutId: i.refPayoutId, pgPayoutId: `toss-${i.refPayoutId}`, status: 'REQUESTED' as const })) };
  }
  async getPayout(_s: PgStore, pgPayoutId: string) {
    return { pgPayoutId, status: 'IN_PROGRESS' as const };
  }
  async cancelPayout(_s: PgStore, pgPayoutId: string) {
    return { pgPayoutId, status: 'CANCELED' as const };
  }
  async registerSeller(_s: PgStore, body: TossSellerRegistration) {
    return { tossSellerId: `toss-${body.refSellerId}`, status: 'PARTIALLY_APPROVED' as TossSellerStatus };
  }
  async getSeller(_s: PgStore, tossSellerId: string) {
    return { tossSellerId, status: 'APPROVED' as TossSellerStatus };
  }
  async balance() {
    return { availableAmount: 0, pendingAmount: 0 };
  }
  async listSettlementFees() {
    return 0;
  }
}

const sellersOf = (rows: readonly PayoutRecord[]) => Object.fromEntries(rows.map((p) => [p.payoutId, 'FSEL-1']));

let h: TossHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('J-T34 토스 지급대행', () => {
  test('J-T4·J-T34 ① 25억 원을 999,999,999·999,999,999·500,000,002로 나누고, 요청당 20건(21건이면 요청 둘)으로 묶는다', () => {
    expect(splitTossPayoutAmount(2_500_000_000)).toEqual([999_999_999, 999_999_999, 500_000_002]);
    // 경계: 999,999,999는 한 건, 1,000,000,000은 두 건(10억 원 미만)
    expect(splitTossPayoutAmount(999_999_999)).toEqual([999_999_999]);
    expect(splitTossPayoutAmount(1_000_000_000)).toEqual([999_999_999, 1]);
    expect(splitTossPayoutAmount(1)).toEqual([1]);
    const twenty = Array.from({ length: 20 }, (_, i) => payout(1_000, 1, `s-${i}`));
    expect(groupTossPayoutRequests(twenty).map((g) => g.length)).toEqual([20]);
    expect(groupTossPayoutRequests([...twenty, payout(1_000, 1, 's-20')]).map((g) => g.length)).toEqual([20, 1]);
  });

  test('J-T4 게이트웨이가 21건을 요청 둘로 보내고, 접수 결과를 묶음별로 돌려준다(던지지 않는다)', async () => {
    const transport = new FakeTransport();
    const rows = Array.from({ length: 21 }, (_, i) => payout(10_000, 1, `s-${String(i).padStart(2, '0')}`));
    const result = await new TossPayoutGateway(transport).submit({ batch: batch(), payouts: rows, tossSellerIds: sellersOf(rows) });
    expect(transport.requests.map((r) => [r.pgStore, r.refs.length, r.payoutDate])).toEqual([
      ['STANDARD', 20, '2026-12-01'],
      ['STANDARD', 1, '2026-12-01'],
    ]);
    expect(transport.requests.flatMap((r) => r.destinations)).toEqual(rows.map(() => 'FSEL-1'));
    expect(result.status).toBe('SUBMITTED');
    expect(result.groups.map((g) => [g.refPayoutIds.length, g.result.kind, g.idempotencyKey])).toEqual([
      [20, 'ACCEPTED', tossIdempotencyKey(rows.slice(0, 20), '2026-12-01')],
      [1, 'ACCEPTED', tossIdempotencyKey(rows.slice(20), '2026-12-01')],
    ]);
  });

  test('J-T34 ② 같은 지급 건·같은 지급일은 같은 멱등키(차례 무관), 새 순번이나 바뀐 지급일은 새 키다', async () => {
    const rows = [payout(10_000), payout(10_000, 2)];
    expect(tossIdempotencyKey(rows, '2026-12-01')).toBe(tossIdempotencyKey([...rows].reverse(), '2026-12-01'));
    expect(tossIdempotencyKey(rows, '2026-12-01')).not.toBe(tossIdempotencyKey(rows, '2026-12-02'));
    expect(tossIdempotencyKey([payout(10_000, 3)], '2026-12-01')).not.toBe(tossIdempotencyKey([payout(10_000, 1)], '2026-12-01'));
    expect(tossIdempotencyKey([payout(1, 9)], '2026-12-01')).not.toBe(tossIdempotencyKey([payout(1, 10)], '2026-12-01'));
    const transport = new FakeTransport();
    const gateway = new TossPayoutGateway(transport);
    transport.answers.push({ kind: 'NO_RESPONSE' });
    const first = await gateway.submit({ batch: batch(), payouts: rows, tossSellerIds: sellersOf(rows) });
    expect(first.status).toBe('PENDING');
    await gateway.submit({ batch: batch(), payouts: rows, tossSellerIds: sellersOf(rows) });
    expect(transport.requests.map((r) => r.idempotencyKey)).toEqual([tossIdempotencyKey(rows, '2026-12-01'), tossIdempotencyKey(rows, '2026-12-01')]);
  });

  test('J-T34 ② 오류 응답·처리 중은 던지지 않고 묶음 결과로 돌려준다', async () => {
    const transport = new FakeTransport();
    const rows = [payout(10_000)];
    transport.answers.push({ kind: 'REJECTED', code: 'INVALID_DESTINATION' });
    const rejected = await new TossPayoutGateway(transport).submit({ batch: batch(), payouts: rows, tossSellerIds: sellersOf(rows) });
    expect(rejected.groups.map((g) => g.result)).toEqual([{ kind: 'REJECTED', code: 'INVALID_DESTINATION' }]);
    expect(rejected.status).toBe('PENDING');
    transport.answers.push({ kind: 'PROCESSING' });
    const processing = await new TossPayoutGateway(transport).submit({ batch: batch(), payouts: rows, tossSellerIds: sellersOf(rows) });
    expect(processing.groups.map((g) => g.result.kind)).toEqual(['PROCESSING']);
  });

  test('J-T34 ③ 실패 이유를 계좌·일시·한도/KYC 세 갈래와 모름으로 나눈다', () => {
    expect(classifyTossFailure('ACCOUNT_CLOSED')).toBe('ACCOUNT');
    expect(classifyTossFailure('BANK_NOT_FOUND')).toBe('ACCOUNT');
    expect(classifyTossFailure('BANK_MAINTENANCE')).toBe('TRANSIENT');
    expect(classifyTossFailure('TEMPORARY_ERROR')).toBe('TRANSIENT');
    expect(classifyTossFailure('KYC_REQUIRED')).toBe('LIMIT_KYC');
    expect(classifyTossFailure('LIMIT_EXCEEDED')).toBe('LIMIT_KYC');
    expect(classifyTossFailure('SOMETHING_NEW')).toBe('UNKNOWN');
  });

  test('J-T34 ④ 서명 웹훅은 본문을 믿지 않고 단건 조회로 확정하며, seller.changed는 그 상점 셀러 상태를 단건 조회로 바꾼다', async () => {
    const x = (h = await tossHarness({ now: kst('2026-12-04T10:00:00.000') }));
    const promoterId = randomUUID();
    const sellers = await x.partner(promoterId);
    const s = await x.confirmed({ promoterId, amount: 50_000, payoutDate: '2026-12-07' });
    await x.settlements.executeBatch(await x.approvedBatch({ payoutDate: '2026-12-07' }));
    const [p] = x.payoutsOf(s.statementId);
    x.fake.setPayout(p!.pgPayoutId!, 'FAILED', 'ACCOUNT_CLOSED');
    const receiver = new ReceiveSettlementWebhook({ config: x.config, transport: x.transport, settlements: x.settlements, store: x.store, now: () => new Date(x.clock.now()), log: x.log, signals: x.signals });
    const time = new Date(x.clock.now()).toISOString();
    const sign = (body: string) => `v1:${createHmac('sha256', x.keys.STANDARD.current).update(`${body}:${time}`).digest('base64')}`;
    const send = (body: string, id: string, signature = sign(body)) =>
      receiver.receive({ 'tosspayments-webhook-signature': signature, 'tosspayments-webhook-transmission-time': time, 'tosspayments-webhook-transmission-id': id }, Buffer.from(body));

    const body = tossWebhookBody('payout.changed', { id: p!.pgPayoutId!, status: 'COMPLETED' });
    expect(await send(body, 't-1')).toBe('ACCEPTED');
    expect(x.store.payouts.get(p!.payoutId)).toMatchObject({ status: 'FAILED', errorCode: 'ACCOUNT_CLOSED' });

    // 대역 서버에 그 셀러를 만들어 둔다(단건 조회가 KYC_REQUIRED를 준다)
    x.fake.sellers.set(sellers.STANDARD!, { id: sellers.STANDARD!, store: 'STANDARD', refSellerId: `${promoterId}-STANDARD`, businessType: 'CORPORATE', status: 'KYC_REQUIRED' });
    const sellerBody = tossWebhookBody('seller.changed', { id: sellers.STANDARD!, status: 'APPROVED' });
    expect(await send(sellerBody, 't-2')).toBe('ACCEPTED');
    expect(x.store.tossSellers.get(`${promoterId}:STANDARD`)?.status).toBe('KYC_REQUIRED');

    expect(await send(body, 't-3', 'v1:bad')).toBe('REJECTED');
    expect(verifyTossPayoutSignature({ signature: sign(body), secrets: [x.keys.STANDARD.current], body, transmissionTime: time, now: new Date(x.clock.now()) })).toBe('OK');
  });
});
