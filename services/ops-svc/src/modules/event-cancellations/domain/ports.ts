// 회차 취소 요청 저장·purchase-svc 일괄 환불 시작 포트.
import type { AuditRecord } from '../../audit/audit.js';
import type { EventCancellationDryRun, EventCancellationFault, EventCancellationKind, EventCancellationPg, EventCancellationRecord, EventCancellationStatus } from './event-cancellation.js';

export interface EventCancellationStore {
  /** 상태 행과 감사 기록을 같은 트랜잭션에 쓴다(감사 기록이 있으면) */
  insert(record: EventCancellationRecord, audit?: AuditRecord): Promise<void>;
  find(requestId: string): Promise<EventCancellationRecord | undefined>;
  findActiveByEvent(eventId: string): Promise<EventCancellationRecord | undefined>;
  /** version 조건부 갱신과 감사 기록을 같은 트랜잭션에 쓴다. 다른 요청이 먼저 갱신했으면 false */
  save(record: EventCancellationRecord, audit?: AuditRecord): Promise<boolean>;
  list(filter: { eventId?: string | undefined; status?: readonly EventCancellationStatus[] | undefined; limit: number }): Promise<EventCancellationRecord[]>;
}

export interface EventRefundStartInput {
  readonly eventId: string;
  readonly requestId: string;
  readonly fault: EventCancellationFault;
  readonly ruledBy: string;
  readonly confirmedBy: string;
  readonly kind?: EventCancellationKind;
  readonly fanNoticeReason?: string;
  /** POSTPONE 확정 때 바뀐 공연 시작(new_starts_at, BAT-420) */
  readonly postponedToMs?: number;
}

export interface EventRefundJobView {
  readonly jobId: string;
  readonly state: string;
}

/** purchase-svc EventRefundService의 필요한 몫. 없으면 확정·정지·재개가 503이다. */
export interface EventRefundStarter {
  start(input: EventRefundStartInput): Promise<EventRefundJobView>;
  pause(input: { requestId: string; pg?: EventCancellationPg; reason: string }): Promise<EventRefundJobView>;
  resume(input: { requestId: string; pg?: EventCancellationPg; reason?: string }): Promise<EventRefundJobView>;
}

// ---- BAT-420 GAT-110(빈 뼈대): 판매 중지 확인·판매 멈춤·미리보기·진행률·소속 확인·판정 대기 건 ----

/** 그 회차의 SALE_STOP·SALE_RESUME 가운데 마지막 SUCCEEDED가 SALE_STOP인가(ops 명령 기록, LCH-090 전까지) */
export interface SaleSuspensionLookup {
  isSuspended(eventId: string): Promise<boolean>;
}

/** purchase → queue 판매 중지 집행(commandId·suspensionRef = requestId, reason EVENT_CANCELLATION). 실패는 던진다 */
export interface EventSaleStopper {
  stop(q: { eventId: string; requestId: string }): Promise<void>;
}

/** purchase-svc 일괄 환불 진행률(GetEventRefundJob의 칸을 다 읽은 값) */
export interface EventRefundJobProgress {
  readonly state: string;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly perPg: readonly { readonly pg: EventCancellationPg; readonly state: string; readonly pauseReason?: string; readonly done: number; readonly failed: number; readonly unknown: number }[];
  readonly appliedOrders?: number;
  /** ISO 8601 */
  readonly refundWindowClosesAt?: string;
}

/** purchase-svc PreviewEventRefund·GetEventRefundJob. 실패는 던진다 */
export interface EventRefundReader {
  preview(q: { eventId: string; requestId: string; fault: EventCancellationFault }): Promise<EventCancellationDryRun>;
  job(q: { requestId: string }): Promise<EventRefundJobProgress>;
}

/** core-svc 내부 판매 설정(GET /internal/v1/events/{eventId}/sale-config). 없으면 undefined, 실패는 던진다 */
export interface EventOwnerLookup {
  find(eventId: string): Promise<{ promoterId: string; startsAtMs: number; endsAtMs?: number } | undefined>;
}

/** CS 처리함 JUDGEMENT_PENDING(대상 요청 ID). 같은 대상은 한 건 */
export interface EventCancellationCases {
  judgementPending(requestId: string, nowMs: number): Promise<void>;
}

export const EVENT_CANCELLATION_STORE = Symbol.for('peaket.ops.event-cancellation-store');
export const EVENT_REFUND_STARTER = Symbol.for('peaket.ops.event-refund-starter');
