// 입금 전 취소와 입금 오류 되돌림의 규칙과 쓰임새(docs/features/payment.md §6 '입금 전 취소와 입금 오류 되돌림의 첫 구현', BUILD_ORDER HOT-152, P-T36 ④⑤). DB 없이 돈다. 실제 PostgreSQL·시뮬레이터는 test-int/payment-deposit.int.test.ts다.
import { createHmac } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PortoneGateway } from '../src/modules/payment/adapters/pg/portone-gateway.js';
import { TossPaymentGateway } from '../src/modules/payment/adapters/pg/toss-gateway.js';
import type { PaymentLedgerStatus } from '../src/modules/payment/domain/confirm-command.js';
import type { CancelResult, PaymentGatewayPort, QueryResult } from '../src/modules/payment/domain/payment-gateway.js';
import {
  buildPaymentEvent,
  cancelInputOf,
  cancelResponseOf,
  CancelDepositPayment,
  type DepositCancelBegin,
  type DepositCancelTarget,
  decideDepositCallback,
  decideDepositCancel,
  decideQueryAnswer,
  decideReversalAnswer,
  decideWebhookLedger,
  DEPOSIT_NOTIFIED_WINDOW_MS,
  depositCancelEventKey,
  depositCancelIdemKey,
  depositSecretHashOf,
  PaymentCancelStateError,
  PaymentInputError,
  PaymentNotFoundError,
  parseDepositCancel,
  reversalDueAtMs,
  type WebhookLedgerRow,
  withReversalCheck,
} from '../src/modules/payment/server.js';

const NOW = Date.parse('2026-11-09T01:00:00.000Z');
const ORDER = '0193a000-0000-7000-8000-000000000001';
const PAYMENT = '0193a000-0000-7000-8000-000000000002';
const EVENT = '0193a000-0000-7000-8000-000000000003';
const AMOUNT = 10_000;
const CANCELLATION = 'evt-cancel_01';

const found = (over: Partial<Extract<QueryResult, { kind: 'FOUND' }>> = {}): QueryResult => ({ kind: 'FOUND', paymentRef: 'tgen_1', orderRef: ORDER, status: 'WAITING_FOR_DEPOSIT', amount: AMOUNT, balanceAmount: AMOUNT, ...over });
const LEDGER = { orderId: ORDER, amount: AMOUNT, queryAttempts: 1 };

describe('입금 오류 확인의 조회 답', () => {
  test('P-T36 ④_결제사 상태가 입금 대기로 돌아왔을 때만 되돌린다 [ASVS v5.0.0-16.5.3]', () => {
    const va = { accountNumber: '562', bank: '20', dueAt: '2026-11-12T01:00:00Z' };
    expect(decideReversalAnswer(found({ virtualAccount: va }), LEDGER, NOW, NOW)).toEqual({ kind: 'REVERSE', virtualAccount: va });
  });

  test('P-T36 ④_아직 입금 완료면 원장을 바꾸지 않고 짧은 간격으로 다시 묻는다 [ASVS v5.0.0-16.5.3]', () => {
    expect(decideReversalAnswer(found({ status: 'APPROVED' }), LEDGER, NOW, NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'reversal_waiting', nextAtMs: NOW + 250 });
    expect(decideReversalAnswer(found({ status: 'APPROVED' }), { ...LEDGER, queryAttempts: 3 }, NOW, NOW)).toEqual({ kind: 'ASK_AGAIN', outcome: 'reversal_waiting', nextAtMs: NOW + 1_000 });
  });

  test('P-T36 ④_통보 뒤 10분이 지나도 입금 완료면 묻기를 끝낸다(원장은 그대로)', () => {
    expect(decideReversalAnswer(found({ status: 'APPROVED' }), LEDGER, NOW - DEPOSIT_NOTIFIED_WINDOW_MS, NOW)).toEqual({ kind: 'END' });
  });

  test.each(['CANCELED', 'PARTIAL_CANCELED', 'FAILED', 'EXPIRED'] as const)('P-T36 ④_%s는 되돌림이 아니라 묻기를 끝낸다', (status) => {
    expect(decideReversalAnswer(found({ status }), LEDGER, NOW, NOW)).toEqual({ kind: 'END' });
  });

  test('P-T36 ④_다른 주문의 답은 쓰지 않고 SEV1을 표시해 다시 묻는다 [ASVS v5.0.0-16.3.3]', () => {
    expect(decideReversalAnswer(found({ orderRef: 'other' }), LEDGER, NOW, NOW)).toMatchObject({ kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'order' });
  });

  test('P-T36 ④_금액이 다르면 되돌리지 않는다 [ASVS v5.0.0-2.2.3]', () => {
    expect(decideReversalAnswer(found({ amount: AMOUNT + 1 }), LEDGER, NOW, NOW)).toMatchObject({ kind: 'ASK_AGAIN', outcome: 'amount_mismatch', anomaly: 'amount' });
  });

  test('P-T36 ④_조회 실패·없음은 창 안에서 다시 묻는다', () => {
    expect(decideReversalAnswer({ kind: 'UNKNOWN' }, LEDGER, NOW, NOW)).toMatchObject({ kind: 'ASK_AGAIN', outcome: 'query_failed' });
    expect(decideReversalAnswer({ kind: 'NOT_FOUND' }, LEDGER, NOW, NOW)).toMatchObject({ kind: 'ASK_AGAIN', outcome: 'not_found' });
  });

  test.each<[string, QueryResult, string]>([
    ['조회 실패', { kind: 'UNKNOWN' }, 'query_failed'],
    ['기록 없음', { kind: 'NOT_FOUND' }, 'not_found'],
    ['금액 어긋남', found({ amount: AMOUNT + 1 }), 'amount_mismatch'],
    ['주문 어긋남', found({ orderRef: 'other' }), 'amount_mismatch'],
    ['처리 중', found({ status: 'IN_PROGRESS' }), 'reversal_waiting'],
  ])('P-T36 ④_리뷰 고침 H2: 창이 지나도 %s면 끝내지 않고 60초 뒤 다시 묻는다 [ASVS v5.0.0-16.5.3]', (_n, answer, outcome) => {
    const d = decideReversalAnswer(answer, LEDGER, NOW - DEPOSIT_NOTIFIED_WINDOW_MS, NOW);
    expect(d).toMatchObject({ kind: 'ASK_AGAIN', outcome, nextAtMs: NOW + 60_000 });
    expect(d).not.toHaveProperty('overdue');
  });

  test('P-T36 ④_리뷰 고침 H2: 답을 믿지 못한 채 통보 뒤 1시간이 되면 SEV1 표시를 싣고 계속 묻는다 [ASVS v5.0.0-16.3.4]', () => {
    expect(decideReversalAnswer({ kind: 'UNKNOWN' }, LEDGER, NOW - 3_600_000 + 1, NOW)).not.toHaveProperty('overdue');
    expect(decideReversalAnswer({ kind: 'UNKNOWN' }, LEDGER, NOW - 3_600_000, NOW)).toMatchObject({ kind: 'ASK_AGAIN', outcome: 'query_failed', nextAtMs: NOW + 60_000, overdue: true });
    expect(decideReversalAnswer({ kind: 'NOT_FOUND' }, LEDGER, undefined, NOW)).toMatchObject({ kind: 'ASK_AGAIN', overdue: true });
  });

  test('P-T36 ④_리뷰 고침 H2: 입금 완료라는 정상 답만 창이 지나면 경고로 끝난다(되돌림이 아니라 지연된 통보다)', () => {
    expect(decideReversalAnswer(found({ status: 'APPROVED' }), LEDGER, NOW - 2 * 3_600_000, NOW)).toEqual({ kind: 'END' });
  });
});

describe('다시 입금의 승인 시각', () => {
  const ledger = (reversedAtMs?: number) => ({ orderId: ORDER, amount: AMOUNT, queryAttempts: 1, deposit: { dueAtMs: NOW + 86_400_000, ...(reversedAtMs === undefined ? {} : { reversedAtMs }) } });
  const paidAt = (ms: number): QueryResult => found({ status: 'APPROVED', approvedAt: new Date(ms).toISOString() });

  test('P-T36 ④_리뷰 고침 L7: 결제사의 승인 시각이 그 결제의 T21보다 이르면 지금 시각을 쓴다(되돌리기 전 입금 시각이 정산 기준이 되지 않게)', () => {
    expect(decideQueryAnswer(paidAt(NOW - 7_200_000), ledger(NOW - 3_600_000), NOW)).toMatchObject({ kind: 'RESOLVE', finish: { status: 'APPROVED', approvedAtMs: NOW } });
  });

  test('P-T36 ④_리뷰 고침 L7: T21과 같거나 뒤면 결제사의 승인 시각을 그대로 쓴다', () => {
    expect(decideQueryAnswer(paidAt(NOW - 3_600_000), ledger(NOW - 3_600_000), NOW)).toMatchObject({ finish: { approvedAtMs: NOW - 3_600_000 } });
    expect(decideQueryAnswer(paidAt(NOW - 60_000), ledger(NOW - 3_600_000), NOW)).toMatchObject({ finish: { approvedAtMs: NOW - 60_000 } });
  });

  test('P-T36 ④_리뷰 고침 L7: 되돌린 적이 없으면 결제사의 승인 시각 그대로다', () => {
    expect(decideQueryAnswer(paidAt(NOW - 7_200_000), ledger(), NOW)).toMatchObject({ finish: { approvedAtMs: NOW - 7_200_000 } });
  });
});

describe('새 입금 기한', () => {
  test('P-T36 ④_리뷰 고침 M5: 지금 + 2시간 이상 남은 결제사 기한은 그대로 쓴다', () => {
    expect(reversalDueAtMs(NOW + 2 * 3_600_000, NOW)).toBe(NOW + 2 * 3_600_000);
    expect(reversalDueAtMs(NOW + 3 * 86_400_000, NOW)).toBe(NOW + 3 * 86_400_000);
  });

  test('P-T36 ④_리뷰 고침 M5: 결제사 기한이 지금 + 2시간보다 가까우면 쓰지 않고 공식으로 계산한다(입금할 시간을 준다)', () => {
    expect(reversalDueAtMs(NOW + 2 * 3_600_000 - 1, NOW)).toBe(Date.parse('2026-11-10T23:59:00+09:00'));
    expect(reversalDueAtMs(NOW + 60_000, NOW)).toBe(Date.parse('2026-11-10T23:59:00+09:00'));
  });

  test('P-T36 ④_기한이 지났거나 없으면 되돌림 시점의 다음 날 23:59 KST다', () => {
    const expected = Date.parse('2026-11-10T23:59:00+09:00');
    expect(reversalDueAtMs(NOW - 1, NOW)).toBe(expected);
    expect(reversalDueAtMs(undefined, NOW)).toBe(expected);
  });

  test('P-T36 ④_KST 날짜 경계를 따른다(UTC 15:00은 KST 다음 날이다)', () => {
    expect(reversalDueAtMs(undefined, Date.parse('2026-11-09T15:00:00.000Z'))).toBe(Date.parse('2026-11-11T23:59:00+09:00'));
  });
});

describe('입금 오류 통보의 판단', () => {
  const HASH = (): Buffer => depositSecretHashOf('secret-1');
  const row = (o: Partial<WebhookLedgerRow> = {}): WebhookLedgerRow => ({ paymentId: PAYMENT, orderId: ORDER, pg: 'TOSS', status: 'APPROVED', depositSecretHash: HASH(), ...o });
  const FOUND = { paymentId: PAYMENT, orderId: ORDER };

  test('P-T36 ④_맞는 secret의 되돌림 통보는 조회를 건다 [ASVS v5.0.0-8.2.2]', () => {
    const judged = decideDepositCallback(row(), ['TOSS'], HASH());
    expect(judged).toEqual({ decision: { kind: 'STATE_IGNORED', ...FOUND }, receipt: true });
    expect(withReversalCheck(row(), true, judged)).toEqual({ decision: { kind: 'REVERSAL_CHECK', ...FOUND }, receipt: true });
  });

  test('P-T36 ④_입금 확정 뒤에도 해시가 남아 위조 통보를 거른다 [ASVS v5.0.0-16.3.3]', () => {
    const judged = decideDepositCallback(row(), ['TOSS'], depositSecretHashOf('forged'));
    expect(judged).toEqual({ decision: { kind: 'DEPOSIT_SECRET_MISMATCH', orderId: ORDER }, receipt: false });
    expect(withReversalCheck(row(), true, judged)).toEqual(judged);
  });

  test('P-T36 ④_재전송(DONE)은 되돌림 확인을 걸지 않는다', () => {
    const judged = decideDepositCallback(row(), ['TOSS'], HASH());
    expect(withReversalCheck(row(), false, judged)).toEqual(judged);
  });

  test('P-T36 ④_해시가 없는 승인 원장은 보낸 쪽을 확인할 수 없어 조회를 걸지 않는다 [ASVS v5.0.0-16.5.3]', () => {
    const r = row({ depositSecretHash: undefined });
    const judged = decideDepositCallback(r, ['TOSS'], HASH());
    expect(judged.receipt).toBe(false);
    expect(withReversalCheck(r, true, judged)).toEqual(judged);
  });

  test('P-T36 ④_입금 대기·실패 원장은 되돌림 확인이 아니다', () => {
    for (const status of ['AWAITING_DEPOSIT', 'FAILED', 'UNKNOWN'] as const) {
      const r = row({ status });
      const judged = decideDepositCallback(r, ['TOSS'], HASH());
      expect(withReversalCheck(r, true, judged)).toEqual(judged);
    }
  });

  test('P-T36 ④_서명을 본 경로의 승인 원장도 되돌림 확인이다', () => {
    const r = row({ pg: 'PORTONE', depositSecretHash: undefined });
    const judged = { decision: decideWebhookLedger(r, ['PORTONE'], true), receipt: true };
    expect(withReversalCheck(r, true, judged).decision.kind).toBe('REVERSAL_CHECK');
  });
});

describe('어댑터의 되돌림 신호', () => {
  const toss = new TossPaymentGateway({ baseUrl: 'http://pg.test', secretKey: 'sim_sk_test', clientKey: 'sim_ck_test' });

  test.each([
    ['WAITING_FOR_DEPOSIT', true],
    ['DONE', false],
    ['CANCELED', false],
  ])('P-T36 ④_토스 입금 통보 %s의 되돌림 표시는 %s다', (status, reversed) => {
    const parsed = toss.parseWebhook({}, JSON.stringify({ secret: 's1', status, transactionKey: 'tk1', orderId: ORDER }));
    expect(parsed).toMatchObject({ kind: 'TRIGGER', dedupKey: `TOSS:deposit:tk1:${status}` });
    expect((parsed as { depositReversed?: true }).depositReversed === true).toBe(reversed);
  });

  const depositAt = (createdAt: unknown) => toss.parseWebhook({}, JSON.stringify({ createdAt, secret: 's1', status: 'WAITING_FOR_DEPOSIT', transactionKey: 'tk1', orderId: ORDER }));

  test('P-T36 ④_리뷰 고침 L8: 입금 통보 중복 키에 통보의 createdAt이 들어가 같은 거래의 두 번째 되돌림이 중복으로 버려지지 않는다', () => {
    const first = depositAt('2026-11-09T10:00:00.000000');
    const second = depositAt('2026-11-10T10:00:00.000000');
    expect(first).toMatchObject({ kind: 'TRIGGER', dedupKey: 'TOSS:deposit:tk1:WAITING_FOR_DEPOSIT:2026-11-09T10:00:00.000000' });
    expect(second).toMatchObject({ kind: 'TRIGGER', dedupKey: 'TOSS:deposit:tk1:WAITING_FOR_DEPOSIT:2026-11-10T10:00:00.000000' });
  });

  test.each([[undefined], [123], [''], ['가'.repeat(3)]])('P-T36 ④_리뷰 고침 L8: createdAt이 %s면 거래 키와 상태만으로 묶는다(통보를 버리지 않는다)', (createdAt) => {
    expect(depositAt(createdAt)).toMatchObject({ kind: 'TRIGGER', dedupKey: 'TOSS:deposit:tk1:WAITING_FOR_DEPOSIT' });
  });

  test.each([
    ['Transaction.VirtualAccountIssued', true],
    ['Transaction.Paid', false],
  ])('P-T36 ④_포트원 %s의 되돌림 표시는 %s다', (type, reversed) => {
    const key = Buffer.from('whsec-test-key-0123456789');
    const g = new PortoneGateway({ baseUrl: 'http://pg.test', secret: 'sec', storeId: 's', channelKey: 'c', webhookSecrets: [`whsec_${key.toString('base64')}`], isTest: true, clock: fakeClock({ now: NOW }) });
    const body = JSON.stringify({ type, data: { paymentId: `pay-${ORDER}` } });
    const ts = String(Math.floor(NOW / 1000));
    const sig = createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
    const parsed = g.parseWebhook({ 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, body);
    expect(parsed.kind).toBe('TRIGGER');
    expect((parsed as { depositReversed?: true }).depositReversed === true).toBe(reversed);
  });
});

describe('되돌림 사건', () => {
  const target = { paymentId: PAYMENT, orderId: ORDER, eventId: EVENT, attemptNo: 1, pg: 'TOSS' as const, amount: AMOUNT };

  test('P-T36 ④_종류는 DEPOSIT_REVERSED이고 새 기한을 싣는다(계좌번호는 싣지 않는다) [ASVS v5.0.0-16.2.5]', () => {
    const due = Date.parse('2026-11-12T01:00:00.000Z');
    const m = buildPaymentEvent({ target, seq: 5, nowMs: NOW, finish: { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT', reversed: true, deposit: { dueAtMs: due, accountNoSealed: 'sealed' } } });
    expect(m).toMatchObject({ type: 'DEPOSIT_REVERSED', eventSeq: 5, depositDueAt: new Date(due).toISOString(), occurredAt: new Date(NOW).toISOString() });
    expect(JSON.stringify(m)).not.toContain('sealed');
  });

  test('P-T36 ④_되돌림이 아닌 입금 대기는 그대로 AWAITING_DEPOSIT이다', () => {
    expect(buildPaymentEvent({ target, seq: 2, nowMs: NOW, finish: { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT' } }).type).toBe('AWAITING_DEPOSIT');
  });
});

describe('입금 전 취소의 입력·결과', () => {
  const INPUT = { paymentId: PAYMENT, cancellationId: CANCELLATION, reason: '회차 취소' };

  test('P-T36 ⑤_맞는 입력은 그대로다 [ASVS v5.0.0-2.2.1]', () => {
    expect(parseDepositCancel(INPUT)).toEqual(INPUT);
    expect(parseDepositCancel({ ...INPUT, amount: AMOUNT })).toEqual({ ...INPUT, amount: AMOUNT });
  });

  test.each([
    ['결제 ID', { paymentId: 'nope' }],
    ['결제 ID 대문자', { paymentId: PAYMENT.toUpperCase() }],
    ['취소 ID 빈 글', { cancellationId: '' }],
    ['취소 ID 긴 글', { cancellationId: 'a'.repeat(65) }],
    ['취소 ID 허용 밖', { cancellationId: 'a b' }],
    ['사유 빈 글', { reason: '' }],
    ['사유 긴 글', { reason: 'a'.repeat(201) }],
    ['금액 0', { amount: 0 }],
    ['금액 NaN', { amount: Number.NaN }],
  ])('P-T36 ⑤_틀린 입력은 INVALID_ARGUMENT다: %s [ASVS v5.0.0-2.2.1]', (_n, over) => {
    expect(() => parseDepositCancel({ ...INPUT, ...over })).toThrow(PaymentInputError);
  });

  test('P-T36 ⑤_멱등키는 cancel-{취소 ID}이고 event_key는 정해진 값이다', () => {
    expect(depositCancelIdemKey(CANCELLATION)).toBe(`cancel-${CANCELLATION}`);
    const k = depositCancelEventKey(PAYMENT, CANCELLATION);
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(depositCancelEventKey(PAYMENT, CANCELLATION)).toBe(k);
    expect(depositCancelEventKey(PAYMENT, 'other')).not.toBe(k);
  });

  const CANCELED = found({ status: 'CANCELED' });
  const WAITING = found();
  const ok: CancelResult = { outcome: 'CANCELLED' };
  test.each<[string, CancelResult, QueryResult, ReturnType<typeof decideDepositCancel>]>([
    ['조회가 취소면 끝낸다', ok, CANCELED, { kind: 'FINISH' }],
    ['취소 답을 잃어도 조회가 취소면 끝낸다', { outcome: 'UNKNOWN' }, CANCELED, { kind: 'FINISH' }],
    ['취소됐다는데 조회가 입금 대기면 처리 중이다', ok, WAITING, { kind: 'ANSWER', result: 'CANCEL_PENDING' }],
    ['결제사가 처리 중이면 처리 중이다', { outcome: 'CANCEL_PENDING' }, WAITING, { kind: 'ANSWER', result: 'CANCEL_PENDING' }],
    ['거절이고 입금 대기면 거절이다', { outcome: 'REJECTED' }, WAITING, { kind: 'ANSWER', result: 'REJECTED' }],
    ['답을 잃고 입금 대기면 모른다', { outcome: 'UNKNOWN' }, WAITING, { kind: 'ANSWER', result: 'UNKNOWN' }],
    ['입금이 먼저 들어왔으면 거절이다', ok, found({ status: 'APPROVED' }), { kind: 'ANSWER', result: 'REJECTED' }],
    ['조회 실패는 모른다', ok, { kind: 'UNKNOWN' }, { kind: 'ANSWER', result: 'UNKNOWN' }],
    ['다른 주문의 답은 모른다', ok, found({ status: 'CANCELED', orderRef: 'other' }), { kind: 'ANSWER', result: 'UNKNOWN' }],
  ])('P-T36 ⑤_결과는 조회가 정한다: %s [ASVS v5.0.0-16.5.3]', (_n, cancel, query, expected) => {
    expect(decideDepositCancel(cancel, query, { orderId: ORDER })).toEqual(expected);
  });

  test('P-T36 ⑤_gRPC 칸을 옮긴다', () => {
    expect(cancelInputOf({ payment_id: PAYMENT, cancellation_id: CANCELLATION, reason: 'r', amount: null })).toEqual({ paymentId: PAYMENT, cancellationId: CANCELLATION, reason: 'r' });
    expect(cancelInputOf({ payment_id: PAYMENT, cancellation_id: CANCELLATION, reason: 'r', amount: { krw: AMOUNT } }).amount).toBe(AMOUNT);
    expect(cancelResponseOf({ result: 'CANCELLED' })).toEqual({ result: 'CANCEL_RESULT_CANCELLED', cancelled_amount: { krw: 0 } });
  });
});

describe('입금 전 취소 쓰임새', () => {
  const TARGET: DepositCancelTarget = { paymentId: PAYMENT, orderId: ORDER, eventId: EVENT, attemptNo: 1, pg: 'TOSS', paymentRef: 'tgen_1', amount: AMOUNT };
  const INPUT = { paymentId: PAYMENT, cancellationId: CANCELLATION, reason: '회차 취소' };

  function fixture(o: { begin?: DepositCancelBegin; target?: DepositCancelTarget | null; cancel?: CancelResult; query?: QueryResult; finish?: 'APPLIED' | 'STALE'; status?: PaymentLedgerStatus; tokens?: number; onCancel?: () => Promise<void>; onQuery?: () => Promise<void> } = {}) {
    const calls: string[] = [];
    const cancels: Parameters<PaymentGatewayPort['cancel']>[0][] = [];
    const outcomes: string[] = [];
    const budgets: (number | undefined)[] = [];
    let tokens = o.tokens ?? 5;
    const clock = fakeClock({ now: NOW });
    const gateway = {
      pg: 'TOSS',
      cancel: async (c: Parameters<PaymentGatewayPort['cancel']>[0]) => {
        calls.push('cancel');
        cancels.push(c);
        await o.onCancel?.();
        return o.cancel ?? { outcome: 'CANCELLED' };
      },
      query: async () => {
        calls.push('query');
        await o.onQuery?.();
        return o.query ?? found({ status: 'CANCELED' });
      },
    } as unknown as PaymentGatewayPort;
    const uc = new CancelDepositPayment({
      store: {
        readCancelTarget: async () => (o.target === null ? undefined : (o.target ?? TARGET)),
        readCancelStatus: async () => {
          calls.push('status');
          return o.status;
        },
        beginDepositCancel: async (_t, _id, budget) => {
          calls.push('begin');
          budgets.push(budget?.remainingMs);
          return o.begin ?? 'BEGUN';
        },
        finishDepositCancel: async (_t, budget) => {
          calls.push('finish');
          budgets.push(budget?.remainingMs);
          return o.finish ?? 'APPLIED';
        },
      },
      gateways: { of: () => gateway },
      // 서킷 없는 채널의 보호기(서킷 열림은 test/pg-circuit.test.ts가 본다)
      guards: { of: () => ({ tryTakeToken: () => tokens-- > 0, circuitClosed: () => true, admitsQuery: () => true, run: <T>(action: () => Promise<T>) => action() }) as never },
      signals: { cancel: (x) => void outcomes.push(x) },
      clock,
    });
    return { uc, calls, cancels, outcomes, budgets, clock };
  }

  test('P-T36 ⑤_표시 → 취소 → 조회 → 답 반영 차례이고 CANCELLED다 [ASVS v5.0.0-2.3.3]', async () => {
    const f = fixture();
    await expect(f.uc.execute(INPUT)).resolves.toEqual({ result: 'CANCELLED' });
    expect(f.calls).toEqual(['begin', 'cancel', 'query', 'finish']);
    expect(f.cancels[0]).toMatchObject({ paymentRef: 'tgen_1', amount: 'ALL', reason: '회차 취소', idemKey: `cancel-${CANCELLATION}` });
    expect(f.outcomes).toEqual(['cancelled']);
  });

  test('P-T36 ⑤_없는 결제는 NOT_FOUND다', async () => {
    await expect(fixture({ target: null }).uc.execute(INPUT)).rejects.toThrow(PaymentNotFoundError);
  });

  test('P-T36 ⑤_입금 대기가 아니면 FAILED_PRECONDITION이고 결제사를 부르지 않는다 [ASVS v5.0.0-2.3.1]', async () => {
    const f = fixture({ begin: 'NOT_WAITING' });
    await expect(f.uc.execute(INPUT)).rejects.toThrow(PaymentCancelStateError);
    expect(f.calls).toEqual(['begin']);
    expect(f.outcomes).toEqual(['not_waiting']);
  });

  test('P-T36 ⑤_같은 취소 ID로 이미 끝났으면 부르지 않고 같은 답이다', async () => {
    const f = fixture({ begin: 'DONE' });
    await expect(f.uc.execute(INPUT)).resolves.toEqual({ result: 'CANCELLED' });
    expect(f.calls).toEqual(['begin']);
    expect(f.outcomes).toEqual(['replayed']);
  });

  test('P-T36 ⑤_금액이 전액이 아니면 INVALID_ARGUMENT이고 표시를 쓰지 않는다 [ASVS v5.0.0-2.2.1]', async () => {
    const f = fixture();
    await expect(f.uc.execute({ ...INPUT, amount: AMOUNT - 1 })).rejects.toThrow(PaymentInputError);
    expect(f.calls).toEqual([]);
  });

  test('P-T36 ⑤_토큰이 없으면 결제사를 부르지 않고 UNKNOWN이다', async () => {
    const f = fixture({ tokens: 0 });
    await expect(f.uc.execute(INPUT)).resolves.toEqual({ result: 'UNKNOWN' });
    expect(f.calls).toEqual(['begin']);
  });

  test.each<[PaymentLedgerStatus, string]>([
    ['FAILED', 'CANCELLED'],
    ['APPROVED', 'REJECTED'],
  ])('P-T36 ⑤_리뷰 고침 M3: 답을 쓰려니 그사이 %s면 %s로 답한다(기한 경과·입금과의 경합) [ASVS v5.0.0-15.4.1]', async (status, result) => {
    const f = fixture({ finish: 'STALE', status });
    await expect(f.uc.execute(INPUT)).resolves.toEqual({ result });
    expect(f.calls).toEqual(['begin', 'cancel', 'query', 'finish', 'status']);
  });

  test('P-T36 ⑤_리뷰 고침 M3: 다시 읽어도 어느 쪽도 아니면 UNKNOWN이다(부른 쪽이 같은 취소 ID로 다시 보낸다)', async () => {
    await expect(fixture({ finish: 'STALE' }).uc.execute(INPUT)).resolves.toEqual({ result: 'UNKNOWN' });
  });

  test('P-T36 ⑤_리뷰 고침 M3: 남은 시간이 모자라면 결제사를 부르지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', async () => {
    const f = fixture();
    await expect(f.uc.execute(INPUT, { remainingMs: 49 })).resolves.toEqual({ result: 'UNKNOWN' });
    expect(f.calls).toEqual(['begin']);
  });

  test('P-T36 ⑤_리뷰 고침 M3: 취소 호출이 시간을 다 쓰면 조회하지 않고 UNKNOWN이다', async () => {
    const f = fixture({
      onCancel: async () => {
        f.clock.advance(951);
      },
    });
    await expect(f.uc.execute(INPUT, { remainingMs: 1_000 })).resolves.toEqual({ result: 'UNKNOWN' });
    expect(f.calls).toEqual(['begin', 'cancel']);
  });

  test('P-T36 ⑤_리뷰 고침 M3: 조회가 시간을 다 쓰면 답을 쓰지 않고 UNKNOWN이다', async () => {
    const f = fixture({
      onQuery: async () => {
        f.clock.advance(951);
      },
    });
    await expect(f.uc.execute(INPUT, { remainingMs: 1_000 })).resolves.toEqual({ result: 'UNKNOWN' });
    expect(f.calls).toEqual(['begin', 'cancel', 'query']);
  });

  test('P-T36 ⑤_리뷰 고침 M3: 저장소에도 그때 남은 시간을 넘긴다', async () => {
    const f = fixture({
      onCancel: async () => {
        f.clock.advance(300);
      },
    });
    await f.uc.execute(INPUT, { remainingMs: 1_000 });
    expect(f.budgets).toEqual([1_000, 700]);
  });

  test('P-T36 ⑤_리뷰 고침 M3: 결제사가 답하지 않아도 남은 시간 안에 UNKNOWN으로 답한다', async () => {
    const never = () => new Promise<void>(() => {});
    const f = fixture({ onCancel: never, onQuery: never });
    await expect(f.uc.execute(INPUT, { remainingMs: 120 })).resolves.toEqual({ result: 'UNKNOWN' });
  }, 3_000);

  test('P-T36 ⑤_입금이 먼저 들어왔으면 원장을 쓰지 않고 REJECTED다 [ASVS v5.0.0-16.5.3]', async () => {
    const f = fixture({ query: found({ status: 'APPROVED' }) });
    await expect(f.uc.execute(INPUT)).resolves.toEqual({ result: 'REJECTED' });
    expect(f.calls).toEqual(['begin', 'cancel', 'query']);
  });
});
