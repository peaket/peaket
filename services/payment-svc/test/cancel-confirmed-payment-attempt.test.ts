// 결제 후 일반 취소의 같은 취소 ID 시도 번호와 이중 환불 가드(P-T76 ①~⑤, BAT-425, ADR-0316).
// 정본: docs/features/payment.md §4.1 '지연 환급 계좌 다시 받기와 같은 취소 ID의 새 시도'·§11 P-T76,
// docs/features/transfer-refund.md §3.1 '지연 환급 계좌를 다시 받는 작업', docs/api/proto/peaket/payment/v1/payment.proto `CancelPaymentRequest.refund_attempt`.
// 차례: 원장 읽기 → 새 계좌 시도면 그 결제의 앞 진행 중 취소 행을 한 번 조회해 닫기 → 취소 건 만들기/찾기 →
// (3시간 지난 재시도는 먼저 조회) → 결제사 취소(저장한 본문·시도별 멱등키) → 행·원장 반영.
// 이 파일은 DB 없이 저장소·결제사 대역으로 본다. 실제 PostgreSQL·gRPC·결제사 어댑터는 BAT-425 통합 시험 몫이다.
// 단언 값은 정본에서 가져온다: 시도 상한 3회 [가정], 멱등키 `cancel-{id}`·`cancel-{id}-a{n}`,
// 10분 [가정] 창, 3시간 [가정] 조회. 시험 값은 상수와 다르게 고른다(금액 47,500원·앞 행 11분 전·1분 전).
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { CancelConfirmedPayment, type ConfirmedCancelBegin, type ConfirmedCancelInProgress, type ConfirmedCancelRecord, type ConfirmedCancelTarget } from '../src/modules/payment/server.js';
import { confirmedCancelIdemKey, CONFIRMED_CANCEL_MAX_ATTEMPT, parseConfirmedCancel } from '../src/modules/payment/domain/confirmed-cancel.js';
import type { CancelResult, PaymentGatewayPort, QueryResult } from '../src/modules/payment/domain/payment-gateway.js';

const NOW = Date.parse('2026-11-20T05:30:00.000Z');
const PAYMENT = '0193a425-0000-7000-8000-000000000101';
const CANCEL = '0193a425-0000-7000-8000-0000000001c1';
const OLD_CANCEL = '0193a425-0000-7000-8000-0000000001c0';
/** 계획 §5의 계좌 글(다른 값과 겹치지 않게) */
const ACCOUNT_NO = '110-987-654321';
const ACCOUNT = { bankCode: '88', accountNumber: ACCOUNT_NO, holderName: '김환불' };

/** 결제 60,000원 · 누적 취소 0원 · 가상계좌(AWAITING_DEPOSIT 사건이 있다) */
const TARGET: ConfirmedCancelTarget = {
  paymentId: PAYMENT,
  orderId: '0193a425-0000-7000-8000-0000000000aa',
  eventId: '0193a425-0000-7000-8000-0000000000bb',
  pg: 'TOSS',
  paymentRef: 'tpk_va_bat425',
  amount: 60_000,
  cancelledAmount: 0,
  status: 'APPROVED',
  virtualAccount: true,
};

const record = (over: Partial<ConfirmedCancelRecord> = {}): ConfirmedCancelRecord => ({
  idemKey: `cancel-${CANCEL}`,
  attempt: 0,
  amount: 47_500,
  reason: '관객 취소',
  fullCancel: false,
  expectedBalance: 60_000,
  status: 'REQUESTED',
  createdAtMs: NOW,
  ...over,
});
const begun = (o: { replay?: boolean; virtualAccount?: boolean; record?: Partial<ConfirmedCancelRecord> } = {}): ConfirmedCancelBegin => ({
  status: 'BEGUN',
  record: record(o.record),
  replay: o.replay ?? false,
  virtualAccount: o.virtualAccount ?? true,
});
const prior = (over: Partial<ConfirmedCancelInProgress> = {}): ConfirmedCancelInProgress => ({
  idemKey: `cancel-${OLD_CANCEL}`,
  attempt: 0,
  amount: 47_500,
  expectedBalance: 60_000,
  status: 'REQUESTED',
  createdAtMs: NOW - 11 * 60_000,
  ...over,
});
const found = (balanceAmount: number): QueryResult => ({ kind: 'FOUND', paymentRef: 'tpk_va_bat425', orderRef: TARGET.orderId, status: 'APPROVED', amount: 60_000, balanceAmount });

interface FixtureOptions {
  target?: ConfirmedCancelTarget;
  begin?: ConfirmedCancelBegin;
  cancel?: CancelResult;
  query?: QueryResult;
  queryThrows?: boolean;
  inProgress?: readonly ConfirmedCancelInProgress[] | null;
  ownStatus?: 'REQUESTED' | 'CANCEL_PENDING' | 'CANCELED' | 'FAILED';
  settlePrior?: { status: 'APPLIED'; cancelledAmount: number } | { status: 'RESEND' } | { status: 'UNDECIDABLE' };
  close?: boolean;
  satisfy?: { cancelledAmount: number } | undefined;
  settleQuery?: { status: 'APPLIED'; cancelledAmount: number } | { status: 'RESEND' } | { status: 'UNDECIDABLE' };
}

type CancelBody = Parameters<PaymentGatewayPort['cancel']>[0];

function fixture(o: FixtureOptions = {}) {
  const calls: string[] = [];
  const begins: { cancellationId: string; amount?: number; reason: string; hasRefundAccount?: boolean; attempt?: number }[] = [];
  const cancels: CancelBody[] = [];
  const closes: string[] = [];
  const settles: string[] = [];
  const marks: [string, string][] = [];
  const superseded: string[] = [];
  let queries = 0;

  const gateway = {
    pg: 'TOSS',
    cancel: async (c: CancelBody) => {
      calls.push('cancel');
      cancels.push(c);
      return o.cancel ?? { outcome: 'CANCELLED' };
    },
    query: async () => {
      calls.push('query');
      queries++;
      if (o.queryThrows) throw new Error('결제사 조회 시간 초과');
      return o.query ?? { kind: 'UNKNOWN' };
    },
  } as unknown as PaymentGatewayPort;

  const uc = new CancelConfirmedPayment({
    store: {
      readConfirmedCancelTarget: async () => o.target ?? TARGET,
      beginConfirmedCancel: async (_t, q) => {
        calls.push('begin');
        begins.push({ ...q });
        return o.begin ?? begun();
      },
      finishConfirmedCancel: async () => {
        calls.push('finish');
        return { status: 'APPLIED', cancelledAmount: 47_500 };
      },
      markConfirmedCancel: async (_t, id, status) => {
        calls.push('mark');
        marks.push([id, status]);
      },
      settleConfirmedCancelByQuery: async () => {
        calls.push('settle-own');
        return o.settleQuery ?? { status: 'UNDECIDABLE' };
      },
      ...(o.inProgress === null
        ? {}
        : {
            listInProgressCancels: async () => {
              calls.push('list');
              return o.inProgress ?? [prior()];
            },
          }),
      ...(o.ownStatus === undefined
        ? {}
        : {
            findCancelStatus: async () => {
              calls.push('find-own');
              return o.ownStatus;
            },
          }),
      settlePriorConfirmedCancel: async (_t, idemKey) => {
        calls.push('settle-prior');
        settles.push(idemKey);
        return o.settlePrior ?? { status: 'RESEND' };
      },
      closeSupersededCancel: async (_paymentId, idemKey) => {
        calls.push('close');
        closes.push(idemKey);
        return o.close ?? true;
      },
      ...(o.satisfy === undefined
        ? {}
        : {
            satisfyWithPriorCancel: async (_t, _q, p: ConfirmedCancelInProgress) => {
              calls.push('satisfy');
              settles.push(p.idemKey);
              return o.satisfy;
            },
          }),
    },
    gateways: { of: () => gateway },
    guards: { of: () => ({ tryTakeToken: () => true, circuitClosed: () => true }) as never },
    clock: fakeClock({ now: NOW }),
    refundAccountSignals: { cancelSuperseded: (result: string) => void superseded.push(result), refundAccountIgnored: () => {} },
  });
  return { uc, calls, begins, cancels, closes, settles, marks, superseded, queries: () => queries };
}

const run = (
  f: ReturnType<typeof fixture>,
  over: { cancellationId?: string; attempt?: number; account?: { bankCode: string; accountNumber: string; holderName: string }; amount?: number } = {},
) =>
  f.uc.execute({
    paymentId: PAYMENT,
    cancellationId: over.cancellationId ?? CANCEL,
    reason: '관객 취소',
    amount: over.amount ?? 47_500,
    ...(over.attempt === undefined ? {} : { refundAttempt: over.attempt }),
    ...(over.account === undefined ? {} : { refundAccount: over.account }),
  });

describe('P-T76 ⑤ 시도 번호와 멱등키(순수 함수)', () => {
  test('P-T76 ⑤_시도_번호_0·1·3은_받고_4·음수·소수는_INVALID_ARGUMENT로_거절한다', () => {
    for (const refundAttempt of [0, 1, 3]) {
      expect(() => parseConfirmedCancel({ paymentId: PAYMENT, cancellationId: CANCEL, reason: '취소', refundAttempt }), String(refundAttempt)).not.toThrow();
    }
    for (const refundAttempt of [4, -1, 1.5]) {
      let err: unknown;
      try {
        parseConfirmedCancel({ paymentId: PAYMENT, cancellationId: CANCEL, reason: '취소', refundAttempt });
      } catch (e) {
        err = e;
      }
      expect((err as { field?: string }).field, String(refundAttempt)).toBe('refund_attempt');
    }
    expect(CONFIRMED_CANCEL_MAX_ATTEMPT).toBe(3);
  });

  test('P-T76 ⑤_멱등키는_첫_시도_cancel-id_이고_새_시도는_-a1·-a2·-a3이다', () => {
    expect(confirmedCancelIdemKey(CANCEL)).toBe(`cancel-${CANCEL}`);
    expect(confirmedCancelIdemKey(CANCEL, 0)).toBe(`cancel-${CANCEL}`);
    expect(confirmedCancelIdemKey(CANCEL, 1)).toBe(`cancel-${CANCEL}-a1`);
    expect(confirmedCancelIdemKey(CANCEL, 2)).toBe(`cancel-${CANCEL}-a2`);
    expect(confirmedCancelIdemKey(CANCEL, 3)).toBe(`cancel-${CANCEL}-a3`);
  });
});

describe('P-T76 ① 앞 진행 중 행이 반영됐으면 새 전송 0', () => {
  test('P-T76 ①_새_취소_ID에_계좌를_실으면_11분_전_REQUESTED_행을_조회_한_번으로_닫고_결제사_취소는_0이다', async () => {
    const f = fixture({ settlePrior: { status: 'APPLIED', cancelledAmount: 47_500 }, satisfy: { cancelledAmount: 47_500 }, query: found(12_500) });
    await expect(run(f, { cancellationId: CANCEL, account: ACCOUNT })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 47_500 });
    expect(f.calls).toEqual(['list', 'query', 'settle-prior', 'satisfy']);
    expect(f.queries()).toBe(1);
    expect(f.cancels).toHaveLength(0);
    expect(f.begins).toHaveLength(0);
    expect(f.marks).toEqual([]);
    expect(f.superseded).toEqual(['applied']);
  });

  test('P-T76 ②_같은_시도_재시도는_자기_행(findCancelStatus)을_보고_앞_행_조회를_다시_하지_않는다', async () => {
    const f = fixture({ ownStatus: 'REQUESTED', begin: begun({ replay: true }), query: found(12_500), settleQuery: { status: 'APPLIED', cancelledAmount: 47_500 } });
    await expect(run(f, { attempt: 1, account: ACCOUNT })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 47_500 });
    expect(f.calls).toEqual(['find-own', 'begin', 'query', 'settle-own']);
    expect(f.cancels).toHaveLength(0);
    expect(f.closes).toEqual([]);
  });

  // RV-01(높음): 계좌를 실은 시도가 CANCEL_PENDING·UNKNOWN으로 남은 뒤의 재시도는 계좌를 저장하지 않으므로 계좌 없이 온다.
  // 같은 시도의 행이 있으면 INVALID_ARGUMENT가 아니라 그 행의 멱등키로 조회·정산해야 한다(ADR-0316 결정 4, B9 '같은 시도의 재시도는 같은 멱등키').
  // 지금 코드는 attempt > 0 && account === undefined를 행 조회보다 먼저 거절해, purchase가 5회를 다 쓰고 '환급 실패'로 끝낸다.
  test('P-T76 ②_계좌_시도가_결과_모름으로_남은_뒤_계좌_없이_같은_시도를_다시_부르면_새_전송_0·조회_한_번으로_정산한다', async () => {
    const f = fixture({ ownStatus: 'REQUESTED', begin: begun({ replay: true, record: { idemKey: `cancel-${CANCEL}-a1`, attempt: 1 } }), query: found(12_500), settleQuery: { status: 'APPLIED', cancelledAmount: 47_500 } });
    await expect(run(f, { attempt: 1 })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 47_500 });
    expect(f.calls).toEqual(['find-own', 'begin', 'query', 'settle-own']);
    expect(f.cancels).toHaveLength(0);
    expect(f.closes).toEqual([]);
    expect(f.marks).toEqual([]);
  });

  // RV-21(높음): a1이 CANCEL_PENDING·REQUESTED로 남은 뒤 계좌 없이 같은 시도를 다시 부르고 조회가 아직 '반영 아님'이면,
  // 지금은 REFUND_ACCOUNT_REQUIRED(422)로 답해 purchase가 next_refund_at을 비우고 재시도 루프를 멈춘다.
  // 같은 시도의 재시도는 계좌 대기가 아니라 202 REFUND_PENDING(CANCEL_PENDING·UNKNOWN)이어야 a1을 계속 조회한다(ADR-0316 결정 4, B9).
  test('P-T76 ②_RV21_계좌_시도의_재시도_조회가_반영_아님이면_422_계좌_요구가_아니라_대기이고_새_전송_0이다', async () => {
    for (const ownStatus of ['REQUESTED', 'CANCEL_PENDING'] as const) {
      const f = fixture({
        ownStatus,
        begin: begun({ replay: true, record: { idemKey: `cancel-${CANCEL}-a1`, attempt: 1 } }),
        query: found(60_000),
        settleQuery: { status: 'RESEND' },
      });
      const answer = await run(f, { attempt: 1 });
      expect(answer.result, ownStatus).not.toBe('REFUND_ACCOUNT_REQUIRED');
      expect(['CANCEL_PENDING', 'UNKNOWN'], ownStatus).toContain(answer.result);
      expect(f.calls, ownStatus).toEqual(['find-own', 'begin', 'query', 'settle-own']);
      expect(f.queries(), ownStatus).toBe(1);
      expect(f.cancels, ownStatus).toHaveLength(0);
      expect(f.marks, ownStatus).toEqual([]);
    }
  });

  // RV-30(낮음): 같은 키로 계좌를 실은 요청이 겹치거나 답을 저장하기 전에 끊기면, 같은 시도의 두 번째 부름도
  // 계좌를 실은 채 payment에 닿는다. 그 시도는 이미 계좌를 받았으므로 V5 조회가 '반영 아님'이어도
  // REFUND_ACCOUNT_REQUIRED(422)가 아니라 CANCEL_PENDING(202 대기)이어야 첫 답과 같다(ADR-0316 결정 4, B9).
  test('P-T76 ②_RV30_계좌를_실은_같은_시도의_재시도가_반영_아니면_계좌_요구가_아니라_대기다', async () => {
    const f = fixture({
      ownStatus: 'CANCEL_PENDING',
      begin: begun({ replay: true, record: { idemKey: `cancel-${CANCEL}-a1`, attempt: 1 } }),
      query: found(60_000),
      settleQuery: { status: 'RESEND' },
    });
    await expect(run(f, { attempt: 1, account: ACCOUNT })).resolves.toEqual({ result: 'CANCEL_PENDING', cancelledAmount: 0 });
    expect(f.calls).toEqual(['find-own', 'begin', 'query', 'settle-own']);
    expect(f.queries()).toBe(1);
    expect(f.cancels).toHaveLength(0);
    expect(f.marks).toEqual([]);
  });

  test('P-T76 ②_RV21_계좌_시도의_재시도_조회가_반영이면_새_전송_0으로_끝난다', async () => {
    for (const ownStatus of ['REQUESTED', 'CANCEL_PENDING'] as const) {
      const f = fixture({
        ownStatus,
        begin: begun({ replay: true, record: { idemKey: `cancel-${CANCEL}-a1`, attempt: 1 } }),
        query: found(12_500),
        settleQuery: { status: 'APPLIED', cancelledAmount: 47_500 },
      });
      await expect(run(f, { attempt: 1 }), ownStatus).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 47_500 });
      expect(f.calls, ownStatus).toEqual(['find-own', 'begin', 'query', 'settle-own']);
      expect(f.cancels, ownStatus).toHaveLength(0);
      expect(f.marks, ownStatus).toEqual([]);
    }
  });

  test('P-T76 ②_계좌_없이_온_새_시도인데_그_시도의_행이_없으면_지금처럼_계좌_필수로_거절한다', async () => {
    const f = fixture();
    await expect(run(f, { attempt: 1 })).rejects.toMatchObject({ field: 'refund_account' });
    expect(f.begins).toHaveLength(0);
    expect(f.cancels).toHaveLength(0);
  });

  test('P-T76 ①_조회가_반영_아님이면_옛_행을_SUPERSEDED로_닫고_새_키로_한_번_보낸다', async () => {
    const f = fixture({ settlePrior: { status: 'RESEND' }, close: true, query: found(60_000), begin: begun({ record: { idemKey: `cancel-${CANCEL}-a1`, attempt: 1 } }) });
    await expect(run(f, { attempt: 1, account: ACCOUNT })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 47_500 });
    expect(f.calls).toEqual(['list', 'query', 'settle-prior', 'close', 'begin', 'cancel', 'finish']);
    expect(f.closes).toEqual([`cancel-${OLD_CANCEL}`]);
    expect(f.begins[0]).toMatchObject({ attempt: 1, hasRefundAccount: true, amount: 47_500 });
    expect(f.cancels).toEqual([expect.objectContaining({ idemKey: `cancel-${CANCEL}-a1`, amount: 47_500, expectedBalance: 60_000, refundAccount: { bankCode: '88', accountNumber: '110987654321', holderName: '김환불' } })]);
    expect(f.superseded).toEqual(['not_applied']);
  });

  // RV-21: 앞 a1(REQUESTED)이 결제사에서 아직 반영되지 않았으면 그 행을 닫고 새 계좌 시도 a2가 결제사에 한 번 닿아야 한다.
  // a2는 첫 시도와 다른 멱등키(-a2)를 쓰고, 옛 행은 조건부로 FAILED(SUPERSEDED)가 된다(ADR-0316 B2·B3).
  test('P-T76 ①_RV21_앞_a1이_미반영_REQUESTED면_a2는_옛_행을_닫고_결제사에_한_번_닿는다', async () => {
    const f = fixture({ settlePrior: { status: 'RESEND' }, close: true, query: found(60_000), begin: begun({ record: { idemKey: `cancel-${CANCEL}-a2`, attempt: 2 } }) });
    await expect(run(f, { attempt: 2, account: ACCOUNT })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 47_500 });
    expect(f.calls).toEqual(['list', 'query', 'settle-prior', 'close', 'begin', 'cancel', 'finish']);
    expect(f.closes).toEqual([`cancel-${OLD_CANCEL}`]);
    expect(f.begins[0]).toMatchObject({ attempt: 2, hasRefundAccount: true, amount: 47_500 });
    expect(f.cancels).toEqual([expect.objectContaining({ idemKey: `cancel-${CANCEL}-a2`, amount: 47_500, expectedBalance: 60_000 })]);
    expect(f.cancels).toHaveLength(1);
    expect(f.superseded).toEqual(['not_applied']);
  });

  test('P-T76 ④_조건부_닫기가_0행이면(그사이_누가_닫음)_새_전송_0이고_결과_모름이다', async () => {
    const f = fixture({ settlePrior: { status: 'RESEND' }, close: false, query: found(60_000) });
    await expect(run(f, { attempt: 1, account: ACCOUNT })).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 0 });
    expect(f.calls).toEqual(['list', 'query', 'settle-prior', 'close']);
    expect(f.begins).toHaveLength(0);
    expect(f.cancels).toHaveLength(0);
    expect(f.superseded).toEqual(['undecidable']);
  });
});

describe('P-T76 ③ CANCEL_PENDING·둘 이상·조회 실패는 새 전송 0', () => {
  test('P-T76 ③_앞_행이_CANCEL_PENDING이면_조회도_새_전송도_하지_않고_결과_모름이다', async () => {
    const f = fixture({ inProgress: [prior({ status: 'CANCEL_PENDING' })] });
    await expect(run(f, { attempt: 1, account: ACCOUNT })).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 0 });
    expect(f.calls).toEqual(['list']);
    expect(f.queries()).toBe(0);
    expect(f.cancels).toHaveLength(0);
    expect(f.begins).toHaveLength(0);
    expect(f.superseded).toEqual(['undecidable']);
  });

  // RV-21(높음): 앞 a1이 CANCEL_PENDING인데 팬이 새 계좌로 a2를 내도 a2 행을 만들지 않고 결제사도 부르지 않는다.
  // a2를 만들면 purchase 재시도 루프가 a2의 payment_cancel 행을 찾지 못해 INVALID_ARGUMENT를 5회 소진한다.
  test('P-T76 ③_RV21_앞_a1이_CANCEL_PENDING이면_a2는_행을_만들지_않고_결제사에_닿지_않는다', async () => {
    const f = fixture({ inProgress: [prior({ idemKey: `cancel-${CANCEL}-a1`, attempt: 1, status: 'CANCEL_PENDING' })] });
    await expect(run(f, { attempt: 2, account: ACCOUNT })).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 0 });
    expect(f.calls).toEqual(['list']);
    expect(f.queries()).toBe(0);
    expect(f.begins).toHaveLength(0);
    expect(f.cancels).toHaveLength(0);
    expect(f.marks).toEqual([]);
    expect(f.closes).toEqual([]);
  });

  test('P-T76 ③_REQUESTED_행이_둘_이면_잔액으로_가르지_않고_새_전송_0·결과_모름이며_행은_그대로다', async () => {
    const f = fixture({ inProgress: [prior(), prior({ idemKey: `cancel-${CANCEL}-a1`, attempt: 1, createdAtMs: NOW - 60_000 })] });
    await expect(run(f, { attempt: 2, account: ACCOUNT })).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 0 });
    expect(f.calls).toEqual(['list']);
    expect(f.queries()).toBe(0);
    expect(f.closes).toEqual([]);
    expect(f.cancels).toHaveLength(0);
  });

  test('P-T76 ③_앞_행_조회가_실패하면_반영_아님으로_읽지_않고_새_전송_0이다', async () => {
    const f = fixture({ query: { kind: 'UNKNOWN' } });
    await expect(run(f, { attempt: 1, account: ACCOUNT })).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 0 });
    expect(f.calls).toEqual(['list', 'query']);
    expect(f.settles).toEqual([]);
    expect(f.cancels).toHaveLength(0);
    expect(f.superseded).toEqual(['undecidable']);
  });

  test('P-T76 ③_조회_시간_초과는_결제사_취소_0·결과_모름이고_새_행을_만들지_않는다', async () => {
    const f = fixture({ queryThrows: true });
    await expect(run(f, { attempt: 1, account: ACCOUNT })).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 0 });
    expect(f.calls).toEqual(['list', 'query']);
    expect(f.settles).toEqual([]);
    expect(f.cancels).toHaveLength(0);
    expect(f.superseded).toEqual(['undecidable']);
  });
});

describe('P-T76 ④ 가를 수 없음과 다른 취소의 원장 반영', () => {
  test('P-T76 ④_조회가_반영_같아도_원장_잔액을_다른_취소가_덮었으면(UNDECIDABLE)_새_전송_0·원장_그대로다', async () => {
    const f = fixture({ settlePrior: { status: 'UNDECIDABLE' }, query: found(12_500) });
    await expect(run(f, { attempt: 1, account: ACCOUNT })).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 0 });
    expect(f.calls).toEqual(['list', 'query', 'settle-prior']);
    expect(f.begins).toHaveLength(0);
    expect(f.cancels).toHaveLength(0);
    expect(f.superseded).toEqual(['undecidable']);
  });
});

describe('P-T76 ②·⑤ 옛 시도 다시 부르기와 BUSY의 차례', () => {
  test('P-T76 ②_옛_시도(0)를_FAILED_SUPERSEDED_뒤_다시_부르면_결제사_0·REJECTED다', async () => {
    const f = fixture({ begin: { status: 'REJECTED' } });
    await expect(run(f)).resolves.toEqual({ result: 'REJECTED', cancelledAmount: 0 });
    expect(f.calls).toEqual(['begin']);
    expect(f.cancels).toHaveLength(0);
    expect(f.begins[0]).not.toHaveProperty('hasRefundAccount');
  });

  test('P-T76 ②_옛_시도가_CANCELED면_새_시도는_만들지_않고_CANCELLED다', async () => {
    const f = fixture({ inProgress: null, begin: { status: 'DONE', cancelledAmount: 47_500 } });
    await expect(run(f, { attempt: 1, account: ACCOUNT })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 47_500 });
    expect(f.cancels).toHaveLength(0);
  });

  test('P-T76 ⑤_첫_시도가_BUSY면_새_전송_0·결과_모름이다', async () => {
    const f = fixture({ begin: { status: 'BUSY' } });
    await expect(run(f)).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 0 });
    expect(f.cancels).toHaveLength(0);
    expect(f.marks).toEqual([]);
  });

  test('P-T76 ⑤_새_시도는_10분_창을_기다리지_않고_1분_전_앞_행도_조회로_닫은_뒤_보낸다', async () => {
    const f = fixture({ inProgress: [prior({ createdAtMs: NOW - 60_000 })], settlePrior: { status: 'RESEND' }, close: true, query: found(60_000), begin: begun({ record: { idemKey: `cancel-${CANCEL}-a1`, attempt: 1 } }) });
    await expect(run(f, { attempt: 1, account: ACCOUNT })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 47_500 });
    expect(f.calls).toEqual(['list', 'query', 'settle-prior', 'close', 'begin', 'cancel', 'finish']);
    expect(f.cancels).toHaveLength(1);
    expect(f.begins).toHaveLength(1);
  });

  test('P-T76 ②_같은_취소_ID의_시도_2는_멱등키_-a2로_보낸다', async () => {
    const f = fixture({ inProgress: null, begin: begun({ record: { idemKey: `cancel-${CANCEL}-a2`, attempt: 2 } }) });
    await run(f, { attempt: 2, account: ACCOUNT });
    expect(f.begins[0]).toMatchObject({ attempt: 2 });
    expect(f.cancels[0]!.idemKey).toBe(`cancel-${CANCEL}-a2`);
  });

  test('P-T76 ⑤_모양이_틀린_계좌는_행을_만들기_전에_INVALID_ARGUMENT이고_저장소·결제사_0이다', async () => {
    const f = fixture();
    await expect(run(f, { attempt: 1, account: { ...ACCOUNT, accountNumber: '1'.repeat(21) } })).rejects.toMatchObject({ field: 'refund_account' });
    expect(f.calls).toEqual([]);
    expect(f.cancels).toHaveLength(0);
  });
});

describe('P-T76 ① 입력 계약', () => {
  test('P-T76 ①_가상계좌가_아니면_앞_행_조회_없이_지금_그대로_보낸다(대조)', async () => {
    const f = fixture({ target: { ...TARGET, virtualAccount: false }, begin: begun({ virtualAccount: false }) });
    await expect(run(f, { account: ACCOUNT })).resolves.toEqual({ result: 'CANCELLED', cancelledAmount: 47_500 });
    expect(f.calls).toEqual(['begin', 'cancel', 'finish']);
    expect(f.cancels[0]).not.toHaveProperty('refundAccount');
  });

  test('P-T76 ①_가상계좌_결제에_계좌가_없으면_앞_행_조회를_하지_않는다', async () => {
    const f = fixture({ begin: { status: 'ACCOUNT_REQUIRED' } });
    await expect(run(f)).resolves.toEqual({ result: 'REFUND_ACCOUNT_REQUIRED', cancelledAmount: 0 });
    expect(f.calls).toEqual(['begin']);
    expect(f.cancels).toHaveLength(0);
  });

  test('P-T76 ①_원장을_바꾸지_않은_UNKNOWN은_누적액_그대로다', async () => {
    const f = fixture({ begin: begun({ replay: true }), query: { kind: 'UNKNOWN' } });
    await expect(run(f, { account: ACCOUNT })).resolves.toEqual({ result: 'UNKNOWN', cancelledAmount: 0 });
    expect(f.marks).toEqual([]);
  });
});
