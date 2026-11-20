// BAT-425 리뷰 3 RV-28(높음): 앞 시도(a0)가 결제사에서 CANCEL_PENDING으로 남았을 때 팬이 새 계좌를 내면
// purchase는 시도 번호를 1로 올리지만 payment는 앞 CANCEL_PENDING 때문에 a1 행을 만들지 않고 UNKNOWN을 준다.
// 그대로 두면 재시도 루프가 없는 a1만 보내 INVALID_ARGUMENT(→UNKNOWN)를 5회 소진하고 CS '환급 실패'로 끝나며,
// a0는 다시 조회되지 않아 늦게 반영돼도 찾지 못한다. 새 계좌 요청은 시도 번호를 되돌려(a0 유지) 재시도가 a0를
// 계속 조회하게 해야 한다(ADR-0316 결정 4·B9, docs/features/payment.md §4.1 '지연 환급 계좌 다시 받기의 두 번째 시도').
//
// 이 파일은 DB 없이 RequestRefundAccount와 RefundAfterEntry를 실제 유스케이스로 엮어 본다. payment는 payment-svc의
// 답(첫 시도 CANCEL_PENDING, 새 계좌 시도 UNKNOWN, 늦게 반영된 a0 조회 CANCELLED)을 흉내 내는 대역이다.
// 실제 PostgreSQL·gRPC는 test-int/cancellation.int.test.ts의 P-T76 ③_RV28 시험이 본다.
import { describe, expect, test } from 'vitest';
import {
  RefundAfterEntry,
  RequestRefundAccount,
  type CancellationRecord,
  type CancellationWrites,
  type PaymentCancelOutcome,
  type PaymentCancellations,
  type RefundAccount,
  type RefundAccountWrites,
} from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-20T09:00:00.000Z');
const MINUTE = 60_000;
const ACCOUNT_ID = '0193f425-0000-7000-8000-000000000011';
const ORDER_ID = '0193f425-0000-7000-8000-0000000000a1';
const TICKET_ID = '0193f425-0000-7000-8000-0000000000d1';
const CANCELLATION_ID = '0193f425-0000-7000-8000-0000000000c1';
const IDEM = '0193f425-0000-7000-8000-0000000000e1';
const REFUND_AMOUNT = 90_000;
const ACCOUNT: RefundAccount = { bankCode: '88', accountNumber: '110-987-654321', holderName: '김환불' };

/** 0030의 order_cancellation.refund_attempt·0031의 답 칸까지 흉내 내는 메모리 행 */
interface Row extends CancellationRecord {
  state: 'REFUND_PENDING' | 'REFUNDED';
  refundAttempts: number;
  refundAttempt: number;
  refundAccountRequired: boolean;
  refundAccountIdemKey?: string;
  refundAccountAnswer?: 'REFUNDED' | 'REFUND_PENDING' | 'REFUND_ACCOUNT_REQUIRED' | 'REJECTED';
  nextRefundAtMs?: number | null;
  failedAtMs?: number;
}

interface PaymentCall {
  readonly refundAttempt: number;
  readonly hasAccount: boolean;
}

/**
 * payment-svc 대역. a0가 CANCEL_PENDING인 동안 새 계좌 시도(attempt>0)는 행을 만들지 않고 UNKNOWN이며,
 * a0가 늦게 반영되면 계좌 없는 attempt 0의 재시도 조회가 CANCELLED로 정산된다.
 */
function paymentDouble(o: { a0: 'CANCEL_PENDING' | 'CANCELED' }) {
  const calls: PaymentCall[] = [];
  let sends = 0;
  const port: PaymentCancellations = {
    cancel: async (q): Promise<PaymentCancelOutcome> => {
      calls.push({ refundAttempt: q.refundAttempt ?? 0, hasAccount: q.refundAccount !== undefined });
      if ((q.refundAttempt ?? 0) > 0) return 'UNKNOWN';
      if (q.refundAccount !== undefined) {
        sends++;
        return o.a0 === 'CANCELED' ? 'CANCELLED' : 'PENDING';
      }
      return o.a0 === 'CANCELED' ? 'CANCELLED' : 'REFUND_ACCOUNT_REQUIRED';
    },
  };
  return { port, calls, sends: () => sends, setA0: (v: 'CANCEL_PENDING' | 'CANCELED') => void (o.a0 = v) };
}

/**
 * RV-28의 고침은 '결제사가 새 시도를 만들지 않았을 때 시도 번호를 되돌리는 쓰기'를 더한다.
 * 그 쓰기의 이름은 구현이 정하므로(이 커밋은 제품 코드를 고치지 않는다) 대역은 ① clearWaiting의 refundAttempt 칸과
 * ② 모르는 이름의 시도 되돌리기 쓰기를 모두 받아 준다. 그래야 이름과 상관없이 같은 시험으로 확인한다.
 */
function writesDouble(row: Row) {
  const keys = new Map<string, number>();
  const failures: { cancellationId: string; attempts: number; lastError: string }[] = [];
  const detail = (attempt: number) => ({ attempt, orderId: row.orderId, ticketId: row.ticketId, refundAmount: row.refundAmount, reason: 'USER' as const, retryAttempts: row.refundAttempts });
  const base: CancellationWrites & RefundAccountWrites = {
    create: async () => {
      throw new Error('이 시험은 취소 행을 만들지 않는다');
    },
    dueRefunds: async (nowMs) =>
      row.state === 'REFUND_PENDING' && !row.refundAccountRequired && row.failedAtMs === undefined && (row.nextRefundAtMs == null || row.nextRefundAtMs <= nowMs)
        ? [{ cancellationId: row.cancellationId, orderId: row.orderId, ticketId: row.ticketId, amount: row.refundAmount, reason: 'USER', status: 'REFUND_PENDING', attempts: row.refundAttempts, refundAttempt: row.refundAttempt }]
        : [],
    updateStatus: async (q) => {
      if (row.state !== 'REFUND_PENDING') return false;
      row.state = q.status === 'REFUNDED' ? 'REFUNDED' : row.state;
      row.nextRefundAtMs = null;
      return true;
    },
    scheduleRefundRetry: async (q) => {
      row.refundAttempts = q.attempts;
      row.nextRefundAtMs = q.nextRetryAtMs;
      return true;
    },
    markRefundFailed: async (q) => {
      failures.push({ cancellationId: q.cancellationId, attempts: q.attempts, lastError: q.lastError });
      row.failedAtMs = q.nowMs;
      return true;
    },
    markRefundAccountRequired: async () => {
      row.refundAccountRequired = true;
      row.nextRefundAtMs = null;
      return true;
    },
    beginAttempt: async (q) => {
      const keyId = q.idempotency === undefined ? undefined : `${q.cancellationId}:${q.idempotency.key}`;
      const replayed = keyId === undefined ? undefined : keys.get(keyId);
      if (replayed !== undefined && row.state === 'REFUND_PENDING') return detail(replayed);
      if (row.state !== 'REFUND_PENDING' || !row.refundAccountRequired || row.refundAttempt !== q.oldAttempt || row.refundAttempt >= 3) return undefined;
      row.refundAttempt += 1;
      row.refundAccountIdemKey = q.idempotency?.key;
      if (keyId !== undefined) keys.set(keyId, row.refundAttempt);
      return detail(row.refundAttempt);
    },
    clearWaiting: async (q) => {
      // 구현이 clearWaiting에 시도 번호를 더하는 경우(가장 작은 고침)
      const restore = (q as typeof q & { readonly refundAttempt?: number }).refundAttempt;
      if (typeof restore === 'number') row.refundAttempt = restore;
      row.refundAccountRequired = false;
      row.nextRefundAtMs = q.nextRefundAtMs ?? null;
      if (q.answer !== undefined) row.refundAccountAnswer = q.answer.answer;
    },
    markFailed: async (q) => {
      row.refundAccountRequired = false;
      row.nextRefundAtMs = null;
      row.failedAtMs = q.nowMs;
      if (q.answer !== undefined) row.refundAccountAnswer = q.answer.answer;
      return true;
    },
    saveAnswer: async (q) => {
      row.refundAccountAnswer = q.answer;
    },
    requestHashOf: async () => undefined,
  };
  // 구현이 다른 이름의 '시도 되돌리기' 쓰기를 더해도 같은 시험으로 확인한다(모르는 이름은 인자의 시도 번호로 되돌린다)
  const writes = new Proxy(base, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string') return undefined;
      return async (q: { readonly attempt?: number; readonly oldAttempt?: number; readonly refundAttempt?: number } = {}) => {
        const to = q.attempt ?? q.refundAttempt ?? q.oldAttempt;
        if (typeof to === 'number') row.refundAttempt = to;
      };
    },
  }) as CancellationWrites & RefundAccountWrites;
  return { writes, failures };
}

describe('R-T42 ④·RV-28 앞 시도 CANCEL_PENDING과 새 계좌 시도', () => {
  test('R-T42 ④_RV28_a0가_CANCEL_PENDING이면_새_계좌_요청은_시도를_올리지_않고_재시도가_a0를_조회해_REFUNDED로_끝난다', async () => {
    const row: Row = {
      cancellationId: CANCELLATION_ID,
      orderId: ORDER_ID,
      ticketId: TICKET_ID,
      refundAmount: REFUND_AMOUNT,
      state: 'REFUND_PENDING',
      refundAttempts: 1,
      refundAttempt: 0,
      refundAccountRequired: true,
      nextRefundAtMs: null,
    };
    const payment = paymentDouble({ a0: 'CANCEL_PENDING' });
    const { writes, failures } = writesDouble(row);
    const orders = {
      findCancellation: async (id: string) => (id === CANCELLATION_ID ? row : undefined),
      findByTicket: async (id: string) => (id === TICKET_ID ? { payerAccountId: ACCOUNT_ID, orderId: ORDER_ID } : undefined),
    };
    const request = new RequestRefundAccount({ orders: orders as never, writes, payments: payment.port, nowMs: () => NOW });
    await expect(
      request.run({ accountId: ACCOUNT_ID, cancellationId: CANCELLATION_ID, account: ACCOUNT, reauthToken: undefined, idempotencyKey: IDEM }),
    ).resolves.toEqual({ cancellationId: CANCELLATION_ID, status: 'REFUND_PENDING', refundAmount: REFUND_AMOUNT });

    // 새 계좌 시도는 payment에 attempt 1로 닿았지만 payment는 a1 행을 만들지 않았다. purchase는 a0(0)를 유지한다
    expect(payment.calls).toEqual([{ refundAttempt: 1, hasAccount: true }]);
    expect(payment.sends(), '새 전송 0(이중 환급 0)').toBe(0);
    expect(row.refundAttempt, 'RV-28: 새 계좌 요청 뒤 refund_attempt는 0').toBe(0);
    expect(row.failedAtMs, 'CS 환급 실패 0').toBeUndefined();

    // a0가 늦게 결제사에서 반영됐다: 계좌 없는 attempt 0의 재시도가 a0를 조회해 끝낸다
    payment.setA0('CANCELED');
    const notices: unknown[] = [];
    const retry = new RefundAfterEntry({
      writes,
      payments: payment.port,
      entries: { lookup: async (ids) => new Map(ids.map((id) => [id, { found: true, entered: false }])) },
      claims: { claimDue: async () => true, markEntryRecorded: async () => true },
      failureNotice: { open: async (q) => void notices.push(q) },
      nowMs: () => NOW + 10 * MINUTE,
    });
    await expect(retry.run()).resolves.toEqual({ refunded: 1, pending: 0, failed: 0, entryRecorded: 0, unverified: 0, held: 0 });

    // 재시도는 a0(refundAttempt 0, 계좌 없음)를 조회했고, 새 전송·새 시도는 없다
    expect(payment.calls).toEqual([
      { refundAttempt: 1, hasAccount: true },
      { refundAttempt: 0, hasAccount: false },
    ]);
    expect(payment.sends(), '새 전송 0(이중 환급 0)').toBe(0);
    expect(row.state).toBe('REFUNDED');
    expect(row.refundAttempt, '끝난 뒤에도 시도는 a0(0)').toBe(0);
    expect(row.refundAttempts, '재시도 횟수는 늘지 않았다').toBe(1);
    expect(failures, 'CS 환급 실패 0').toEqual([]);
    expect(notices, 'CS 환급 실패 0').toEqual([]);
  });
});
