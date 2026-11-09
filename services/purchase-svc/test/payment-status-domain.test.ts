// 결제 결과 long polling의 업무 규칙(domain/payment-status.ts, BUILD_ORDER PRF-166) 단위 시험.
// 정본: docs/features/payment.md §2 '결제 결과 long polling의 첫 구현'('바로 답하는 상태'·'기다리는 상태'·'응답 칸'), ADR-0106(issueDelayed 60초 [가정]),
// openapi GET /v1/orders/{orderId}/payment-status(PaymentStatus), docs/architecture.md 시간 초과 표 'long polling' 행(27초 [가정]).
// 이 층은 바깥을 모르므로 주문 모습(PaymentStatusView)과 '지금'(epoch ms)만 넣어 본다.
//
// 정본 모호(뼈대 주석의 [정함]을 따른다):
// - issueDelayed 경계는 nowMs − createdAtMs ≥ 60초를 참으로 본다(정각 참). 큐 행 created_at이 지금보다 뒤(시계 어긋남)면 거짓이다.
// - 본문의 issueDelayed는 늘 싣는다(APPROVED이면서 늦어지는 중일 때만 true). 큐 행이 남아 있어도 APPROVED가 아니면 false다.
// - reason은 FAILED일 때만 싣는다(다른 상태에 failure_reason이 남아 있어도 싣지 않는다). pg가 없으면 칸을 싣지 않는다. virtualAccount는 늘 싣지 않는다.
// 리뷰 고침(2026-11-05, 새 정본):
// - M1 issueDelayed = 큐 행이 있고 (attempts ≥ 1이고 last_error가 있음: 첫 발권 시도가 실패해 다시 시도 중) 또는 (승인부터 60초 [가정]가 지남).
// - M2 APPROVED는 issueDelayed가 참이어도 기다리는 상태다. 기다리는 중에는 바로 답할 상태가 되거나 APPROVED의 issueDelayed가 거짓 → 참으로 바뀌면 깨운다
//   (기다림 시작 때 본문과 견준다, paymentStatusWakes).
// - M3 파드당 기다림 상한 2,000건 [가정], 기다린 지 5초 [가정]가 넘은 주문은 묶음 조회를 1초 [가정]마다로 줄인다.
import { describe, expect, test } from 'vitest';
import {
  decidePaymentStatus,
  ISSUE_DELAYED_AFTER_MS,
  isIssueDelayed,
  ORDER_STATUSES,
  PAYMENT_STATUS_ANSWER_MARGIN_MS,
  PAYMENT_STATUS_BATCH_MAX,
  PAYMENT_STATUS_IMMEDIATE,
  PAYMENT_STATUS_MAX_DEADLINE_MS,
  PAYMENT_STATUS_POLL_INTERVAL_MS,
  PAYMENT_STATUS_VALUES,
  PAYMENT_STATUS_WAIT_MAX_MS,
  PAYMENT_STATUS_WAITING,
  PAYMENT_STATUS_SLOW_AFTER_MS,
  PAYMENT_STATUS_SLOW_POLL_INTERVAL_MS,
  PAYMENT_STATUS_WAITERS_MAX,
  type OrderStatus,
  type PaymentStatusBody,
  type PaymentStatusDecision,
  type PaymentStatusView,
  paymentStatusWaitMs,
  paymentStatusWakes,
} from '../src/modules/booking/index.js';
import { ACCOUNT, NOW } from './order-cases.js';

const ORDER = '0190f3a1-7c2e-7f00-8000-0000000000f2';
const SEC = 1_000;

const view = (status: OrderStatus, over: Partial<PaymentStatusView> = {}): PaymentStatusView => ({ orderId: ORDER, accountId: ACCOUNT, status, pg: 'TOSS', ...over });

describe('정본 값(상수)', () => {
  test('FR011_기다림 25초·답 몫 1초·이 경로 상한 27초·issueDelayed 60초·묶음 조회 200ms·한 번 500건이다 [가정]', () => {
    expect(PAYMENT_STATUS_WAIT_MAX_MS).toBe(25_000);
    expect(PAYMENT_STATUS_ANSWER_MARGIN_MS).toBe(1_000);
    expect(PAYMENT_STATUS_MAX_DEADLINE_MS).toBe(27_000);
    expect(ISSUE_DELAYED_AFTER_MS).toBe(60_000);
    expect(PAYMENT_STATUS_POLL_INTERVAL_MS).toBe(200);
    expect(PAYMENT_STATUS_BATCH_MAX).toBe(500);
  });

  test('M3_파드당 기다림 상한 2,000건, 기다린 지 5초가 넘은 주문의 묶음 조회 간격 1초다 [가정]', () => {
    expect(PAYMENT_STATUS_WAITERS_MAX).toBe(2_000);
    expect(PAYMENT_STATUS_SLOW_AFTER_MS).toBe(5_000);
    expect(PAYMENT_STATUS_SLOW_POLL_INTERVAL_MS).toBe(1_000);
  });

  test('FR011_응답 status 값은 openapi PaymentStatus.status의 여덟 값이다', () => {
    expect([...PAYMENT_STATUS_VALUES]).toEqual(['ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'APPROVED', 'CONFIRMED', 'FAILED', 'UNKNOWN', 'COMPENSATED']);
  });

  test('FR011_바로 답하는 상태·기다리는 상태 집합은 정본대로이고, 둘에 없는 셋(CREATED·AUTHENTICATED·EXPIRED)은 거절이다', () => {
    expect([...PAYMENT_STATUS_IMMEDIATE].sort()).toEqual(['AWAITING_DEPOSIT', 'COMPENSATED', 'CONFIRMED', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'UNKNOWN']);
    expect([...PAYMENT_STATUS_WAITING].sort()).toEqual(['ACCEPTED', 'APPROVED', 'RESERVED']);
    const neither = ORDER_STATUSES.filter((s) => !PAYMENT_STATUS_IMMEDIATE.has(s) && !PAYMENT_STATUS_WAITING.has(s));
    expect([...neither].sort()).toEqual(['AUTHENTICATED', 'CREATED', 'EXPIRED']);
  });
});

/** 큐 행 칸(행이 없으면 셋 다 없다) */
const job = (createdAtMs: number, attempts = 0, lastError?: string): Pick<PaymentStatusView, 'issueJobCreatedAtMs' | 'issueJobAttempts' | 'issueJobLastError'> => ({
  issueJobCreatedAtMs: createdAtMs,
  issueJobAttempts: attempts,
  ...(lastError !== undefined ? { issueJobLastError: lastError } : {}),
});

describe('isIssueDelayed(발권이 늦어지는 중, ADR-0106)', () => {
  test.each([
    ['큐 행 없음', {}, false],
    ['방금 승인(0초)', job(NOW), false],
    ['59.999초', job(NOW - 59_999), false],
    ['정각 60초(참)', job(NOW - 60_000), true],
    ['60.001초', job(NOW - 60_001), true],
    ['10분', job(NOW - 600_000), true],
    ['큐 행이 지금보다 뒤(시계 어긋남)', job(NOW + 5_000), false],
  ] as const)('ADR0106_%s → %s', (_name, j, want) => {
    expect(isIssueDelayed(j, NOW)).toBe(want);
  });

  test.each([
    ['첫 발권 시도가 실패해 다시 시도 중(시도 1, 마지막 오류 있음, 0초)', job(NOW, 1, 'UNAVAILABLE'), true],
    ['다시 시도 중(시도 3, 10초)', job(NOW - 10_000, 3, 'DEADLINE_EXCEEDED'), true],
    ['다시 시도 중은 시계가 어긋나도 참(created_at이 미래)', job(NOW + 5_000, 1, 'UNAVAILABLE'), true],
    ['시도 1이지만 마지막 오류 없음(첫 시도 중)', job(NOW, 1), false],
    ['시도 0인데 마지막 오류만 있음(있어서는 안 될 행)', job(NOW, 0, 'UNAVAILABLE'), false],
    ['시도 0·오류 없음이라도 60초가 지나면 참(알림 기준 안전망)', job(NOW - 60_000, 0), true],
  ] as const)('M1_%s → %s', (_name, j, want) => {
    expect(isIssueDelayed(j, NOW)).toBe(want);
  });
});

/** 13개 상태 각각의 기대 결정(issueDelayed가 거짓인 APPROVED, failureReason 'CARD_DECLINED'을 함께 둔 주문) */
const EXPECT: Record<OrderStatus, PaymentStatusDecision> = {
  CREATED: { kind: 'REJECT', problem: 'NOT_ACCEPTED' },
  AUTHENTICATED: { kind: 'REJECT', problem: 'NOT_ACCEPTED' },
  ACCEPTED: { kind: 'WAIT', body: { status: 'ACCEPTED', issueDelayed: false, pg: 'TOSS' } },
  RESERVED: { kind: 'WAIT', body: { status: 'RESERVED', issueDelayed: false, pg: 'TOSS' } },
  AWAITING_DEPOSIT: { kind: 'IMMEDIATE', body: { status: 'AWAITING_DEPOSIT', issueDelayed: false, pg: 'TOSS' } },
  APPROVED: { kind: 'WAIT', body: { status: 'APPROVED', issueDelayed: false, pg: 'TOSS' } },
  UNKNOWN: { kind: 'IMMEDIATE', body: { status: 'UNKNOWN', issueDelayed: false, pg: 'TOSS' } },
  CONFIRMED: { kind: 'IMMEDIATE', body: { status: 'CONFIRMED', issueDelayed: false, pg: 'TOSS' } },
  FAILED: { kind: 'IMMEDIATE', body: { status: 'FAILED', reason: 'CARD_DECLINED', issueDelayed: false, pg: 'TOSS' } },
  COMPENSATED: { kind: 'IMMEDIATE', body: { status: 'COMPENSATED', issueDelayed: false, pg: 'TOSS' } },
  PARTIALLY_REFUNDED: { kind: 'IMMEDIATE', body: { status: 'CONFIRMED', issueDelayed: false, pg: 'TOSS' } },
  REFUNDED: { kind: 'IMMEDIATE', body: { status: 'CONFIRMED', issueDelayed: false, pg: 'TOSS' } },
  EXPIRED: { kind: 'REJECT', problem: 'ORDER_EXPIRED' },
};

describe('decidePaymentStatus(주문 상태 → 응답 결정)', () => {
  test('FR011_결정 표는 주문 상태 13개를 모두 덮는다', () => {
    expect(Object.keys(EXPECT).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  test.each([...ORDER_STATUSES])('FR011_%s의 결정(바로 답함·기다림·409)과 본문이 정본대로다(칸이 없으면 싣지 않는다)', (status) => {
    // 큐 행은 APPROVED에만 생기지만, 방금 만든 행(늦어지지 않음)을 모든 상태에 두어 상태만으로 갈리는지 본다
    const got = decidePaymentStatus(view(status, { failureReason: 'CARD_DECLINED', ...job(NOW - 1_000) }), NOW);
    expect(got).toStrictEqual(EXPECT[status]);
  });

  test('FR011_환불 상태 둘(PARTIALLY_REFUNDED·REFUNDED)은 CONFIRMED로 바로 답한다', () => {
    for (const s of ['PARTIALLY_REFUNDED', 'REFUNDED'] as const) {
      const d = decidePaymentStatus(view(s), NOW);
      expect({ s, kind: d.kind, status: d.kind === 'REJECT' ? undefined : d.body.status }).toEqual({ s, kind: 'IMMEDIATE', status: 'CONFIRMED' });
    }
  });

  test('FR011_FAILED의 reason은 주문 failure_reason 값 그대로이고(결제 쪽 사유·Saga 사유 모두), 비었으면 reason 칸이 없다', () => {
    for (const reason of ['CARD_DECLINED', 'INSUFFICIENT_FUNDS', 'SEAT_CONFLICT', 'confirm_rejected']) {
      const d = decidePaymentStatus(view('FAILED', { failureReason: reason }), NOW);
      expect(d).toStrictEqual({ kind: 'IMMEDIATE', body: { status: 'FAILED', reason, issueDelayed: false, pg: 'TOSS' } });
    }
    const empty = decidePaymentStatus(view('FAILED'), NOW);
    expect(empty).toStrictEqual({ kind: 'IMMEDIATE', body: { status: 'FAILED', issueDelayed: false, pg: 'TOSS' } });
    expect(empty.kind !== 'REJECT' && 'reason' in empty.body).toBe(false);
  });

  test('FR011_FAILED가 아닌 상태는 failure_reason이 남아 있어도 reason을 싣지 않는다', () => {
    for (const s of ['COMPENSATED', 'CONFIRMED', 'UNKNOWN', 'ACCEPTED'] as const) {
      const d = decidePaymentStatus(view(s, { failureReason: 'LEFTOVER' }), NOW);
      expect({ s, has: d.kind !== 'REJECT' && 'reason' in d.body }).toEqual({ s, has: false });
    }
  });

  test('FR011_접수 결제사가 없으면 pg 칸이 없고, 있으면 그 값(TOSS·PORTONE·SIMULATOR)이다. virtualAccount는 늘 싣지 않는다', () => {
    const none = decidePaymentStatus(view('CONFIRMED', { pg: undefined }), NOW);
    expect(none).toStrictEqual({ kind: 'IMMEDIATE', body: { status: 'CONFIRMED', issueDelayed: false } });
    for (const pg of ['TOSS', 'PORTONE', 'SIMULATOR'] as const) {
      for (const s of ['ACCEPTED', 'AWAITING_DEPOSIT', 'CONFIRMED'] as const) {
        const d = decidePaymentStatus(view(s, { pg }), NOW);
        expect(d.kind !== 'REJECT' && d.body.pg).toBe(pg);
        expect(d.kind !== 'REJECT' && 'virtualAccount' in d.body).toBe(false);
      }
    }
  });

  test('M2_APPROVED이면서 늦어지는 중(60초 지남·다시 시도 중)이어도 기다리는 상태이고, 본문 issueDelayed는 true다', () => {
    for (const j of [job(NOW - 60_000), job(NOW - 60_001), job(NOW - 300_000), job(NOW, 1, 'UNAVAILABLE')]) {
      const d = decidePaymentStatus(view('APPROVED', j), NOW);
      expect({ j, d }).toStrictEqual({ j, d: { kind: 'WAIT', body: { status: 'APPROVED', issueDelayed: true, pg: 'TOSS' } } });
    }
  });

  test('ADR0106_APPROVED이면서 60초가 안 됐거나 큐 행이 없으면 기다린다(본문 issueDelayed false)', () => {
    for (const j of [job(NOW - 59_999), job(NOW), {}]) {
      const d = decidePaymentStatus(view('APPROVED', j), NOW);
      expect({ j, d }).toStrictEqual({ j, d: { kind: 'WAIT', body: { status: 'APPROVED', issueDelayed: false, pg: 'TOSS' } } });
    }
  });

  test('ADR0106_APPROVED가 아닌 상태는 오래된 큐 행(다시 시도 중 포함)이 있어도 issueDelayed가 false다', () => {
    for (const s of ['CONFIRMED', 'COMPENSATED', 'ACCEPTED', 'RESERVED', 'UNKNOWN'] as const) {
      const d = decidePaymentStatus(view(s, job(NOW - 600_000, 2, 'UNAVAILABLE')), NOW);
      expect({ s, issueDelayed: d.kind === 'REJECT' ? undefined : d.body.issueDelayed }).toEqual({ s, issueDelayed: false });
    }
  });

  test('FR011_계정은 보지 않는다(쓰임새가 먼저 본다): 다른 계정의 주문도 상태대로 정한다', () => {
    const d = decidePaymentStatus(view('CONFIRMED', { accountId: '0190f3a1-7c2e-7a00-8000-0000000000a2' }), NOW);
    expect(d.kind).toBe('IMMEDIATE');
  });
});

describe('paymentStatusWakes(기다리던 요청을 깨울까: 기다림 시작 때 본문과 견준다, M2)', () => {
  const since = (status: PaymentStatusBody['status'], issueDelayed = false): PaymentStatusBody => ({ status, issueDelayed, pg: 'TOSS' });

  test('M2_바로 답할 상태(CONFIRMED·FAILED·AWAITING_DEPOSIT·UNKNOWN·COMPENSATED·환불)가 되면 깨운다', () => {
    for (const s of ['CONFIRMED', 'FAILED', 'AWAITING_DEPOSIT', 'UNKNOWN', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const) {
      expect({ s, w: paymentStatusWakes(view(s), since('RESERVED'), NOW) }).toEqual({ s, w: true });
    }
  });

  test('M2_409 상태(CREATED·EXPIRED)가 되어도 깨운다(기다림이 끝나 그 거절로 답한다)', () => {
    for (const s of ['CREATED', 'AUTHENTICATED', 'EXPIRED'] as const) {
      expect({ s, w: paymentStatusWakes(view(s), since('ACCEPTED'), NOW) }).toEqual({ s, w: true });
    }
  });

  test('M2_기다리는 상태 사이를 옮기기만 하면(ACCEPTED → RESERVED → APPROVED, issueDelayed 거짓) 깨우지 않는다', () => {
    expect(paymentStatusWakes(view('RESERVED'), since('ACCEPTED'), NOW)).toBe(false);
    expect(paymentStatusWakes(view('APPROVED', job(NOW - 1_000)), since('RESERVED'), NOW)).toBe(false);
    expect(paymentStatusWakes(view('APPROVED', job(NOW - 1_000)), since('APPROVED'), NOW)).toBe(false);
  });

  test('M2_APPROVED의 issueDelayed가 거짓 → 참으로 바뀌면 깨우고(60초 지남·다시 시도 중), 시작 때 이미 참이었으면 깨우지 않는다', () => {
    expect(paymentStatusWakes(view('APPROVED', job(NOW - 60_000)), since('APPROVED', false), NOW)).toBe(true);
    expect(paymentStatusWakes(view('APPROVED', job(NOW, 1, 'UNAVAILABLE')), since('RESERVED'), NOW)).toBe(true);
    expect(paymentStatusWakes(view('APPROVED', job(NOW - 60_000)), since('APPROVED', true), NOW)).toBe(false);
  });

  test('M2_시작 본문을 모르면(undefined) issueDelayed 거짓에서 시작한 것으로 본다', () => {
    expect(paymentStatusWakes(view('APPROVED', job(NOW - 60_000)), undefined, NOW)).toBe(true);
    expect(paymentStatusWakes(view('APPROVED', job(NOW)), undefined, NOW)).toBe(false);
    expect(paymentStatusWakes(view('CONFIRMED'), undefined, NOW)).toBe(true);
  });
});

describe('paymentStatusWaitMs(기다릴 시간 = min(25초, 남은 시간 − 1초))', () => {
  test.each([
    ['이 경로 상한 27초', 27 * SEC, 25 * SEC],
    ['남은 30초(상한 밖 값도 같은 식)', 30 * SEC, 25 * SEC],
    ['정확히 26초', 26 * SEC, 25 * SEC],
    ['25.999초', 25_999, 24_999],
    ['기본 상한 15초', 15 * SEC, 14 * SEC],
    ['1.5초', 1_500, 500],
    ['1.001초', 1_001, 1],
    ['정확히 1초 → 기다리지 않음', 1_000, 0],
    ['0.5초 → 0(음수 아님)', 500, 0],
    ['0', 0, 0],
  ] as const)('FR011_%s → %d ms', (_name, remaining, want) => {
    expect(paymentStatusWaitMs(remaining)).toBe(want);
  });

  test('FR011_결과는 늘 0 이상 25초 이하의 정수다', () => {
    for (let r = 0; r <= 40_000; r += 777) {
      const w = paymentStatusWaitMs(r);
      expect(Number.isInteger(w) && w >= 0 && w <= 25_000, String(r)).toBe(true);
    }
  });
});
