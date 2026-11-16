// 회차 취소 요청 저장·purchase-svc 일괄 환불 시작 포트.
import type { AuditRecord } from '../../audit/audit.js';
import type { EventCancellationDryRun, EventCancellationFault, EventCancellationKind, EventCancellationPg, EventCancellationRecord, EventCancellationStatus, EventCancellationView } from './event-cancellation.js';

/** 멱등 요청 값(guidelines §4, platform IdempotencyRequest와 같은 모양). 범위는 계정 × 작업 × 키, 지문은 SHA-256 */
export interface EventCancellationIdempotency {
  readonly accountRef: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: Uint8Array;
}

/**
 * 요청 넣기의 결과(BAT-420 GAT-110).
 * INSERTED: 새로 넣음. REPLAYED: 같은 멱등 키·같은 본문의 다시 보냄이라 처음 응답을 돌려줌(행·감사는 그대로).
 * ACTIVE: 같은 회차에 진행 중 요청이 있어 넣지 않음(멱등 기록도 남기지 않는다)
 */
export type EventCancellationInsert =
  | { readonly status: 'INSERTED' }
  | { readonly status: 'REPLAYED'; readonly view: EventCancellationView }
  | { readonly status: 'ACTIVE'; readonly requestId: string };

export interface EventCancellationStore {
  /**
   * 상태 행과 감사 기록을 같은 트랜잭션에 쓴다(감사 기록이 있으면). 진행 중 요청 확인도 같은 트랜잭션에서 한다.
   * 멱등 요청을 주면 그 키 행을 트랜잭션의 첫 쓰기로 잡는다: 같은 키·같은 지문이면 REPLAYED, 다른 지문이면 422 idempotency-key-reused를 던진다
   */
  insert(record: EventCancellationRecord, audit?: AuditRecord, idem?: EventCancellationIdempotency): Promise<EventCancellationInsert>;
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

// ---- BAT-420 몫 D(OPEN[45] 결정, 빈 뼈대): 회차 취소 요청 중 보류 취소의 환급 미룸(purchase-svc SetEventRefundHold) ----

/** 미룸 기한: 걸거나 늘릴 때 지금 + 72시간 [가정] */
export const EVENT_REFUND_HOLD_MS = 259_200_000;

/** purchase-svc SetEventRefundHold. 실패(UNAVAILABLE·시간 초과·거절)는 던진다 */
export interface EventRefundHolds {
  hold(q: { eventId: string; requestId: string; held: boolean; expiresAtMs?: number }): Promise<{ held: boolean }>;
}

export const EVENT_CANCELLATION_STORE = Symbol.for('peaket.ops.event-cancellation-store');
export const EVENT_REFUND_STARTER = Symbol.for('peaket.ops.event-refund-starter');
