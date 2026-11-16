// 회차 취소 요청·판정·2인 확정(BAT-425 GAT-130 잔여, FR-055, POL-038, ADR-0046, openapi EventCancellationRequest).
// commander가 요청하고, commander가 귀책을 판정한 뒤 판정자가 아닌 operator·commander가 확정한다.
export type EventCancellationKind = 'CANCEL' | 'POSTPONE';
export type EventCancellationStatus = 'REQUESTED' | 'JUDGED' | 'PENDING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'PAUSED' | 'REFUND_WINDOW' | 'COMPLETED' | 'REJECTED';
export type EventCancellationFault = 'ORGANIZER' | 'FORCE_MAJEURE' | 'CONTENT_CHANGE';
export type EventCancellationPg = 'TOSS' | 'PORTONE' | 'SIMULATOR';

/** 요청이 들어온 길(BAT-420 GAT-110, transfer-refund §5 '요청 두 길') */
export type EventCancellationVia = 'PARTNER' | 'COMMANDER';

/** 판정 때 purchase-svc PreviewEventRefund로 계산한 미리보기(주문 단위, transfer-refund §5 '판정·미리보기·확정의 차례') */
export interface EventCancellationDryRun {
  readonly targetOrders: number;
  readonly refundTotal: number;
  readonly compensationTargets: number;
  readonly compensationTotal: number;
  readonly perPg: readonly { readonly pg: EventCancellationPg; readonly orders: number; readonly estimatedSeconds: number }[];
}

/** 관제 상세의 일괄 환불 진행률. 읽기가 실패하면 state만 싣는다 */
export interface EventCancellationProgress {
  readonly state: string;
  readonly total?: number;
  readonly done?: number;
  readonly failed?: number;
  readonly perPg?: readonly { readonly pg: EventCancellationPg; readonly state: string; readonly pauseReason?: string | null; readonly done: number; readonly failed: number; readonly unknown: number }[];
}

/** 파트너 사유 상한 1,000자 [가정] */
export const PARTNER_REASON_MAX = 1_000;
/** 증빙 참조 상한 200자 [가정] */
export const EVIDENCE_REF_MAX = 200;
/** 판매 설정에 끝 시각이 없으면 공연 시작 + 24시간 [가정] */
export const EVENT_END_FALLBACK_MS = 86_400_000;

export class EventCancellationProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
    /** Problem 확장 칸(예: event-cancellation-active의 requestId) */
    readonly extensions?: Readonly<Record<string, unknown>>,
  ) {
    super(title);
    this.name = 'EventCancellationProblem';
  }
}

export interface EventCancellationRecord {
  requestId: string;
  eventId: string;
  kind: EventCancellationKind;
  status: EventCancellationStatus;
  reason: string;
  requestedBy: string;
  requestedAt: Date;
  fault: EventCancellationFault | null;
  judgementReason: string | null;
  fanNoticeReason: string | null;
  judgedBy: string | null;
  judgedAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  refundJobState: string | null;
  version: number;
  updatedAt: Date;
  // BAT-420(ops 0013): 아래 칸은 마이그레이션 0013이 더한다. 0013 전에 만든 기록(시험 씨앗 포함)과 맞추려고 선택 칸으로 두고,
  // 비어 있으면 COMMANDER·null로 읽는다(DB 기본값과 같다).
  requestedVia?: EventCancellationVia;
  promoterId?: string | null;
  faultOpinion?: EventCancellationFault | null;
  evidenceRef?: string | null;
  newStartsAt?: Date | null;
  dryRun?: EventCancellationDryRun | null;
  rejectionReason?: string | null;
}

/** 파트너가 보는 상태(openapi PartnerEventCancellationStatus). 미리보기·결제사별 몫·판정자·내부 판정 사유는 없다 */
export interface PartnerEventCancellationStatusView {
  requestId: string;
  eventId: string;
  kind: EventCancellationKind;
  status: EventCancellationStatus;
  requestedAt: string;
  reason: string | null;
  evidenceRef: string | null;
  faultOpinion: EventCancellationFault | null;
  newStartsAt: string | null;
  judgementDueAt: string | null;
  fault: EventCancellationFault | null;
  judgementSummary: string | null;
  rejectionReason: string | null;
  refundProgress: { total: number; done: number; failed: number } | null;
  pausedBy: 'AUTOMATIC' | 'OPERATOR' | null;
  postponement: { refundApplicationCount: number; refundDeadlineAt: string } | null;
  compensation?: { targetCount: number; totalAmount: number } | null;
}

export interface EventCancellationView {
  requestId: string;
  eventId: string;
  kind: EventCancellationKind;
  status: EventCancellationStatus;
  reason: string;
  fault?: EventCancellationFault;
  fanNoticeReason?: string;
  requestedAt: string;
  judgedBy?: string;
  dryRun?: EventCancellationDryRun;
  progress?: EventCancellationProgress;
}

export const eventCancellationView = (r: EventCancellationRecord): EventCancellationView => ({
  requestId: r.requestId,
  eventId: r.eventId,
  kind: r.kind,
  status: r.status,
  reason: r.reason,
  ...(r.fault !== null ? { fault: r.fault } : {}),
  ...(r.fanNoticeReason !== null ? { fanNoticeReason: r.fanNoticeReason } : {}),
  requestedAt: r.requestedAt.toISOString(),
  ...(r.judgedBy !== null ? { judgedBy: r.judgedBy } : {}),
  ...(r.refundJobState !== null ? { progress: { state: r.refundJobState } } : {}),
});

/** 판정·확정·반려 응답과 관제 상세: 목록 항목에 미리보기(dryRun)를 더한다. progress를 주면 그 값으로 바꾼다 */
export const eventCancellationDetailView = (r: EventCancellationRecord, progress?: EventCancellationProgress): EventCancellationView => {
  const base = eventCancellationView(r);
  return {
    ...base,
    ...(r.dryRun ? { dryRun: r.dryRun } : {}),
    ...(progress !== undefined ? { progress } : {}),
  };
};

/** 진행 중으로 보는 상태(같은 회차에 하나만, ops 0011 event_cancellation_request_active_key와 같다) */
export const ACTIVE_EVENT_CANCELLATION_STATUSES: readonly EventCancellationStatus[] = ['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW'];
