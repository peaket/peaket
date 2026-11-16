// 결제 후 일반 취소(부분·전액)의 쓰임새(GAT-080, docs/features/payment.md §4.1 '취소 건 기록과 기대 잔액', P-T21). DB 없이 돈다.
// 저장소는 가짜다: begin이 돌려주는 취소 건(payment_cancel 한 행)의 값을 시험마다 정하고, 쓰임새가 그 값을 그대로 결제사에 보내는지 본다.
// 일부러 원장(target)의 값과 저장한 건(record)의 값을 다르게 둔다. 쓰임새가 원장에서 금액·기대 잔액을 다시 계산하면 잡힌다.
// 시간 값은 정본 값을 글자로 적는다(10분 = 600,000ms, 3시간 = 10,800,000ms). 코드 상수를 가져오지 않는다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  CancelConfirmedPayment,
  type ConfirmedCancelBegin,
  type ConfirmedCancelRecord,
  type ConfirmedCancelTarget,
  PaymentCancelStateError,
  PaymentInputError,
  PaymentNotFoundError,
  settleByBalance,
  canSettleByBalance,
} from '../src/modules/payment/server.js';
import type { CancelResult, PaymentGatewayPort, QueryOptions, QueryResult } from '../src/modules/payment/domain/payment-gateway.js';

const NOW = Date.parse('2026-11-13T01:00:00.000Z');
const PAYMENT = '0193a000-0000-7000-8000-000000000002';
const ORDER = '0193a000-0000-7000-8000-000000000001';
const EVENT = '0193a000-0000-7000-8000-000000000003';
const CANCEL = 'cancel_01';
/** 결제 100,000원 · 누적 취소 20,000원(남은 80,000원) */
const TARGET: ConfirmedCancelTarget = {
  paymentId: PAYMENT,
  orderId: ORDER,
  eventId: EVENT,
  pg: 'PORTONE',
  paymentRef: 'pay_ref_1',
  txId: 'tx_1',
  amount: 100_000,
  cancelledAmount: 20_000,
  status: 'PARTIAL_CANCELED',
};
const record = (over: Partial<ConfirmedCancelRecord> = {}): ConfirmedCancelRecord => ({
  idemKey: `cancel-${CANCEL}`,
  amount: 30_000,
  reason: '관객 취소',
  fullCancel: false,
  expectedBalance: 80_000,
  status: 'REQUESTED',
  createdAtMs: NOW,
  ...over,
});
const begun = (over: Partial<ConfirmedCancelRecord> = {}, replay = false): ConfirmedCancelBegin => ({ status: 'BEGUN', record: record(over), replay });

type CancelBody = Parameters<PaymentGatewayPort['cancel']>[0];

function fixture(
  o: {
    target?: ConfirmedCancelTarget | null;
    begin?: ConfirmedCancelBegin;
    finish?: { status: 'APPLIED' | 'STALE'; cancelledAmount: number };
    cancel?: CancelResult;
    query?: QueryResult;
    /** 3시간 지난 재시도의 저장소 판정(리뷰 B1). 없으면 원장이 기대 잔액 그대로이고 다른 진행 중 건이 없을 때의 판정을 흉내 낸다 */
    settle?: { status: 'APPLIED'; cancelledAmount: number } | { status: 'RESEND' } | { status: 'UNDECIDABLE' };
  } = {},
) {
  const calls: string[] = [];
  const begins: { cancellationId: string; amount?: number; reason: string }[] = [];
  const cancels: CancelBody[] = [];
  const queries: { paymentRef: string; options?: QueryOptions }[] = [];
  const finishes: string[] = [];
  const marks: [string, 'CANCEL_PENDING' | 'FAILED'][] = [];
  const settles: [string, number][] = [];
  const gateway = {
    pg: 'PORTONE',
    cancel: async (c: CancelBody) => {
      calls.push('cancel');
      cancels.push(c);
      return o.cancel ?? { outcome: 'CANCELLED' };
    },
    query: async (paymentRef: string, options?: QueryOptions) => {
      calls.push('query');
      queries.push({ paymentRef, ...(options === undefined ? {} : { options }) });
      return o.query ?? { kind: 'UNKNOWN' };
    },
  } as unknown as PaymentGatewayPort;
  const uc = new CancelConfirmedPayment({
    store: {
      readConfirmedCancelTarget: async () => {
        calls.push('read');
        return o.target === null ? undefined : (o.target ?? TARGET);
      },
      beginConfirmedCancel: async (_t, q) => {
        calls.push('begin');
        begins.push({ ...q });
        return o.begin ?? begun();
      },
      finishConfirmedCancel: async (_t, id) => {
        calls.push('finish');
        finishes.push(id);
        return o.finish ?? { status: 'APPLIED', cancelledAmount: 50_000 };
      },
      markConfirmedCancel: async (_t, id, status) => {
        calls.push('mark');
        marks.push([id, status]);
      },
      settleConfirmedCancelByQuery: async (_t, id, balanceAmount) => {
        calls.push('settle');
        settles.push([id, balanceAmount]);
        if (o.settle) return o.settle;
        const r = o.begin?.status === 'BEGUN' ? o.begin.record : record();
        if (balanceAmount === r.expectedBalance - r.amount) return { status: 'APPLIED', cancelledAmount: 50_000 };
        if (balanceAmount === r.expectedBalance) return { status: 'RESEND' };
        return { status: 'UNDECIDABLE' };
      },
    },
    gateways: { of: () => gateway },
    guards: { of: () => ({ tryTakeToken: () => true, circuitClosed: () => true }) as never },
    clock: fakeClock({ now: NOW }),
  });
  return { uc, calls, begins, cancels, queries, finishes, marks, settles };
}

const input = (over: Partial<{ amount: number; reason: string }> = {}) => ({ paymentId: PAYMENT, cancellationId: CANCEL, reason: over.reason ?? '관객 취소', ...(over.amount === undefined ? {} : { amount: over.amount }) });

describe('결제 후 일반 취소: 저장한 취소 건으로 보낸다', () => {
  test('GAT-080 P1 첫 전송은 기대 잔액을 보내고 남은 전부일 때만 ALL이다: 요청 30,000은 금액 30,000·기대 잔액 80,000', async () => {
    const f = fixture({ begin: begun({ amount: 30_000, fullCancel: false, expectedBalance: 80_000 }) });
    await expect(f.uc.execute(input({ amount: 30_000 }))).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 50_000 });
    expect(f.begins).toEqual([{ cancellationId: CANCEL, amount: 30_000, reason: '관객 취소' }]);
    expect(f.cancels).toEqual([{ paymentRef: 'pay_ref_1', amount: 30_000, reason: '관객 취소', idemKey: `cancel-${CANCEL}`, expectedBalance: 80_000 }]);
    expect(f.finishes).toEqual([CANCEL]);
    expect(f.calls).toEqual(['read', 'begin', 'cancel', 'finish']);
  });

  test('GAT-080 P1 남은 전부(80,000)이고 진행 중 건이 없어 저장소가 전액으로 적었으면 ALL과 기대 잔액 80,000을 보낸다', async () => {
    const f = fixture({ begin: begun({ amount: 80_000, fullCancel: true, expectedBalance: 80_000 }) });
    await f.uc.execute(input({ amount: 80_000 }));
    expect(f.cancels).toEqual([{ paymentRef: 'pay_ref_1', amount: 'ALL', reason: '관객 취소', idemKey: `cancel-${CANCEL}`, expectedBalance: 80_000 }]);
  });

  test('GAT-080 P1 금액을 비운 요청은 금액 없이 저장소에 넘기고 저장소가 전액으로 적은 대로 ALL을 보낸다', async () => {
    const f = fixture({ begin: begun({ amount: 80_000, fullCancel: true, expectedBalance: 80_000 }) });
    await f.uc.execute(input());
    expect(f.begins).toEqual([{ cancellationId: CANCEL, reason: '관객 취소' }]);
    expect(f.cancels[0]).toMatchObject({ amount: 'ALL', expectedBalance: 80_000 });
  });

  test('GAT-080 P1 진행 중 다른 건이 있어 저장소가 전액이 아니라고 적었으면 80,000이 남은 전부여도 금액 80,000으로 보낸다', async () => {
    const f = fixture({ begin: begun({ amount: 80_000, fullCancel: false, expectedBalance: 80_000 }) });
    await f.uc.execute(input({ amount: 80_000 }));
    expect(f.cancels).toEqual([{ paymentRef: 'pay_ref_1', amount: 80_000, reason: '관객 취소', idemKey: `cancel-${CANCEL}`, expectedBalance: 80_000 }]);
  });

  test('GAT-080 P2 재시도는 원장(누적 25,000)에서 다시 계산하지 않고 저장한 기대 잔액 80,000·사유를 그대로 보낸다', async () => {
    const f = fixture({ target: { ...TARGET, cancelledAmount: 25_000 }, begin: begun({ amount: 30_000, reason: '관객 취소', expectedBalance: 80_000 }, true) });
    await f.uc.execute(input({ amount: 30_000, reason: '다시 보낸 다른 사유' }));
    expect(f.cancels).toEqual([{ paymentRef: 'pay_ref_1', amount: 30_000, reason: '관객 취소', idemKey: `cancel-${CANCEL}`, expectedBalance: 80_000 }]);
  });

  test('GAT-080 P3 같은 결제의 다른 취소가 10분 안에 진행 중(BUSY)이면 결제사를 부르지 않고 결과 모름이며 지금 누적액을 준다', async () => {
    const f = fixture({ begin: { status: 'BUSY' } });
    await expect(f.uc.execute(input({ amount: 30_000 }))).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 20_000 });
    expect(f.cancels).toHaveLength(0);
    expect(f.queries).toHaveLength(0);
    expect(f.finishes).toHaveLength(0);
    expect(f.marks).toHaveLength(0);
  });

  test('GAT-080 P4 저장소가 그 건이 CANCELED(DONE)라고 하면 결제사를 부르지 않고 CANCELLED와 그 누적액이다', async () => {
    const f = fixture({ begin: { status: 'DONE', cancelledAmount: 50_000 } });
    await expect(f.uc.execute(input({ amount: 30_000 }))).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 50_000 });
    expect(f.cancels).toHaveLength(0);
    expect(f.finishes).toHaveLength(0);
  });

  test('GAT-080 P4 원장이 PARTIAL_CANCELED여도 저장소가 BEGUN이면 보낸다(원장 상태로 끝남을 가르지 않는다)', async () => {
    const f = fixture({ target: { ...TARGET, status: 'PARTIAL_CANCELED' }, begin: begun({}, true) });
    await f.uc.execute(input({ amount: 30_000 }));
    expect(f.cancels).toHaveLength(1);
  });

  test('GAT-080 P7 남은 금액과 진행 중 합을 넘는 요청(OVER_REMAINING)·같은 ID의 다른 금액(AMOUNT_MISMATCH)은 결제사를 부르지 않고 입력 오류다', async () => {
    for (const status of ['OVER_REMAINING', 'AMOUNT_MISMATCH'] as const) {
      const f = fixture({ begin: { status } });
      await expect(f.uc.execute(input({ amount: 50_001 }))).rejects.toThrow(PaymentInputError);
      expect(f.cancels).toHaveLength(0);
      expect(f.queries).toHaveLength(0);
    }
  });

  test('GAT080_승인_전_상태(NOT_CONFIRMED)·남은_금액_없음(NO_BALANCE)은_상태_오류이고_없는_결제는_NOT_FOUND다', async () => {
    for (const status of ['NOT_CONFIRMED', 'NO_BALANCE'] as const) {
      const f = fixture({ begin: { status } });
      await expect(f.uc.execute(input())).rejects.toThrow(PaymentCancelStateError);
      expect(f.cancels).toHaveLength(0);
    }
    const missing = fixture({ target: null });
    await expect(missing.uc.execute(input())).rejects.toThrow(PaymentNotFoundError);
    expect(missing.calls).toEqual(['read']);
  });

  test('GAT-080 P9 결제사 거절은 행을 FAILED로, 비동기 처리는 CANCEL_PENDING으로 남기고 원장 반영(finish)은 하지 않는다', async () => {
    const rejected = fixture({ cancel: { outcome: 'REJECTED' } });
    await expect(rejected.uc.execute(input({ amount: 30_000 }))).resolves.toEqual({ result: 'REJECTED', cancelledAmount: 20_000 });
    expect(rejected.marks).toEqual([[CANCEL, 'FAILED']]);
    expect(rejected.finishes).toHaveLength(0);

    const pending = fixture({ cancel: { outcome: 'CANCEL_PENDING' } });
    await expect(pending.uc.execute(input({ amount: 30_000 }))).resolves.toEqual({ result: 'CANCEL_PENDING', cancelledAmount: 20_000 });
    expect(pending.marks).toEqual([[CANCEL, 'CANCEL_PENDING']]);
    expect(pending.finishes).toHaveLength(0);
  });

  test('GAT080_결제사_결과_모름은_행·원장을_바꾸지_않는다', async () => {
    const f = fixture({ cancel: { outcome: 'UNKNOWN' } });
    await expect(f.uc.execute(input({ amount: 30_000 }))).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 20_000 });
    expect(f.marks).toHaveLength(0);
    expect(f.finishes).toHaveLength(0);
  });

  test('GAT080_결제사가_취소했다는데_원장이_그사이_바뀌었으면(STALE)_UNKNOWN이다', async () => {
    const f = fixture({ finish: { status: 'STALE', cancelledAmount: 20_000 } });
    await expect(f.uc.execute(input({ amount: 30_000 }))).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 20_000 });
  });
});

describe('GAT-080 P10 금액을 비운 요청과 진행 중인 다른 취소(BAT-415 계획 §10 ①)', () => {
  test('GAT-080 P10 금액을 비운 요청에 저장소가 진행 중 합을 뺀 50,000을 금액으로 적었으면 ALL이 아니라 50,000·기대 잔액 80,000으로 보낸다', async () => {
    const f = fixture({ begin: begun({ amount: 50_000, fullCancel: false, expectedBalance: 80_000 }) });
    await f.uc.execute(input());
    expect(f.begins).toEqual([{ cancellationId: CANCEL, reason: '관객 취소' }]);
    expect(f.cancels).toEqual([{ paymentRef: 'pay_ref_1', amount: 50_000, reason: '관객 취소', idemKey: `cancel-${CANCEL}`, expectedBalance: 80_000 }]);
  });

  test('GAT-080 P10 금액을 비운 요청에 진행 중 합을 빼면 0 이하(NO_BALANCE)이면 결제사를 부르지 않고 상태 오류이며, 10분 안의 진행 중 건(BUSY)이면 결과 모름이다', async () => {
    const none = fixture({ begin: { status: 'NO_BALANCE' } });
    await expect(none.uc.execute(input())).rejects.toThrow(PaymentCancelStateError);
    expect(none.cancels).toHaveLength(0);
    const busy = fixture({ begin: { status: 'BUSY' } });
    await expect(busy.uc.execute(input())).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 20_000 });
    expect(busy.cancels).toHaveLength(0);
  });
});

describe('P-T21 3시간 지난 재시도의 조회 대조', () => {
  const THREE_HOURS = 10_800_000;

  test('P-T21 3시간 직전(−1ms, 10,799,999ms 전)에 만든 건의 재시도는 조회하지 않고 같은 멱등키로 다시 보낸다', async () => {
    const f = fixture({ begin: begun({ createdAtMs: NOW - (THREE_HOURS - 1) }, true) });
    await f.uc.execute(input({ amount: 30_000 }));
    expect(f.queries).toHaveLength(0);
    expect(f.cancels).toHaveLength(1);
    expect(f.cancels[0]!.idemKey).toBe(`cancel-${CANCEL}`);
  });

  test('P-T21 3시간 정각(10,800,000ms 전)에 만든 건의 재시도는 결제사 취소 앞에 먼저 조회한다(결제 참조·결제 시도 ID)', async () => {
    const f = fixture({ begin: begun({ createdAtMs: NOW - THREE_HOURS }, true), query: { kind: 'FOUND', paymentRef: 'pay_ref_1', orderRef: ORDER, status: 'PARTIAL_CANCELED', amount: 100_000, balanceAmount: 80_000 } });
    await f.uc.execute(input({ amount: 30_000 }));
    expect(f.calls.slice(0, 5)).toEqual(['read', 'begin', 'query', 'settle', 'cancel']);
    expect(f.settles).toEqual([[CANCEL, 80_000]]);
    expect(f.queries[0]!.paymentRef).toBe('pay_ref_1');
    expect(f.queries[0]!.options).toMatchObject({ expectedTxId: 'tx_1' });
  });

  test('P-T21 조회 잔액이 기대 잔액 − 금액(80,000 − 30,000 = 50,000)이면 결제 행 잠금 안의 저장소 판정(settleConfirmedCancelByQuery)에 넘기고 APPLIED면 다시 보내지 않고 CANCELLED다', async () => {
    const f = fixture({
      begin: begun({ createdAtMs: NOW - THREE_HOURS - 1, amount: 30_000, expectedBalance: 80_000 }, true),
      query: { kind: 'FOUND', paymentRef: 'pay_ref_1', orderRef: ORDER, status: 'PARTIAL_CANCELED', amount: 100_000, balanceAmount: 50_000 },
      settle: { status: 'APPLIED', cancelledAmount: 50_000 },
    });
    await expect(f.uc.execute(input({ amount: 30_000 }))).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 50_000 });
    expect(f.settles).toEqual([[CANCEL, 50_000]]);
    expect(f.cancels).toHaveLength(0);
    // 반영은 저장소 판정이 같은 트랜잭션에서 한다(쓰임새가 finish를 따로 부르지 않는다)
    expect(f.finishes).toHaveLength(0);
  });

  test('P-T21 저장소 판정이 RESEND(잔액이 기대 잔액 그대로)면 저장한 본문으로 한 번 다시 보낸다', async () => {
    const f = fixture({
      begin: begun({ createdAtMs: NOW - THREE_HOURS, amount: 30_000, expectedBalance: 80_000 }, true),
      query: { kind: 'FOUND', paymentRef: 'pay_ref_1', orderRef: ORDER, status: 'PARTIAL_CANCELED', amount: 100_000, balanceAmount: 80_000 },
      settle: { status: 'RESEND' },
    });
    await f.uc.execute(input({ amount: 30_000 }));
    expect(f.cancels).toEqual([{ paymentRef: 'pay_ref_1', amount: 30_000, reason: '관객 취소', idemKey: `cancel-${CANCEL}`, expectedBalance: 80_000 }]);
  });

  test('GAT-080 P11 3시간 지난 재시도는 잔액이 기대 잔액 − 금액과 맞아도 저장소가 가를 수 없다(UNDECIDABLE)고 하면 보내지도 반영하지도 않고 결과 모름이다', async () => {
    const f = fixture({
      begin: begun({ createdAtMs: NOW - THREE_HOURS, amount: 30_000, expectedBalance: 80_000 }, true),
      query: { kind: 'FOUND', paymentRef: 'pay_ref_1', orderRef: ORDER, status: 'PARTIAL_CANCELED', amount: 100_000, balanceAmount: 50_000 },
      settle: { status: 'UNDECIDABLE' },
    });
    await expect(f.uc.execute(input({ amount: 30_000 }))).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 20_000 });
    expect(f.settles).toEqual([[CANCEL, 50_000]]);
    expect(f.cancels).toHaveLength(0);
    expect(f.finishes).toHaveLength(0);
    expect(f.marks).toHaveLength(0);
  });

  test.each<[string, QueryResult, number]>([
    ['그 밖의 잔액 70,000', { kind: 'FOUND', paymentRef: 'pay_ref_1', orderRef: ORDER, status: 'PARTIAL_CANCELED', amount: 100_000, balanceAmount: 70_000 }, 1],
    ['한 원 차이 50,001', { kind: 'FOUND', paymentRef: 'pay_ref_1', orderRef: ORDER, status: 'PARTIAL_CANCELED', amount: 100_000, balanceAmount: 50_001 }, 1],
    ['조회 결과 모름', { kind: 'UNKNOWN' }, 0],
    ['조회 기록 없음', { kind: 'NOT_FOUND' }, 0],
  ])('P-T21 3시간 지난 재시도에서 %s이면 보내지 않고 결과 모름이며 행·원장을 바꾸지 않는다', async (_name, query, settleCalls) => {
    const f = fixture({ begin: begun({ createdAtMs: NOW - THREE_HOURS, amount: 30_000, expectedBalance: 80_000 }, true), query });
    await expect(f.uc.execute(input({ amount: 30_000 }))).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 20_000 });
    expect(f.settles).toHaveLength(settleCalls);
    expect(f.cancels).toHaveLength(0);
    expect(f.finishes).toHaveLength(0);
    expect(f.marks).toHaveLength(0);
  });

  test('P-T21 처음 만든 건(replay 아님)은 만든 시각과 관계없이 조회하지 않는다', async () => {
    const f = fixture({ begin: begun({ createdAtMs: NOW - THREE_HOURS * 2 }, false) });
    await f.uc.execute(input({ amount: 30_000 }));
    expect(f.queries).toHaveLength(0);
    expect(f.cancels).toHaveLength(1);
  });

  test('P-T21 settleByBalance는 잔액 = 기대 − 금액이면 APPLIED, = 기대면 NOT_APPLIED, 그 밖(한 원 차이·0)은 UNKNOWN이다', () => {
    const r = { amount: 30_000, expectedBalance: 80_000 };
    expect(settleByBalance(r, 50_000)).toBe('APPLIED');
    expect(settleByBalance(r, 80_000)).toBe('NOT_APPLIED');
    expect(settleByBalance(r, 49_999)).toBe('UNKNOWN');
    expect(settleByBalance(r, 50_001)).toBe('UNKNOWN');
    expect(settleByBalance(r, 79_999)).toBe('UNKNOWN');
    expect(settleByBalance(r, 0)).toBe('UNKNOWN');
    expect(settleByBalance({ amount: 80_000, expectedBalance: 80_000 }, 0)).toBe('APPLIED');
  });
});

describe('BAT-415 리뷰 반영 B1·B3(단위)', () => {
  test('GAT-080 P11 canSettleByBalance는 원장 잔액이 기대 잔액과 같고 다른 진행 중 건이 없을 때만 참이다', () => {
    expect(canSettleByBalance({ ledgerRemaining: 80_000, expectedBalance: 80_000, otherInFlight: 0 })).toBe(true);
    expect(canSettleByBalance({ ledgerRemaining: 50_000, expectedBalance: 80_000, otherInFlight: 0 })).toBe(false);
    expect(canSettleByBalance({ ledgerRemaining: 80_001, expectedBalance: 80_000, otherInFlight: 0 })).toBe(false);
    expect(canSettleByBalance({ ledgerRemaining: 79_999, expectedBalance: 80_000, otherInFlight: 0 })).toBe(false);
    expect(canSettleByBalance({ ledgerRemaining: 80_000, expectedBalance: 80_000, otherInFlight: 1 })).toBe(false);
  });

  test('GAT-080 P12 거절된 취소(REJECTED)를 같은 취소 ID로 다시 부르면 결제사를 부르지 않고 REJECTED와 지금 누적액이다', async () => {
    const f = fixture({ begin: { status: 'REJECTED' } });
    await expect(f.uc.execute(input({ amount: 30_000 }))).resolves.toEqual({ result: 'REJECTED', cancelledAmount: 20_000 });
    expect(f.cancels).toHaveLength(0);
    expect(f.queries).toHaveLength(0);
    expect(f.marks).toHaveLength(0);
    expect(f.finishes).toHaveLength(0);
  });
});
