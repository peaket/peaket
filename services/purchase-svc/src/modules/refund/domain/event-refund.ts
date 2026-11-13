// 회차 취소 일괄 환불의 값·상태(BAT-425 GAT-120·GAT-130, docs/features/transfer-refund.md §5, refund.proto).
// 첫 몫은 취소(CANCEL)만 받는다. 연기(POSTPONE)·환급 신청 기간·자동 정지·알림 발송은 후속이다.
import { createHash } from 'node:crypto';

export const EVENT_REFUND_KINDS = ['CANCEL', 'POSTPONE'] as const;
export type EventRefundKind = (typeof EVENT_REFUND_KINDS)[number];

export const EVENT_REFUND_FAULTS = ['ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE'] as const;
export type EventRefundFault = (typeof EVENT_REFUND_FAULTS)[number];

export const EVENT_REFUND_STATUSES = ['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED', 'REJECTED'] as const;
export type EventRefundStatus = (typeof EVENT_REFUND_STATUSES)[number];

export const EVENT_REFUND_ITEM_STATUSES = ['PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN'] as const;
export type EventRefundItemStatus = (typeof EVENT_REFUND_ITEM_STATUSES)[number];

export const REFUND_JOB_STATES = ['RUNNING', 'PAUSED', 'COMPLETED'] as const;
export type RefundJobState = (typeof REFUND_JOB_STATES)[number];

export const REFUND_PAUSE_REASONS = ['AUTO_FAILURE_RATE', 'AUTO_CONSECUTIVE_FAILURES', 'AUTO_CIRCUIT_OPEN', 'AUTO_REJECT_RATE', 'MANUAL'] as const;
export type RefundPauseReason = (typeof REFUND_PAUSE_REASONS)[number];

export const REFUND_PG_PROVIDERS = ['TOSS', 'PORTONE', 'SIMULATOR'] as const;
export type RefundPgProvider = (typeof REFUND_PG_PROVIDERS)[number];

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
}

export interface EventRefundPgProgress {
  readonly pg: RefundPgProvider;
  readonly state: RefundJobState;
  readonly pauseReason?: RefundPauseReason;
  readonly done: number;
  readonly failed: number;
  readonly unknown: number;
}

export interface EventRefundProgress {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly perPg: readonly EventRefundPgProgress[];
}

export interface EventCancellationRequest {
  readonly requestId: string;
  readonly eventId: string;
  readonly kind: EventRefundKind;
  readonly status: EventRefundStatus;
  readonly fault?: EventRefundFault;
  readonly fanNoticeReason?: string;
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

export function progressOf(items: readonly EventRefundItem[], paused: readonly { pg: RefundPgProvider; reason: RefundPauseReason }[] = []): EventRefundProgress {
  const byPg = new Map<RefundPgProvider, { total: number; done: number; failed: number; unknown: number }>();
  for (const item of items) {
    const p = byPg.get(item.pg) ?? { total: 0, done: 0, failed: 0, unknown: 0 };
    p.total++;
    if (item.status === 'REFUNDED') p.done++;
    else if (item.status === 'FAILED') p.failed++;
    else if (item.status === 'UNKNOWN') p.unknown++;
    byPg.set(item.pg, p);
  }
  const perPg: EventRefundPgProgress[] = [...byPg.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pg, p]) => {
      const pause = paused.find((x) => x.pg === pg);
      const state: RefundJobState = pause ? 'PAUSED' : p.done + p.failed === p.total ? 'COMPLETED' : 'RUNNING';
      return { pg, state, ...(pause ? { pauseReason: pause.reason } : {}), done: p.done, failed: p.failed, unknown: p.unknown };
    });
  return { total: items.length, done: items.filter((i) => i.status === 'REFUNDED').length, failed: items.filter((i) => i.status === 'FAILED').length, perPg };
}
