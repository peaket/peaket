// 승인 실행기의 순수 규칙(domain/confirm-runner.ts: confirmGateOf·decideConfirmAnswer·confirmRetryDelayMs·paymentEventKey·buildPaymentEvent,
// docs/features/payment.md §2 '승인 실행기의 첫 구현', 명세 specs/payment.qnt `send`·`expireCommand`·`respond`·`timeout`·`restart`, asyncapi PaymentEvent, BUILD_ORDER PRF-181).
// 실행기가 이 규칙을 어떻게 잇는지는 payment-confirm-runner.test.ts, 실제 PostgreSQL·시뮬레이터로 도는 것은 test-int가 본다.
import { createHash } from 'node:crypto';
import { PaymentEvent } from '@peaket/contracts/asyncapi';
import { describe, expect, test, vi } from 'vitest';
import type { PaymentLedgerStatus } from '../src/modules/payment/domain/confirm-command.js';
import {
  buildPaymentEvent,
  CONFIRM_FINISH_RETRY_DELAYS_MS,
  CONFIRM_LEASE_MS,
  CONFIRM_NO_ADAPTER_CLAIM_INTERVAL_MS,
  CONFIRM_NO_ADAPTER_CONCURRENCY,
  CONFIRM_NO_ADAPTER_DELAY_MS,
  CONFIRM_NO_ADAPTER_WARN_INTERVAL_MS,
  CONFIRM_RETRY_BASE_MS,
  CONFIRM_RETRY_FACTOR,
  CONFIRM_RETRY_MAX_MS,
  CONFIRM_RUNNER_POLL_INTERVAL_MS,
  CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS,
  CONFIRM_SENT_EVENT_TYPE,
  type ConfirmFinish,
  confirmGateOf,
  confirmRetryDelayMs,
  type ConfirmTarget,
  decideConfirmAnswer,
  PAYMENT_CONFIRM_OUTCOMES,
  paymentEventKey,
} from '../src/modules/payment/domain/confirm-runner.js';
import type { ConfirmOutcome, ConfirmResult, FailureCategory } from '../src/modules/payment/domain/payment-gateway.js';
import { EVENT_ID, NOW, ORDER_ID, PAYMENT_ID, SECRET_PAYMENT_KEY } from './confirm-cases.js';

/** 시험의 승인 기한 10분(어댑터 capabilities에서 받는 값) */
const DEADLINE_MS = 600_000;
const AUTH = NOW - 60_000;
const DUE = AUTH + DEADLINE_MS;
const AMOUNT = 55_000;

const target = (over: Partial<ConfirmTarget> = {}): ConfirmTarget => ({
  paymentId: PAYMENT_ID,
  orderId: ORDER_ID,
  eventId: EVENT_ID,
  attemptNo: 2,
  pg: 'SIMULATOR',
  paymentRef: SECRET_PAYMENT_KEY,
  amount: AMOUNT,
  status: 'ACCEPTED',
  authenticatedAtMs: AUTH,
  confirmSent: false,
  ...over,
});

const answer = (over: Partial<ConfirmResult> & { outcome: ConfirmOutcome }): ConfirmResult => ({ paymentRef: SECRET_PAYMENT_KEY, ...over });

const restart = { kind: 'UNKNOWN', cause: 'restart' } as const;
const lateSent = { kind: 'UNKNOWN', cause: 'deadline' } as const;
const noAdapter = { kind: 'NO_ADAPTER' } as const;
const expire = { kind: 'EXPIRE' } as const;
const sendFirst = { kind: 'SEND', markFirst: true } as const;
const resend = { kind: 'SEND', markFirst: false } as const;

describe('값(설계 §1·§4)', () => {
  test('PRF181_정해 둔 값이 설계와 같다', () => {
    expect([CONFIRM_RUNNER_POLL_INTERVAL_MS, CONFIRM_LEASE_MS]).toEqual([100, 75_000]);
    expect([CONFIRM_RETRY_BASE_MS, CONFIRM_RETRY_FACTOR, CONFIRM_RETRY_MAX_MS]).toEqual([1000, 2, 30_000]);
    expect([CONFIRM_NO_ADAPTER_DELAY_MS, CONFIRM_NO_ADAPTER_WARN_INTERVAL_MS, CONFIRM_NO_ADAPTER_CLAIM_INTERVAL_MS, CONFIRM_NO_ADAPTER_CONCURRENCY]).toEqual([30_000, 60_000, 1_000, 8]);
    expect(CONFIRM_FINISH_RETRY_DELAYS_MS).toEqual([100, 400]);
    expect(CONFIRM_RUNNER_STATEMENT_TIMEOUT_MS).toBe(5000);
    expect(CONFIRM_SENT_EVENT_TYPE).toBe('CONFIRM_SENT');
    expect(PAYMENT_CONFIRM_OUTCOMES).toEqual(['approved', 'already', 'declined', 'waiting', 'in_progress', 'unknown', 'expired', 'restart', 'no_adapter', 'circuit_open']);
  });
});

describe('confirmGateOf: 호출 앞의 판단', () => {
  // 앞 소유자 × CONFIRM_SENT × 기한 × 어댑터의 스물네 조합 전부
  const BEFORE = DUE - 1;
  const AT = DUE;
  const AFTER = DUE + 1;
  test.each([
    // 어댑터 있음
    [false, false, BEFORE, DEADLINE_MS, sendFirst],
    [false, false, AT, DEADLINE_MS, expire],
    [false, false, AFTER, DEADLINE_MS, expire],
    [false, true, BEFORE, DEADLINE_MS, resend],
    [false, true, AT, DEADLINE_MS, lateSent],
    [false, true, AFTER, DEADLINE_MS, lateSent],
    [true, false, BEFORE, DEADLINE_MS, sendFirst],
    [true, false, AT, DEADLINE_MS, expire],
    [true, false, AFTER, DEADLINE_MS, expire],
    [true, true, BEFORE, DEADLINE_MS, restart],
    [true, true, AT, DEADLINE_MS, restart],
    [true, true, AFTER, DEADLINE_MS, restart],
    // 어댑터 없음(기한을 잴 수 없다. 임대 잔해만 어댑터 없이도 UNKNOWN이다)
    [false, false, BEFORE, undefined, noAdapter],
    [false, false, AT, undefined, noAdapter],
    [false, false, AFTER, undefined, noAdapter],
    [false, true, BEFORE, undefined, noAdapter],
    [false, true, AT, undefined, noAdapter],
    [false, true, AFTER, undefined, noAdapter],
    [true, false, BEFORE, undefined, noAdapter],
    [true, false, AT, undefined, noAdapter],
    [true, false, AFTER, undefined, noAdapter],
    [true, true, BEFORE, undefined, restart],
    [true, true, AT, undefined, restart],
    [true, true, AFTER, undefined, restart],
  ] as const)('P-T24_앞 소유자 %s·표시 %s·지금 %s·기한 %s → %j [ASVS v5.0.0-16.5.3]', (hadPreviousOwner, confirmSent, nowMs, deadlineMs, want) => {
    expect(confirmGateOf(target({ confirmSent }), { hadPreviousOwner }, deadlineMs, nowMs)).toEqual(want);
  });

  test('P-T24_잔해인데 표시가 없으면 이어 간다(앞 파드는 결제사를 부르기 전에 끊겼다)', () => {
    expect(confirmGateOf(target({ confirmSent: false }), { hadPreviousOwner: true }, DEADLINE_MS, NOW)).toEqual(sendFirst);
  });

  test('P-T6_기한 경계: 1ms 전에는 부르고, 지금 = 인증 + 기한부터는 부르지 않는다 [ASVS v5.0.0-16.5.3]', () => {
    const t = target();
    const job = { hadPreviousOwner: false };
    expect(confirmGateOf(t, job, DEADLINE_MS, DUE - 1)).toEqual(sendFirst);
    expect(confirmGateOf(t, job, DEADLINE_MS, DUE)).toEqual(expire);
    expect(confirmGateOf(t, job, DEADLINE_MS, DUE + 1)).toEqual(expire);
  });

  test('P-T6_기한은 어댑터가 준 값으로 잰다(10분에 고정하지 않는다)', () => {
    const job = { hadPreviousOwner: false };
    expect(confirmGateOf(target(), job, 30_000, AUTH + 29_999)).toEqual(sendFirst);
    expect(confirmGateOf(target(), job, 30_000, AUTH + 30_000)).toEqual(expire);
    expect(confirmGateOf(target(), job, 3_600_000, AUTH + 3_599_999)).toEqual(sendFirst);
  });

  test('PRF181_보낸 뒤 기한을 넘기면 실패로 끝내지 않고 UNKNOWN이다(기한 전에 보낸 요청은 기한 뒤에도 승인될 수 있다) [ASVS v5.0.0-16.5.3]', () => {
    expect(confirmGateOf(target({ confirmSent: true }), { hadPreviousOwner: false }, DEADLINE_MS, DUE)).toEqual(lateSent);
  });

  test('PRF181_어댑터 없음을 기한보다 먼저 본다(기한이 지나 보여도 실패로 끝내지 않는다) [ASVS v5.0.0-16.5.2]', () => {
    expect(confirmGateOf(target({ authenticatedAtMs: NOW - 86_400_000 }), { hadPreviousOwner: false }, undefined, NOW)).toEqual(noAdapter);
  });

  describe.each(['AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED'] as const satisfies readonly PaymentLedgerStatus[])('원장 %s', (status) => {
    test('PRF181_ACCEPTED가 아니면 다른 값과 상관없이 명령 행만 지운다', () => {
      for (const hadPreviousOwner of [false, true]) {
        for (const confirmSent of [false, true]) {
          for (const deadlineMs of [DEADLINE_MS, undefined]) {
            for (const nowMs of [DUE - 1, DUE, DUE + 1]) {
              expect(confirmGateOf(target({ status, confirmSent }), { hadPreviousOwner }, deadlineMs, nowMs), JSON.stringify({ hadPreviousOwner, confirmSent, deadlineMs, nowMs })).toEqual({ kind: 'DROP_JOB' });
            }
          }
        }
      }
    });
  });
});

describe('decideConfirmAnswer: 결제사 답 → 할 일', () => {
  const APPROVED_AT = '2026-11-09T12:00:05.000+09:00';
  const APPROVED_AT_MS = Date.parse('2026-11-09T03:00:05.000Z');
  const unknownMismatch = { kind: 'FINISH', outcome: 'unknown', amountMismatch: true, finish: { status: 'UNKNOWN', result: 'UNKNOWN' } };

  test('PRF181_APPROVED(금액 같음): 결제사 승인 시각(오프셋 읽음)으로 APPROVED, 답 시간을 싣는다', () => {
    expect(decideConfirmAnswer(answer({ outcome: 'APPROVED', amount: AMOUNT, approvedAt: APPROVED_AT }), AMOUNT, NOW, 1234)).toEqual({
      kind: 'FINISH',
      outcome: 'approved',
      finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: APPROVED_AT_MS, latencyMs: 1234 },
    });
  });

  test('PRF181_ALREADY_APPROVED(금액 같음): 원장은 APPROVED, 사건 결과와 지표는 already다', () => {
    expect(decideConfirmAnswer(answer({ outcome: 'ALREADY_APPROVED', amount: AMOUNT, approvedAt: APPROVED_AT }), AMOUNT, NOW)).toEqual({
      kind: 'FINISH',
      outcome: 'already',
      finish: { status: 'APPROVED', result: 'ALREADY_APPROVED', approvedAtMs: APPROVED_AT_MS },
    });
  });

  test.each([
    ['없음', undefined],
    ['읽지 못함', 'not-a-date'],
    ['빈 글', ''],
  ])('PRF181_승인 시각이 %s이면 지금을 쓴다', (_name, approvedAt) => {
    const decision = decideConfirmAnswer(answer({ outcome: 'APPROVED', amount: AMOUNT, ...(approvedAt === undefined ? {} : { approvedAt }) }), AMOUNT, NOW);
    expect(decision).toEqual({ kind: 'FINISH', outcome: 'approved', finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: NOW } });
  });

  test.each(['APPROVED', 'ALREADY_APPROVED'] as const)('PRF181_%s인데 금액이 1원이라도 다르면 승인으로 쓰지 않고 UNKNOWN + SEV1 표시다 [ASVS v5.0.0-2.2.3]', (outcome) => {
    expect(decideConfirmAnswer(answer({ outcome, amount: AMOUNT + 1, approvedAt: APPROVED_AT }), AMOUNT, NOW)).toEqual(unknownMismatch);
    expect(decideConfirmAnswer(answer({ outcome, amount: AMOUNT - 1, approvedAt: APPROVED_AT }), AMOUNT, NOW)).toEqual(unknownMismatch);
  });

  test.each(['APPROVED', 'ALREADY_APPROVED'] as const)('PRF181_%s인데 답에 금액이 없으면 UNKNOWN + SEV1 표시다(맞는지 확인하지 못한 승인을 쓰지 않는다) [ASVS v5.0.0-2.2.3]', (outcome) => {
    expect(decideConfirmAnswer(answer({ outcome, approvedAt: APPROVED_AT }), AMOUNT, NOW)).toEqual(unknownMismatch);
  });

  test('PRF181_금액이 달라도 답 시간은 싣는다', () => {
    expect(decideConfirmAnswer(answer({ outcome: 'APPROVED', amount: 1 }), AMOUNT, NOW, 77)).toMatchObject({ finish: { status: 'UNKNOWN', result: 'UNKNOWN', latencyMs: 77 } });
  });

  test.each(['CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR'] as const satisfies readonly FailureCategory[])('PRF181_DECLINED + %s: FAILED와 그 범주', (failureCategory) => {
    expect(decideConfirmAnswer(answer({ outcome: 'DECLINED', failureCategory }), AMOUNT, NOW, 9)).toEqual({ kind: 'FINISH', outcome: 'declined', finish: { status: 'FAILED', result: 'DECLINED', failureCategory, latencyMs: 9 } });
  });

  test('PRF181_DECLINED인데 범주가 없으면 PG_ERROR다', () => {
    expect(decideConfirmAnswer(answer({ outcome: 'DECLINED' }), AMOUNT, NOW)).toEqual({ kind: 'FINISH', outcome: 'declined', finish: { status: 'FAILED', result: 'DECLINED', failureCategory: 'PG_ERROR' } });
  });

  test('PRF181_DECLINED + THROTTLED(429)는 실패로 끝내지 않고 미룬다', () => {
    expect(decideConfirmAnswer(answer({ outcome: 'DECLINED', failureCategory: 'THROTTLED' }), AMOUNT, NOW, 5)).toEqual({ kind: 'RETRY', outcome: 'in_progress' });
  });

  test.each(['PG_ERROR', 'VALIDATION', undefined] as const)('PRF181_리뷰 고침 M3: 재전송의 DECLINED(%s)는 FAILED가 아니라 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', (failureCategory) => {
    const a = answer({ outcome: 'DECLINED', ...(failureCategory === undefined ? {} : { failureCategory }) });
    expect(decideConfirmAnswer(a, AMOUNT, NOW, 9, true)).toEqual({ kind: 'FINISH', outcome: 'unknown', finish: { status: 'UNKNOWN', result: 'UNKNOWN', latencyMs: 9 } });
  });

  test.each(['CARD_DECLINED', 'USER_ABORTED', 'EXPIRED'] as const satisfies readonly FailureCategory[])('PRF181_리뷰 고침 M3: 재전송의 DECLINED(%s)는 그대로 FAILED다', (failureCategory) => {
    expect(decideConfirmAnswer(answer({ outcome: 'DECLINED', failureCategory }), AMOUNT, NOW, 9, true)).toEqual({ kind: 'FINISH', outcome: 'declined', finish: { status: 'FAILED', result: 'DECLINED', failureCategory, latencyMs: 9 } });
  });

  test('PRF181_리뷰 고침 M3: 재전송의 THROTTLED는 그대로 미룬다', () => {
    expect(decideConfirmAnswer(answer({ outcome: 'DECLINED', failureCategory: 'THROTTLED' }), AMOUNT, NOW, 9, true)).toEqual({ kind: 'RETRY', outcome: 'in_progress' });
  });

  test('PRF181_IN_PROGRESS는 미룬다', () => {
    expect(decideConfirmAnswer(answer({ outcome: 'IN_PROGRESS' }), AMOUNT, NOW, 5)).toEqual({ kind: 'RETRY', outcome: 'in_progress' });
  });

  test('PRF181_WAITING_FOR_DEPOSIT은 AWAITING_DEPOSIT이다', () => {
    expect(decideConfirmAnswer(answer({ outcome: 'WAITING_FOR_DEPOSIT', amount: AMOUNT }), AMOUNT, NOW, 11)).toEqual({ kind: 'FINISH', outcome: 'waiting', finish: { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT', latencyMs: 11 } });
  });

  test('PRF181_UNKNOWN은 결과를 가정하지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', () => {
    expect(decideConfirmAnswer(answer({ outcome: 'UNKNOWN' }), AMOUNT, NOW, 60_000)).toEqual({ kind: 'FINISH', outcome: 'unknown', finish: { status: 'UNKNOWN', result: 'UNKNOWN', latencyMs: 60_000 } });
  });

  test('PRF181_형 밖의 답은 승인으로 치지 않고 UNKNOWN이다 [ASVS v5.0.0-16.5.3]', () => {
    expect(decideConfirmAnswer(answer({ outcome: 'SOMETHING_NEW' as ConfirmOutcome, amount: AMOUNT }), AMOUNT, NOW)).toEqual({ kind: 'FINISH', outcome: 'unknown', finish: { status: 'UNKNOWN', result: 'UNKNOWN' } });
  });

  test('PRF181_답 시간 0도 그대로 싣는다(값이 있는 것이다)', () => {
    expect(decideConfirmAnswer(answer({ outcome: 'APPROVED', amount: AMOUNT }), AMOUNT, NOW, 0)).toMatchObject({ finish: { latencyMs: 0 } });
  });

  test.each([
    ['APPROVED', { outcome: 'APPROVED', amount: AMOUNT }],
    ['DECLINED', { outcome: 'DECLINED', failureCategory: 'CARD_DECLINED' }],
    ['WAITING_FOR_DEPOSIT', { outcome: 'WAITING_FOR_DEPOSIT' }],
  ] as const)('PRF181_%s 답의 결제 수단 분류를 finish에 싣는다', (_name, a) => {
    expect(decideConfirmAnswer(answer({ ...a, method: 'EASY_PAY' }), AMOUNT, NOW)).toMatchObject({ finish: { payMethodCategory: 'EASY_PAY' } });
  });

  test('PRF181_결제 수단을 모르면 칸을 비운다, 카드 정보와 결제사 원래 코드는 싣지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    const a = answer({ outcome: 'APPROVED', amount: AMOUNT, pgCode: 'PG_RAW_CODE', card: { maskedNumber: '12345678****9012', issuerCode: 'X', cardType: '신용' } });
    const decision = decideConfirmAnswer(a, AMOUNT, NOW);
    expect(decision).toEqual({ kind: 'FINISH', outcome: 'approved', finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: NOW } });
    expect(JSON.stringify(decision)).not.toMatch(/PG_RAW_CODE|12345678|tgen_/);
  });

  test.each(['APPROVED', 'ALREADY_APPROVED'] as const)('P-T50_%s 답에 연결값을 함께 싣는다', (outcome) => {
    const decision = decideConfirmAnswer(answer({ outcome, amount: AMOUNT }), AMOUNT, NOW, undefined, false, () => ({ kind: 'LINKED', paymentMethodRef: 'k1.abc', cardBin: '433012' }));
    expect(decision).toMatchObject({ kind: 'FINISH', finish: { status: 'APPROVED', paymentMethodRef: 'k1.abc', cardBin: '433012' } });
    expect(decision).not.toMatchObject({ finish: { refMissing: true } });
  });

  test('P-T50_계산하지 못한 승인은 refMissing 참이고 두 칸이 없다', () => {
    const decision = decideConfirmAnswer(answer({ outcome: 'APPROVED', amount: AMOUNT }), AMOUNT, NOW, undefined, false, () => ({ kind: 'MISSING', reason: 'NO_KEY' }));
    expect(decision).toEqual({ kind: 'FINISH', outcome: 'approved', finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: NOW, refMissing: true } });
  });

  test('P-T50_카드 아닌 승인(NONE)은 두 칸도 refMissing도 없다', () => {
    const decision = decideConfirmAnswer(answer({ outcome: 'APPROVED', amount: AMOUNT }), AMOUNT, NOW, undefined, false, () => ({ kind: 'NONE' }));
    expect(decision).toEqual({ kind: 'FINISH', outcome: 'approved', finish: { status: 'APPROVED', result: 'APPROVED', approvedAtMs: NOW } });
  });

  test('P-T50_리뷰 고침 L4: 금액이 어긋나 UNKNOWN이 되는 승인은 연결값을 계산하지 않는다(뒤의 조회가 계산한다) [ASVS v5.0.0-16.5.3]', () => {
    const linkOf = vi.fn(() => ({ kind: 'LINKED', paymentMethodRef: 'k1.abc', cardBin: '433012' }) as const);
    const decision = decideConfirmAnswer(answer({ outcome: 'APPROVED', amount: AMOUNT + 1 }), AMOUNT, NOW, undefined, false, linkOf);
    expect(decision).toEqual({ kind: 'FINISH', outcome: 'unknown', amountMismatch: true, finish: { status: 'UNKNOWN', result: 'UNKNOWN' } });
    expect(linkOf).not.toHaveBeenCalled();
  });

  test('P-T50_리뷰 고침 L4: 승인이 아닌 답은 연결값을 계산하지 않는다', () => {
    const linkOf = vi.fn(() => ({ kind: 'LINKED', paymentMethodRef: 'k1.abc', cardBin: '433012' }) as const);
    expect(decideConfirmAnswer(answer({ outcome: 'DECLINED', failureCategory: 'CARD_DECLINED' }), AMOUNT, NOW, undefined, false, linkOf)).toEqual({ kind: 'FINISH', outcome: 'declined', finish: { status: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED' } });
    expect(decideConfirmAnswer(answer({ outcome: 'WAITING_FOR_DEPOSIT' }), AMOUNT, NOW, undefined, false, linkOf)).toEqual({ kind: 'FINISH', outcome: 'waiting', finish: { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT' } });
    expect(linkOf).not.toHaveBeenCalled();
  });
});

describe('confirmRetryDelayMs: 처리 중 재전송 간격', () => {
  test.each([
    [1, 1000],
    [2, 2000],
    [3, 4000],
    [4, 8000],
    [5, 16_000],
    [6, 30_000],
    [7, 30_000],
    [100, 30_000],
  ])('PRF181_재전송 %i번째 → %i ms', (attempts, ms) => {
    expect(confirmRetryDelayMs(attempts)).toBe(ms);
  });

  test('PRF181_아주 큰 시도 수에서도 상한이다(거듭제곱이 Infinity로 넘치지 않는다)', () => {
    for (const a of [1024, 2 ** 40, Number.MAX_SAFE_INTEGER]) expect(confirmRetryDelayMs(a), String(a)).toBe(30_000);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('PRF181_시도 %d는 RangeError다', (attempts) => {
    expect(() => confirmRetryDelayMs(attempts)).toThrow(RangeError);
  });
});

describe('paymentEventKey: 결정적 사건 키', () => {
  /** 설계 §2의 계산을 시험이 따로 한다(purchase-svc uuid8과 같은 계산) */
  function uuid8(input: string): string {
    const b = Buffer.from(createHash('sha256').update(input).digest().subarray(0, 16));
    b[6] = (b[6]! & 0x0f) | 0x80;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  test('PRF181_UUID 버전 8이고 SHA-256(PaymentEvent:결제 ID:순번)의 앞 16바이트다', () => {
    const key = paymentEventKey(PAYMENT_ID, 3);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(key).toBe(uuid8(`PaymentEvent:${PAYMENT_ID}:3`));
  });

  test('PRF181_같은 입력은 늘 같은 값이고 순번·결제가 다르면 값이 다르다 [ASVS v5.0.0-2.3.4]', () => {
    expect(paymentEventKey(PAYMENT_ID, 1)).toBe(paymentEventKey(PAYMENT_ID, 1));
    expect(paymentEventKey(PAYMENT_ID, 1)).not.toBe(paymentEventKey(PAYMENT_ID, 2));
    expect(paymentEventKey(PAYMENT_ID, 1)).not.toBe(paymentEventKey(ORDER_ID, 1));
  });

  test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('PRF181_순번 %d는 RangeError다', (seq) => {
    expect(() => paymentEventKey(PAYMENT_ID, seq)).toThrow(RangeError);
  });
});

describe('buildPaymentEvent: trade.payments 값(asyncapi PaymentEvent)', () => {
  const APPROVED_AT_MS = NOW - 5000;
  const finishes: readonly [string, ConfirmFinish][] = [
    ['승인', { status: 'APPROVED', result: 'APPROVED', approvedAtMs: APPROVED_AT_MS, payMethodCategory: 'CARD', latencyMs: 321 }],
    ['이미 승인', { status: 'APPROVED', result: 'ALREADY_APPROVED', approvedAtMs: APPROVED_AT_MS }],
    ['거절', { status: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED', latencyMs: 12 }],
    ['기한 넘김(호출 없음)', { status: 'FAILED', failureCategory: 'EXPIRED' }],
    ['입금 대기', { status: 'AWAITING_DEPOSIT', result: 'WAITING_FOR_DEPOSIT', latencyMs: 40 }],
    ['결과 모름', { status: 'UNKNOWN', result: 'UNKNOWN', latencyMs: 60_000 }],
    ['임대 잔해(호출 없음)', { status: 'UNKNOWN', result: 'UNKNOWN' }],
  ];
  const build = (finish: ConfirmFinish, seq = 4, nowMs = NOW) => buildPaymentEvent({ target: target(), finish, seq, nowMs });

  test('PRF181_승인 사건의 칸 전부가 맞다(occurredAt은 approved_at과 같다, ADR-0140)', () => {
    expect(build(finishes[0]![1])).toEqual({
      eventId: EVENT_ID,
      orderId: ORDER_ID,
      pg: 'SIMULATOR',
      type: 'APPROVED',
      amount: AMOUNT,
      payMethodCategory: 'CARD',
      refMissing: false,
      result: 'APPROVED',
      attemptNo: 2,
      latencyMs: 321,
      occurredAt: new Date(APPROVED_AT_MS).toISOString(),
      eventSeq: 4,
      eventKey: paymentEventKey(PAYMENT_ID, 4),
    });
  });

  test('PRF181_승인이 아닌 사건의 occurredAt은 지금이다', () => {
    expect(build(finishes[2]![1], 3, NOW + 7).occurredAt).toBe(new Date(NOW + 7).toISOString());
    expect(build(finishes[5]![1], 3, NOW + 8).occurredAt).toBe(new Date(NOW + 8).toISOString());
  });

  test('PRF181_거절 사건은 FAILED + 범주를 싣는다', () => {
    expect(build(finishes[2]![1])).toMatchObject({ type: 'FAILED', result: 'DECLINED', failureCategory: 'CARD_DECLINED', latencyMs: 12 });
  });

  test('P-T6_호출 없이 끝난 EXPIRED 사건은 result·latencyMs를 싣지 않는다', () => {
    const e = build(finishes[3]![1]);
    expect(e).toMatchObject({ type: 'FAILED', failureCategory: 'EXPIRED' });
    expect(e).not.toHaveProperty('result');
    expect(e).not.toHaveProperty('latencyMs');
  });

  test('P-T24_답을 잃은 잔해 사건은 UNKNOWN이고 result를 UNKNOWN으로 싣되 latencyMs는 없다 [ASVS v5.0.0-16.5.3]', () => {
    const e = build(finishes[6]![1]);
    expect(e).toMatchObject({ type: 'UNKNOWN', result: 'UNKNOWN' });
    expect(e).not.toHaveProperty('latencyMs');
  });

  test('PRF181_선택 칸은 값이 없으면 키도 없다(failureCategory는 FAILED일 때만)', () => {
    const e = build(finishes[1]![1]);
    for (const key of ['payMethodCategory', 'latencyMs', 'failureCategory', 'paymentMethodRef', 'cardBin']) expect(e, key).not.toHaveProperty(key);
    for (const i of [0, 1, 4, 5, 6]) expect(build(finishes[i]![1]), String(i)).not.toHaveProperty('failureCategory');
  });

  test('PRF181_latencyMs 0은 값이다', () => {
    expect(build({ status: 'UNKNOWN', result: 'UNKNOWN', latencyMs: 0 }).latencyMs).toBe(0);
  });

  test.each(finishes)('PRF181_%s 사건이 asyncapi zod를 통과한다', (_name, finish) => {
    const msg = build(finish);
    const parsed = PaymentEvent.parse(msg);
    expect(parsed.refMissing).toBe(false);
    expect(parsed.type).toBe(finish.status);
    expect(parsed.eventKey).toBe(paymentEventKey(PAYMENT_ID, 4));
  });

  test.each(finishes)('PRF181_%s 사건의 칸 차례는 계약과 같다', (_name, finish) => {
    const keys = Object.keys(build(finish));
    expect(keys).toEqual(Object.keys(PaymentEvent.shape).filter((k) => keys.includes(k)));
  });

  test('P-T50_연결값이 없는 사건의 refMissing은 거짓이고 두 칸이 없다(HOT-145: 계산하지 못했을 때만 참이다)', () => {
    for (const [name, finish] of finishes) {
      const e = build(finish);
      expect(e.refMissing, name).toBe(false);
      expect(e, name).not.toHaveProperty('paymentMethodRef');
      expect(e, name).not.toHaveProperty('cardBin');
    }
  });

  test('P-T50_승인 사건에 연결값 두 칸을 함께 싣는다(칸 차례는 계약과 같다)', () => {
    const e = build({ status: 'APPROVED', result: 'APPROVED', approvedAtMs: APPROVED_AT_MS, payMethodCategory: 'CARD', paymentMethodRef: 'k1.abc', cardBin: '433012' });
    expect(e).toMatchObject({ paymentMethodRef: 'k1.abc', cardBin: '433012', refMissing: false });
    expect(PaymentEvent.parse(e).cardBin).toBe('433012');
    const keys = Object.keys(e);
    expect(keys).toEqual(Object.keys(PaymentEvent.shape).filter((k) => keys.includes(k)));
  });

  test('P-T50_계산하지 못한 승인 사건은 refMissing 참이고 두 칸이 없다', () => {
    const e = build({ status: 'APPROVED', result: 'APPROVED', approvedAtMs: APPROVED_AT_MS, refMissing: true });
    expect(e.refMissing).toBe(true);
    expect(e).not.toHaveProperty('paymentMethodRef');
    expect(e).not.toHaveProperty('cardBin');
  });

  test('PRF181_사건에 결제사 결제 참조·결제 키를 싣지 않는다(ADR-0053) [ASVS v5.0.0-16.2.5]', () => {
    for (const [name, finish] of finishes) {
      const text = JSON.stringify(build(finish));
      expect(text, name).not.toContain(SECRET_PAYMENT_KEY);
      expect(text, name).not.toMatch(/paymentRef|paymentKey|pg_confirm_token/);
    }
  });

  test('PRF181_같은 입력은 같은 값이다(같은 사건을 다시 내면 소비자가 지운다) [ASVS v5.0.0-2.3.4]', () => {
    expect(build(finishes[0]![1])).toEqual(build(finishes[0]![1]));
  });

  test.each([0, -1, 1.5])('PRF181_순번 %d는 RangeError다', (seq) => {
    expect(() => build(finishes[5]![1], seq)).toThrow(RangeError);
  });

  test.each([Number.NaN, 8.64e15 + 1])('PRF181_날짜 범위 밖의 지금 %d는 RangeError다', (nowMs) => {
    expect(() => build(finishes[5]![1], 4, nowMs)).toThrow(RangeError);
  });

  test('PRF181_날짜 범위 밖의 승인 시각은 RangeError다', () => {
    expect(() => build({ status: 'APPROVED', result: 'APPROVED', approvedAtMs: 8.64e15 + 1 })).toThrow(RangeError);
  });
});
