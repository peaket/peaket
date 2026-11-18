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
  /**
   * 같은 멱등 키의 처음 응답(보관 기간 안, 커밋된 것만). 없으면 undefined, 다른 지문이면 422 idempotency-key-reused를 던진다.
   * 회차 취소(CANCEL) 요청이 미룸을 걸기 전에 다시 온 요청을 가린다(BAT-420 몫 D). 없는 저장소는 넣기의 멱등 규칙만 쓴다
   */
  replayOf?(idem: EventCancellationIdempotency): Promise<EventCancellationView | undefined>;
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
  /**
   * 그 요청 ID의 일괄 환불 진행률. purchase-svc에 그 일괄 환불이 없으면(gRPC NOT_FOUND) undefined다(웨이브 끝 리뷰 K4: RUNNING 고착 다시 확정의 근거).
   * 그 밖의 실패(UNAVAILABLE·시간 초과 등)는 던진다(없음으로 보지 않는다)
   */
  job(q: { requestId: string }): Promise<EventRefundJobProgress | undefined>;
}

/** core-svc 내부 판매 설정(GET /internal/v1/events/{eventId}/sale-config). 없으면 undefined, 실패는 던진다 */
export interface EventOwnerLookup {
  find(eventId: string): Promise<{ promoterId: string; startsAtMs: number; endsAtMs?: number } | undefined>;
}

// ---- BAT-420-rest GAT-110: core 회차 상태 반영(transfer-refund §5 'core 회차 상태 반영', R-T41) ----

/** core-svc POST /internal/v1/events/{eventId}/cancellation-status. 2xx가 아니거나 시간 초과·연결 실패면 던진다(4xx는 CoreEventStatusRejected) */
export interface CoreEventStatus {
  apply(q: { readonly eventId: string; readonly requestId: string; readonly kind: EventCancellationKind; readonly postponedTo?: Date }): Promise<void>;
}

/** core가 4xx로 답했다(계약 결함, 경고 대신 오류 로그, guidelines §8.1). 상태 코드만 싣는다 */
export class CoreEventStatusRejected extends Error {
  constructor(readonly status: number) {
    super(`core-svc가 회차 상태 반영을 받지 않았다(status ${status})`);
    this.name = 'CoreEventStatusRejected';
  }
}

/** 다시 하기 간격 1분 [가정], 한 번에 20건 [가정], 확정 뒤 SEV2까지 10분 [가정](transfer-refund §5) */
export const CORE_APPLY_RETRY_MS = 60_000;
export const CORE_APPLY_BATCH = 20;
export const CORE_APPLY_OVERDUE_MS = 600_000;

/** 반영을 다시 할 요청 한 건 */
export interface CoreApplyDue {
  readonly requestId: string;
  readonly eventId: string;
  readonly kind: EventCancellationKind;
  readonly newStartsAt?: Date;
}

/**
 * core 반영 표시(ops 0016 core_applied_at·core_apply_next_at·core_apply_overdue_at). 요청 행의 판(version)과 따로 쓴다(확정·진행률 저장과 겹치지 않게).
 * 대상은 Start까지 끝낸(refund_job_state 있음) APPROVED·RUNNING·PAUSED·REFUND_WINDOW·COMPLETED 요청이다
 */
export interface CoreApplyStore {
  /** core가 2xx로 답한 뒤에만 부른다. 이미 쓴 행은 그대로다 */
  markCoreApplied(requestId: string, nowMs: number): Promise<void>;
  /**
   * 반영하지 않았고 다음 볼 시각이 지난(또는 빈) 요청을 확정 시각 순으로 limit건 잡아 다음 볼 시각을 지금 + retryAfterMs로 미룬다(한 문장, FOR UPDATE SKIP LOCKED).
   * 파드 여럿이 함께 돌려도 한 요청은 한쪽만 잡는다
   */
  claimCoreApplies(nowMs: number, limit: number, retryAfterMs: number): Promise<readonly CoreApplyDue[]>;
  /** 확정 뒤 overdueAfterMs 이상(경계 포함) 지나도 반영하지 않은 요청에 core_apply_overdue_at을 쓰고 그 요청들을 돌려준다(요청마다 한 번) */
  markCoreApplyOverdue(nowMs: number, overdueAfterMs: number, limit: number): Promise<readonly { readonly requestId: string; readonly eventId: string }[]>;
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

/**
 * 걸기가 purchase-svc에서 ALREADY_EXISTS(그 회차에 다른 요청 ID의 열린 미룸)로 끝났다(BAT-420 몫 D 보충 2, transfer-refund §5 '미룸 걸기').
 * 부른 쪽은 진행 중 요청을 다시 보아 있으면 409, 없으면 503과 경고 event-refund-hold-conflict다. 어댑터가 다른 실패와 갈라 던진다
 */
export class EventRefundHoldConflict extends Error {
  constructor(message = '그 회차에 다른 요청의 미룸이 걸려 있다') {
    super(message);
    this.name = 'EventRefundHoldConflict';
  }
}

/**
 * 웨이브 끝 리뷰 S2(authz-matrix §5.3 'ops-svc 구현'): 파트너 경로 전용 저장소. 파트너 DB 풀(ops_partner 역할)에서 트랜잭션 첫 문장으로
 * set_config('app.tenant_id', 테넌트, true)를 걸고 쓴다(행 보안이 다른 파트너 행을 막는다). 감사·CS 건은 정의자 함수로 같은 트랜잭션에 남긴다.
 * 파트너 경로(requestByPartner·partnerStatus)는 관제 저장소(EventCancellationStore)를 부르지 않고 이 포트만 쓴다
 */
export interface PartnerEventCancellationStore {
  /**
   * 행·감사(·cs가 있으면 CS '판정 대기' 건)를 한 트랜잭션에 넣는다. 결과는 관제 저장소의 insert와 같다(INSERTED·REPLAYED·ACTIVE).
   * 돌려주지 않는 대역은 INSERTED로 본다. 진행 중 요청이 그 테넌트에 보이지 않는 옛 행이면 ACTIVE의 requestId가 빈 글이다
   */
  insertAsTenant(
    tenantId: string,
    record: EventCancellationRecord,
    audit: AuditRecord,
    idem?: EventCancellationIdempotency,
    cs?: { readonly nowMs: number },
  ): Promise<EventCancellationInsert | void>;
  latestForEventAsTenant(tenantId: string, eventId: string): Promise<EventCancellationRecord | undefined>;
  /** 그 테넌트에 보이는 그 회차의 진행 중 요청(미룸을 걸기 전 확인). 없는 대역은 넣기의 진행 중 확인만 쓴다 */
  activeForEventAsTenant?(tenantId: string, eventId: string): Promise<EventCancellationRecord | undefined>;
  /** 같은 멱등 키의 처음 응답(미룸을 걸기 전 확인). 다른 지문이면 422를 던진다. 없는 대역은 넣기의 멱등 규칙만 쓴다 */
  replayOfAsTenant?(tenantId: string, idem: EventCancellationIdempotency): Promise<EventCancellationView | undefined>;
}

export const EVENT_CANCELLATION_STORE = Symbol.for('peaket.ops.event-cancellation-store');
export const EVENT_REFUND_STARTER = Symbol.for('peaket.ops.event-refund-starter');
