// 회차 취소 일괄 환불의 값·상태(BAT-425 GAT-120·GAT-130, docs/features/transfer-refund.md §5, refund.proto).
// 취소(CANCEL)는 확정 즉시 전 대상를 환불하고, 연기(POSTPONE)는 환급 신청 창(REFUND_WINDOW)을 연다.
// 자동 정지·재시도·백그라운드 실행기·팬 알림·배상 연결은 이 파일의 값으로만 판단한다.
import { createHash } from 'node:crypto';

export const EVENT_REFUND_KINDS = ['CANCEL', 'POSTPONE'] as const;
export type EventRefundKind = (typeof EVENT_REFUND_KINDS)[number];

export const EVENT_REFUND_FAULTS = ['ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE'] as const;
export type EventRefundFault = (typeof EVENT_REFUND_FAULTS)[number];

export const EVENT_REFUND_STATUSES = ['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED', 'REJECTED'] as const;
export type EventRefundStatus = (typeof EVENT_REFUND_STATUSES)[number];

export const EVENT_REFUND_ITEM_STATUSES = ['PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN', 'NOT_APPLIED'] as const;
export type EventRefundItemStatus = (typeof EVENT_REFUND_ITEM_STATUSES)[number];

export const REFUND_JOB_STATES = ['RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED'] as const;
export type RefundJobState = (typeof REFUND_JOB_STATES)[number];

export const REFUND_PAUSE_REASONS = ['AUTO_FAILURE_RATE', 'AUTO_CONSECUTIVE_FAILURES', 'AUTO_CIRCUIT_OPEN', 'AUTO_REJECT_RATE', 'AUTO_FAILED_AMOUNT', 'MANUAL'] as const;
export type RefundPauseReason = (typeof REFUND_PAUSE_REASONS)[number];

export const REFUND_PG_PROVIDERS = ['TOSS', 'PORTONE', 'SIMULATOR'] as const;
export type RefundPgProvider = (typeof REFUND_PG_PROVIDERS)[number];

/** 결제사 호출 한 번의 결과. 자동 정지의 1분 창을 세는 데 쓴다 */
export const EVENT_REFUND_ATTEMPT_OUTCOMES = ['SUCCESS', 'FAILURE', 'REJECT', 'UNKNOWN'] as const;
export type EventRefundAttemptOutcome = (typeof EVENT_REFUND_ATTEMPT_OUTCOMES)[number];

/**
 * 자동 정지 기준(추천 적용 2026-10-28, 기술 검토 중간-045, docs/features/transfer-refund.md §5).
 * 실패 금액 기준은 정본에 숫자가 없어 구현에서 500만 원 [가정]으로 더했다(2026-11-15, R-583).
 * 1분 창의 호출이 20건 [가정] 이상일 때만 비율을 센다.
 */
export const EVENT_REFUND_AUTO_STOP = {
  windowMs: 60_000,
  minCalls: 20,
  failureRateBp: 500,
  rejectRateBp: 500,
  consecutiveFailures: 20,
  failedAmount: 5_000_000,
  maxAttempts: 5,
} as const;

/** 재시도 간격 1분→5분→15분→1시간→6시간 [가정](기존 예매 취소 환급 재시도와 같은 차례) */
export function eventRefundRetryDelayMs(attempts: number): number {
  const table = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
  return table[Math.max(0, Math.min(table.length - 1, attempts - 1))]!;
}

/** 환불 대상 한 장. purchase DB의 주문·항목과 회차 판매 설정에서 만든다 */
export interface EventRefundTarget {
  readonly orderId: string;
  readonly ticketId: string;
  readonly seatId: string;
  readonly payerAccountId: string;
  readonly ticketPrice: number;
  readonly bookedAtMs: number;
  readonly saleEndsAtMs: number;
  readonly entryOpensAtMs?: number;
  readonly pg: RefundPgProvider;
}

export interface EventRefundItem {
  readonly requestId: string;
  readonly orderId: string;
  readonly ticketId: string;
  readonly cancellationId: string;
  readonly pg: RefundPgProvider;
  readonly status: EventRefundItemStatus;
  readonly attempts: number;
  readonly lastError?: string;
  /** 연기(POSTPONE)에서 팬이 환급을 신청한 시각. CANCEL은 만들 때 채운다 */
  readonly appliedAtMs?: number;
  /** 재시도 실행기가 이 시각 뒤에 다시 본다. 없으면 바로 본다 */
  readonly nextAttemptAtMs?: number;
}

/** 결제사 호출 한 번의 기록(자동 정지의 1분 창·연속 실패·실패 금액) */
export interface EventRefundAttempt {
  readonly requestId: string;
  readonly ticketId: string;
  readonly pg: RefundPgProvider;
  readonly amount: number;
  readonly outcome: EventRefundAttemptOutcome;
  readonly atMs: number;
}

export interface EventRefundWindowStats {
  readonly calls: number;
  readonly failures: number;
  readonly rejects: number;
  readonly failedAmount: number;
}

export interface EventRefundPgProgress {
  readonly pg: RefundPgProvider;
  readonly state: RefundJobState;
  readonly pauseReason?: RefundPauseReason;
  readonly done: number;
  readonly failed: number;
  readonly unknown: number;
  readonly notApplied: number;
}

export interface EventRefundProgress {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly notApplied: number;
  readonly perPg: readonly EventRefundPgProgress[];
}

export interface EventCancellationRequest {
  readonly requestId: string;
  readonly eventId: string;
  readonly kind: EventRefundKind;
  readonly status: EventRefundStatus;
  readonly fault?: EventRefundFault;
  readonly fanNoticeReason?: string;
  /** 연기된 회차의 새 시작 시각. 연기(POSTPONE)에만 있다 */
  readonly postponedToMs?: number;
  /** 환급 신청 창이 닫히는 시각. 연기(POSTPONE)에만 있다 */
  readonly refundWindowClosesAtMs?: number;
  readonly targetOrders: number;
  readonly refundTotal: number;
  readonly compensationTargets: number;
  readonly compensationTotal: number;
  readonly progress: EventRefundProgress;
  readonly ruledBy?: string;
  readonly confirmedBy?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface EventRefundPreview {
  readonly targetOrders: number;
  readonly refundTotal: number;
  readonly compensationTargets: number;
  readonly compensationTotal: number;
  readonly perPg: readonly { readonly pg: RefundPgProvider; readonly orders: number; readonly estimatedSeconds: number }[];
}

/** 배상금은 실제 결제 금액의 10%, 원 미만 올림. 불가항력은 배상하지 않는다(transfer-refund §6) */
export function compensationAmount(ticketPrice: number, fault: EventRefundFault): number {
  if (!Number.isSafeInteger(ticketPrice) || ticketPrice < 0) throw new RangeError(`티켓 금액은 0 이상의 정수다: ${String(ticketPrice)}`);
  if (fault === 'FORCE_MAJEURE') return 0;
  return Math.ceil(ticketPrice / 10);
}

/** 같은 요청·티켓의 재시도가 같은 결제사 멱등키(cancel-{cancellationId})를 쓰게 하는 결정적 UUID */
export function eventRefundCancellationId(requestId: string, ticketId: string): string {
  const h = createHash('sha256').update(`${requestId}:${ticketId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * 진행률. 결제사 몫의 상태는 멈춤(PAUSED) → 신청 창(REFUND_WINDOW) → 끝(COMPLETED) → 실행(RUNNING) 차례로 고른다.
 * `windowOpen`이면 아직 끝나지 않은 몫을 REFUND_WINDOW로 보인다(연기 확정 뒤 신청을 기다리는 동안).
 */
export function progressOf(
  items: readonly EventRefundItem[],
  paused: readonly { pg: RefundPgProvider; reason: RefundPauseReason }[] = [],
  windowOpen = false,
): EventRefundProgress {
  const byPg = new Map<RefundPgProvider, { total: number; done: number; failed: number; unknown: number; notApplied: number }>();
  for (const item of items) {
    const p = byPg.get(item.pg) ?? { total: 0, done: 0, failed: 0, unknown: 0, notApplied: 0 };
    p.total++;
    if (item.status === 'REFUNDED') p.done++;
    else if (item.status === 'FAILED') p.failed++;
    else if (item.status === 'UNKNOWN') p.unknown++;
    else if (item.status === 'NOT_APPLIED') p.notApplied++;
    byPg.set(item.pg, p);
  }
  const perPg: EventRefundPgProgress[] = [...byPg.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pg, p]) => {
      const pause = paused.find((x) => x.pg === pg);
      const terminal = p.done + p.failed + p.notApplied === p.total;
      const state: RefundJobState = pause ? 'PAUSED' : terminal ? 'COMPLETED' : windowOpen ? 'REFUND_WINDOW' : 'RUNNING';
      return {
        pg,
        state,
        ...(pause ? { pauseReason: pause.reason } : {}),
        done: p.done,
        failed: p.failed,
        unknown: p.unknown,
        notApplied: p.notApplied,
      };
    });
  return {
    total: items.length,
    done: items.filter((i) => i.status === 'REFUNDED').length,
    failed: items.filter((i) => i.status === 'FAILED').length,
    notApplied: items.filter((i) => i.status === 'NOT_APPLIED').length,
    perPg,
  };
}

/** 1분 창의 비율(기준점, 10000분의 1) */
export function rateBp(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part * 10_000) / whole);
}
