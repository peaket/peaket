// 회차 취소 요청·판정·2인 확정(BAT-425 GAT-130 잔여, BAT-420 GAT-110, FR-055, POL-038, ADR-0046·0280).
// 요청 두 길(transfer-refund §5 '요청 두 길'): 판매 중지된 회차의 commander 요청(재인증·멱등 키)과 파트너 관리자 요청(core 판매 설정의 소속).
// 판정(commander)은 JUDGED로 저장한 뒤 purchase-svc 미리보기를 dry_run에 써서 PENDING_APPROVAL로 둔다('판정·미리보기·확정의 차례').
// 확정은 PENDING_APPROVAL에서만, 판정자가 아닌 operator·commander가 재인증 뒤 한다. 외부 호출 전에 RUNNING으로 조건부 저장하고,
// 회차 취소(CANCEL)는 일괄 환불을 시작하기 전에 판매를 멈춘다(ADR-0280 결정 1). 멈춤·시작이 실패하면 PENDING_APPROVAL로 되돌린다.
// 모든 상태 변화는 ops 감사 체인에도 남긴다(transfer-refund §8, settlement §5.1).
// 회차 취소(CANCEL)는 요청 전에 purchase-svc에 환급 미룸을 걸고(지금 + 72시간), 판정·확정 시도 때 늘리며, 판정 전 반려 때 푼다(BAT-420 몫 D, OPEN[45],
// transfer-refund §5 '회차 취소 요청 중 보류 취소의 환급 미룸'). 걸거나 늘리지 못하면 503 event-refund-unavailable이고 상태를 바꾸지 않는다.
// 웨이브 끝 리뷰 K4: 확정 중 끊겨 RUNNING인데 purchase-svc에 일괄 환불이 없으면 approve가 같은 요청 ID로 다시 확정한다. 되돌리기 저장 실패는 오류 로그·지표다.
// 웨이브 끝 리뷰 S2(authz-matrix §5.3 'ops-svc 구현'): 파트너 경로는 파트너 저장소(파트너 DB 풀, 세션 테넌트로 행 보안)만 쓰고, commander 요청도 회차의 promoterId를 적는다.
// core 회차 상태 반영(BAT-420-rest GAT-110, R-T41, transfer-refund §5 'core 회차 상태 반영'): 확정이 Start까지 끝낸 뒤 core-svc를 한 번 부른다. 실패해도 확정은 그대로이고
// (경고 event-cancellation-core-apply-failed·지표, 4xx는 오류 로그) core_applied_at을 비운 채 두어 1분 [가정] 다시 하기(retryCoreApply)가 잇는다.
// 확정 뒤 10분 [가정]이 지나도 비어 있으면 SEV2 event-cancellation-core-apply-overdue를 요청마다 한 번 남긴다. 연기는 판매를 멈추지 않고 core 반영만 한다(ADR-0280 결정 1).
import { randomUUID } from 'node:crypto';
import type { IdempotencyRequest } from '@peaket/platform';
import type { AuditChain, AuditRecord } from '../../audit/audit.js';
import { addBusinessDays, weekendOnlyCalendar, type BusinessCalendar } from '../../cases/index.js';
import {
  EVENT_END_FALLBACK_MS,
  EVIDENCE_REF_MAX,
  EventCancellationProblem,
  PARTNER_REASON_MAX,
  eventCancellationDetailView,
  eventCancellationView,
  type EventCancellationFault,
  type EventCancellationKind,
  type EventCancellationPg,
  type EventCancellationProgress,
  type EventCancellationRecord,
  type EventCancellationStatus,
  type EventCancellationView,
  type PartnerEventCancellationStatusView,
} from '../domain/event-cancellation.js';
import {
  EVENT_REFUND_HOLD_MS,
  EventRefundHoldConflict,
  type EventCancellationCases,
  type EventCancellationStore,
  type EventOwnerLookup,
  type EventRefundJobProgress,
  type EventRefundReader,
  type EventRefundStarter,
  type EventSaleStopper,
  type SaleSuspensionLookup,
  type EventRefundHolds,
  type EventCancellationInsert,
  type PartnerEventCancellationStore,
  CORE_APPLY_BATCH,
  CORE_APPLY_OVERDUE_MS,
  CORE_APPLY_REJECTED_RETRY_MS,
  CORE_APPLY_RETRY_MS,
  type CoreApplyStore,
  type CoreEventStatus,
  CoreEventStatusRejected,
} from '../domain/ports.js';

const audit = (recordType: string, recordId: string, payload: Record<string, unknown>, nowMs: number): AuditRecord => ({ recordType, recordId, payload, nowMs });
/** 모든 회차 취소 감사에 싣는 원본 대조용 고정 값(사유·회차·종류·요청자) */
const eventBase = (r: EventCancellationRecord): Record<string, unknown> => ({ eventId: r.eventId, kind: r.kind, requestReason: r.reason, requestedBy: r.requestedBy });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAULTS: ReadonlySet<string> = new Set(['ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE']);
/** 관제 상세가 일괄 환불 진행률을 읽는 상태 */
const PROGRESS_STATUSES: ReadonlySet<EventCancellationStatus> = new Set(['RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED']);
/** 파트너 상태가 진행 합계를 싣는 상태(openapi PartnerEventCancellationStatus.refundProgress) */
const PARTNER_PROGRESS_STATUSES: ReadonlySet<EventCancellationStatus> = new Set(['RUNNING', 'PAUSED', 'COMPLETED']);
/** 확정 뒤 상태(반려할 수 없다) */
const APPROVED_STATUSES: ReadonlySet<EventCancellationStatus> = new Set(['APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED']);
/** 글자 수는 PostgreSQL char_length와 같게 코드 포인트로 센다 */
const lengthOf = (s: string): number => [...s].length;

export interface OpsActor {
  readonly accountId: string;
  readonly sessionId?: string;
  readonly role: string;
}

/** 재인증 토큰 검증기(payouts의 ApprovalReauthVerifier와 같은 모양). 없으면 요청·확정을 503으로 닫는다 */
export interface EventCancellationReauth {
  verify(token: string | undefined, o: { sessionId: string; act: 'APPROVAL' }): Promise<{ accountId: string; factors: string[] }>;
}

export interface EventCancellationRequestInput {
  readonly eventId: string;
  readonly kind?: EventCancellationKind;
  readonly reason: string;
}

/** 파트너 회차 취소·연기 요청 본문(openapi createPartnerEventCancellation, BAT-420) */
export interface PartnerEventCancellationInput {
  readonly kind: EventCancellationKind;
  readonly reason: string;
  readonly faultOpinion?: EventCancellationFault;
  readonly evidenceRef?: string;
  /** ISO 8601. POSTPONE은 필수, CANCEL은 보내면 400 */
  readonly newStartsAt?: string;
}

/** 파트너 요청자: 세션의 테넌트(authz-matrix §3.3) */
export type PartnerActor = OpsActor & { readonly tenantId: string };

/** BAT-420 GAT-110 선택 의존(없으면 그 경로를 503으로 닫는다, transfer-refund §5) */
export interface EventCancellationExtra {
  readonly suspension?: SaleSuspensionLookup;
  readonly stopper?: EventSaleStopper;
  readonly reader?: EventRefundReader;
  readonly owners?: EventOwnerLookup;
  readonly cases?: EventCancellationCases;
  /** 요청 전 미룸 걸기·판정·확정 때 늘리기·판정 전 반려 때 풀기(BAT-420 몫 D). 없으면 CANCEL 요청·판정·확정이 503이다 */
  readonly holds?: EventRefundHolds;
  /** 판정 대기 건을 못 연 것처럼 요청은 받되 남길 경고. error는 웨이브 끝 리뷰 K4의 되돌리기 실패(event-cancellation-revert-failed) */
  readonly log?: { warn(obj: object, msg: string): void; error?(obj: object, msg: string): void };
  /** 웨이브 끝 리뷰 K4: 지표 ops_event_cancellation_revert_failures_total(확정 실패 뒤 PENDING_APPROVAL 되돌리기 저장이 던질 때마다 하나) */
  readonly revertFailures?: { inc(): void };
  /** 웨이브 끝 리뷰 S2(빈 뼈대, 아직 쓰지 않는다): 파트너 경로(requestByPartner·partnerStatus)는 이 저장소만 쓴다 */
  readonly partnerStore?: PartnerEventCancellationStore;
  /** core 회차 상태 반영(BAT-420-rest GAT-110). 없으면 부르지 않는다(local·ci에 주소가 없을 때, 시작 경고) */
  readonly core?: CoreEventStatus;
  /** core 반영 표시(ops 0016). 없으면 성공을 적지 못하고 다시 하기도 하지 않는다 */
  readonly coreApplies?: CoreApplyStore;
  /** 지표 ops_event_cancellation_core_apply_failures_total(반영 실패마다 하나) */
  readonly coreApplyFailures?: { inc(): void };
  /** 영업일 달력(판정 기한 judgementDueAt = 요청 + 1영업일, F-06-2 ADR-0364 결정 2). 없으면 주말만 뺀다 */
  readonly calendar?: BusinessCalendar;
}

/** 다시 하기 한 바퀴의 결과 */
export interface CoreApplyRetryResult {
  readonly applied: number;
  readonly failed: number;
  readonly overdue: number;
}

const conflict = () => new EventCancellationProblem('event-cancellation-conflict', 409, '다른 사람이 먼저 처리했습니다');
const invalidBody = () => new EventCancellationProblem('invalid-body', 400, '요청 본문이 올바르지 않습니다');
const notFound = () => new EventCancellationProblem('not-found', 404, '찾을 수 없습니다');
const authzUnavailable = () => new EventCancellationProblem('authz-unavailable', 503, '권한을 확인하지 못했습니다');
const reauthRequired = () => new EventCancellationProblem('reauth-required', 403, '다시 인증해 주세요');
/** 진행 중 요청 409. 파트너에게 보이지 않는 옛 행(promoter_id 빔)이면 요청 ID를 싣지 않는다(웨이브 끝 리뷰 S2) */
const active = (requestId: string) =>
  requestId === ''
    ? new EventCancellationProblem('event-cancellation-active', 409, '이미 진행 중인 회차 취소 요청이 있습니다')
    : new EventCancellationProblem('event-cancellation-active', 409, '이미 진행 중인 회차 취소 요청이 있습니다', { requestId });
const refundUnavailable = () => new EventCancellationProblem('event-refund-unavailable', 503, '일괄 환불 실행기를 쓸 수 없습니다');
const saleStopUnavailable = () => new EventCancellationProblem('sale-stop-unavailable', 503, '판매를 멈추지 못해 확정하지 않았습니다');

export class EventCancellations {
  constructor(
    private readonly store: EventCancellationStore,
    private readonly refunds?: EventRefundStarter,
    private readonly now: () => number = Date.now,
    private readonly audit?: AuditChain,
    private readonly reauth?: EventCancellationReauth,
    private readonly extra: EventCancellationExtra = {},
  ) {}

  /**
   * commander 회차 취소 요청(R-T23 ⑤⑥, openapi createOpsEventCancellation). 차례: 본문 → 재인증 → 판매 중지 확인 → (멱등 키 →) 진행 중 확인 → 미룸 걸기 → 넣기 → 판정 대기 건.
   * 재인증·판매 중지 확인을 진행 중 확인보다 먼저 해, 판매 중지가 아닌 회차에 다른 사람의 요청 ID를 알려 주지 않는다.
   */
  async request(input: EventCancellationRequestInput, actor: OpsActor, reauthToken?: string, idem?: IdempotencyRequest): Promise<EventCancellationView> {
    if (!UUID.test(input.eventId)) throw new EventCancellationProblem('invalid-query', 400, '회차 ID가 올바르지 않습니다');
    if (input.reason.trim() === '') throw invalidBody();
    if (input.kind !== undefined && input.kind !== 'CANCEL') throw invalidBody();
    await this.#verifyReauth(actor, reauthToken);
    // 판매 중지 확인을 조립하지 않았으면 판매 중지임을 보일 수 없으므로 받지 않는다(시작 조립은 늘 넣는다, P4)
    if (!this.extra.suspension || !(await this.extra.suspension.isSuspended(input.eventId))) {
      throw new EventCancellationProblem('sale-not-suspended', 409, '판매 중지된 공연의 회차가 아닙니다');
    }
    // 파트너가 자기 회차에 걸린 commander 요청도 보도록 회차의 promoterId를 적는다(웨이브 끝 리뷰 S2, authz-matrix §5.3). 판매 설정을 못 읽으면 503이고 아무것도 쓰지 않는다
    const promoterId = await this.#commanderPromoter(input.eventId);
    const nowMs = this.now();
    const record = this.#newRecord({ eventId: input.eventId, kind: 'CANCEL', reason: input.reason, requestedBy: actor.accountId, requestedVia: 'COMMANDER', promoterId, faultOpinion: null, evidenceRef: null, newStartsAt: null }, nowMs);
    return this.#insert(record, nowMs, idem);
  }

  /**
   * 파트너 회차 취소·연기 요청(R-T36, openapi createPartnerEventCancellation). 소속은 세션 테넌트와 core 판매 설정의 promoterId로만 본다.
   * 차례: 본문 → 소속(없는 회차·다른 파트너는 같은 404, core 무응답 503) → 공연 종료 409 → 연기 일시 422 → (멱등 키 →) 진행 중 409 → (CANCEL이면) 미룸 걸기 → 넣기 → 판정 대기 건.
   */
  async requestByPartner(eventId: string, input: PartnerEventCancellationInput, actor: PartnerActor, idem: IdempotencyRequest): Promise<EventCancellationView> {
    if (!UUID.test(eventId)) throw notFound();
    const id = eventId.toLowerCase();
    const reasonLength = lengthOf(input.reason);
    if (input.reason.trim() === '' || reasonLength < 1 || reasonLength > PARTNER_REASON_MAX) throw invalidBody();
    if (input.evidenceRef !== undefined && (lengthOf(input.evidenceRef) < 1 || lengthOf(input.evidenceRef) > EVIDENCE_REF_MAX)) throw invalidBody();
    if (input.faultOpinion !== undefined && !FAULTS.has(input.faultOpinion)) throw invalidBody();
    if (input.kind !== 'CANCEL' && input.kind !== 'POSTPONE') throw invalidBody();
    if (input.kind === 'CANCEL' && input.newStartsAt !== undefined) throw invalidBody();
    const newStartsAtMs = input.newStartsAt === undefined ? undefined : Date.parse(input.newStartsAt);
    if (newStartsAtMs !== undefined && !Number.isFinite(newStartsAtMs)) throw invalidBody();
    const owner = await this.#ownedEvent(id, actor.tenantId);
    const nowMs = this.now();
    if (nowMs >= (owner.endsAtMs ?? owner.startsAtMs + EVENT_END_FALLBACK_MS)) throw new EventCancellationProblem('event-ended', 409, '공연이 끝난 회차입니다');
    if (input.kind === 'POSTPONE' && (newStartsAtMs === undefined || newStartsAtMs <= owner.startsAtMs)) {
      throw new EventCancellationProblem('postponement-date-invalid', 422, '연기 일시는 지금 공연 시작보다 늦어야 합니다');
    }
    const record = this.#newRecord(
      {
        eventId: id,
        kind: input.kind,
        reason: input.reason,
        requestedBy: actor.accountId,
        requestedVia: 'PARTNER',
        promoterId: actor.tenantId.toLowerCase(),
        faultOpinion: input.faultOpinion ?? null,
        evidenceRef: input.evidenceRef ?? null,
        newStartsAt: input.kind === 'POSTPONE' && newStartsAtMs !== undefined ? new Date(newStartsAtMs) : null,
      },
      nowMs,
    );
    // 파트너 저장소가 있으면 파트너 DB 풀·세션 테넌트로만 쓴다(행 보안이 두 번째로 막는다, 웨이브 끝 리뷰 S2)
    const partner = this.extra.partnerStore;
    if (partner) return this.#insertAsTenant(partner, actor.tenantId.toLowerCase(), record, nowMs, idem);
    return this.#insert(record, nowMs, idem);
  }

  /**
   * 파트너가 보는 그 회차의 가장 최근 요청 상태(R-T36 ⑧, openapi getPartnerEventCancellation).
   * 미리보기·결제사별 몫·판정자·내부 판정 사유는 싣지 않는다. 진행률을 읽지 못하면 그 칸만 null이다.
   */
  async partnerStatus(eventId: string, tenantId: string): Promise<PartnerEventCancellationStatusView> {
    if (!UUID.test(eventId)) throw notFound();
    const id = eventId.toLowerCase();
    await this.#ownedEvent(id, tenantId);
    const partner = this.extra.partnerStore;
    const r = partner ? await partner.latestForEventAsTenant(tenantId.toLowerCase(), id) : (await this.store.list({ eventId: id, limit: 1 }))[0];
    if (!r) throw notFound();
    const approved = APPROVED_STATUSES.has(r.status);
    const wantsProgress = PARTNER_PROGRESS_STATUSES.has(r.status);
    const wantsPostponement = r.kind === 'POSTPONE' && approved;
    const job = wantsProgress || wantsPostponement ? await this.#job(r.requestId) : undefined;
    return {
      requestId: r.requestId,
      eventId: r.eventId,
      kind: r.kind,
      status: r.status,
      requestedAt: r.requestedAt.toISOString(),
      // 판매 중지로 운영자가 직접 낸 요청의 사유는 내부 사유라 싣지 않는다
      reason: (r.requestedVia ?? 'COMMANDER') === 'PARTNER' ? r.reason : null,
      evidenceRef: r.evidenceRef ?? null,
      faultOpinion: r.faultOpinion ?? null,
      newStartsAt: r.newStartsAt ? r.newStartsAt.toISOString() : null,
      // 판정 기한은 REQUESTED일 때 요청 + 1영업일(CS 처리함과 같은 달력, F-06-2 ADR-0364 결정 2, R-T50 ⑤). 판정 뒤에는 null이다
      judgementDueAt: r.status === 'REQUESTED' ? new Date(this.#judgementDueMs(r.requestedAt.getTime())).toISOString() : null,
      fault: r.fault,
      judgementSummary: r.fanNoticeReason,
      rejectionReason: r.rejectionReason ?? null,
      refundProgress: wantsProgress && job ? { total: job.total, done: job.done, failed: job.failed } : null,
      pausedBy: r.status === 'PAUSED' && job ? pausedByOf(job) : null,
      postponement: wantsPostponement && job?.refundWindowClosesAt !== undefined ? { refundApplicationCount: job.appliedOrders ?? 0, refundDeadlineAt: job.refundWindowClosesAt } : null,
      // 배상 대상 수·합계는 판정 미리보기의 값이고 확정 뒤에만 보인다(개인 명단은 싣지 않는다, d5 §6.12 ④)
      compensation: approved && r.dryRun && r.dryRun.compensationTargets > 0 ? { targetCount: r.dryRun.compensationTargets, totalAmount: r.dryRun.compensationTotal } : null,
    };
  }

  async list(filter: { eventId?: string | undefined; status?: readonly EventCancellationStatus[] | undefined; limit: number }): Promise<{ items: EventCancellationView[]; nextCursor: null }> {
    return { items: (await this.store.list(filter)).map(eventCancellationView), nextCursor: null };
  }

  /** 관제 상세: 공연 제목과 미리보기, 진행 중·끝난 요청이면 결제사별 진행률(읽기 실패면 상태만) */
  async get(requestId: string): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    const title = await this.#eventTitle(r.eventId);
    if (!PROGRESS_STATUSES.has(r.status) || !this.extra.reader) return eventCancellationDetailView(r, undefined, title);
    const job = await this.#job(r.requestId);
    const progress: EventCancellationProgress = job
      ? { state: job.state, total: job.total, done: job.done, failed: job.failed, ...(job.accountPending !== undefined ? { accountPending: job.accountPending } : {}), perPg: job.perPg.map((p) => ({ pg: p.pg, state: p.state, ...(p.pauseReason !== undefined ? { pauseReason: p.pauseReason } : {}), done: p.done, failed: p.failed, unknown: p.unknown })) }
      : { state: r.refundJobState ?? r.status };
    return eventCancellationDetailView(r, progress, title);
  }

  /** 판정 기한: 요청 시각 + 1영업일(같은 KST 시각) */
  #judgementDueMs(requestedAtMs: number): number {
    return addBusinessDays(this.extra.calendar ?? weekendOnlyCalendar, requestedAtMs, 1);
  }

  /** 관제 상세가 보일 공연 제목(core 판매 설정 사본). 소속 확인을 조립하지 않았거나 읽기 실패면 undefined(제목 칸만 빈다) */
  async #eventTitle(eventId: string): Promise<string | undefined> {
    if (!this.extra.owners) return undefined;
    try {
      return (await this.extra.owners.find(eventId))?.title;
    } catch {
      return undefined;
    }
  }

  /**
   * 귀책 판정(R-T37 ①②). REQUESTED·JUDGED·PENDING_APPROVAL에서 할 수 있고 그때마다 미리보기를 새로 계산한다.
   * (CANCEL이면) 미룸 늘리기 → JUDGED 저장(미리보기 지움) → 미리보기 → PENDING_APPROVAL 저장. 늘리지 못하면 아무것도 저장하지 않고 503,
   * 미리보기를 못 하면 JUDGED에 남고 503이다.
   */
  async judge(requestId: string, input: { fault: EventCancellationFault; reason: string; fanNoticeReason: string }, actor: OpsActor): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    if (r.status !== 'REQUESTED' && r.status !== 'JUDGED' && r.status !== 'PENDING_APPROVAL') throw new EventCancellationProblem('judgement-not-allowed', 409, '지금은 판정할 수 없습니다');
    if (input.fanNoticeReason.length > 200) throw invalidBody();
    const nowMs = this.now();
    if (r.kind === 'CANCEL') await this.#extendHold(r, nowMs);
    const judged: EventCancellationRecord = {
      ...r,
      status: 'JUDGED',
      fault: input.fault,
      judgementReason: input.reason,
      fanNoticeReason: input.fanNoticeReason,
      judgedBy: actor.accountId,
      judgedAt: new Date(nowMs),
      dryRun: null,
      version: r.version + 1,
      updatedAt: new Date(nowMs),
    };
    const judgedAudit = audit('EVENT_CANCELLATION_JUDGED', judged.requestId, { ...eventBase(judged), status: judged.status, fault: judged.fault, reason: judged.judgementReason, fanNoticeReason: judged.fanNoticeReason }, nowMs);
    if (!(await this.store.save(judged, judgedAudit))) throw conflict();
    if (!this.extra.reader) throw refundUnavailable();
    const dryRun = await this.extra.reader.preview({ eventId: judged.eventId, requestId: judged.requestId, fault: input.fault }).catch(() => {
      throw new EventCancellationProblem('event-refund-unavailable', 503, '미리보기를 계산하지 못했습니다(판정은 저장됨)');
    });
    const previewMs = this.now();
    const pending: EventCancellationRecord = { ...judged, status: 'PENDING_APPROVAL', dryRun, version: judged.version + 1, updatedAt: new Date(previewMs) };
    if (!(await this.store.save(pending, audit('EVENT_CANCELLATION_PREVIEWED', pending.requestId, { ...eventBase(pending), status: pending.status, fault: pending.fault, dryRun }, previewMs)))) throw conflict();
    return eventCancellationDetailView(pending);
  }

  /**
   * 확정(R-T37 ②④, R-T23 ⑥). PENDING_APPROVAL에서만, 판정자 외 1인이 재인증 뒤 한다.
   * (CANCEL이면) 미룸 늘리기 → RUNNING 조건부 저장 → (CANCEL이면) 판매 멈춤 → 일괄 환불 시작. 늘리지 못하면 PENDING_APPROVAL 그대로 503,
   * 멈춤·시작이 실패하면 PENDING_APPROVAL로 되돌린다(미리보기는 남는다). 확정은 purchase-svc가 요청 행과 같은 트랜잭션에서 미룸을 푼다.
   */
  async approve(requestId: string, actor: OpsActor, reauthToken?: string): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    // RUNNING 고착(웨이브 끝 리뷰 K4, transfer-refund §5 '판정·미리보기·확정의 차례' 예외): RUNNING을 저장한 뒤 바깥 호출 도중 끊겨
    // purchase-svc에 그 요청 ID의 일괄 환불이 없으면 같은 요청 ID로 미룸 늘리기·판매 멈춤·Start를 다시 부른다(셋 다 멱등)
    const stuck = r.status === 'RUNNING';
    if (!stuck) {
      if (r.status === 'JUDGED' || (r.status === 'PENDING_APPROVAL' && !r.dryRun)) throw new EventCancellationProblem('preview-required', 409, '미리보기 없이는 확정할 수 없습니다');
      if (r.status !== 'PENDING_APPROVAL') throw new EventCancellationProblem('judgement-required', 409, '판정 전에는 확정할 수 없습니다');
    }
    if (r.judgedBy === actor.accountId) throw new EventCancellationProblem('approver-ineligible', 403, '판정자는 확정할 수 없습니다');
    // 계약(openapi /v1/ops/event-cancellations/{requestId}/approvals)은 재인증 토큰을 요구한다(SEC-02).
    await this.#verifyReauth(actor, reauthToken);
    if (!this.refunds) throw refundUnavailable();
    const stopper = this.extra.stopper;
    if (r.kind === 'CANCEL' && !stopper) throw saleStopUnavailable();
    if (r.fault === null) throw new EventCancellationProblem('judgement-required', 409, '판정 전에는 확정할 수 없습니다');
    // 다시 확정은 purchase-svc에 일괄 환불이 없을 때만이다. 있으면 409(중복 시작 막기), 읽기가 실패하면 없음으로 보지 않고 503이다(바깥 호출 없음)
    if (stuck) await this.#requireMissingJob(r);
    const nowMs = this.now();
    // 판정이 끝나기 전(확정 시작 전)까지 보류 취소의 환급 미룸이 풀리지 않게 기한을 늘린다(BAT-420 몫 D, GAT-110 D2)
    if (r.kind === 'CANCEL') await this.#extendHold(r, nowMs);
    // 외부 호출 전에 RUNNING으로 조건부 저장해, 확정 중복과 외부 실패 뒤 재시도를 함께 다룬다(OPS-07). 다시 확정도 판 번호 조건부 저장이라 겹친 다시 확정은 하나만 이어 간다
    const running: EventCancellationRecord = { ...r, status: 'RUNNING', approvedBy: actor.accountId, approvedAt: new Date(nowMs), version: r.version + 1, updatedAt: new Date(nowMs) };
    const approvedAudit = audit('EVENT_CANCELLATION_APPROVED', running.requestId, { ...eventBase(running), status: running.status, fault: running.fault, ...(stuck ? { reapproval: true } : {}) }, nowMs);
    if (!(await this.store.save(running, approvedAudit))) throw conflict();
    if (r.kind === 'CANCEL' && stopper) {
      try {
        // 판매 중지 집행의 명령 ID·중지 참조는 요청 ID다. 다시 확정하면 같은 ID로 다시 부른다(받는 쪽 멱등, ADR-0280 결정 1)
        await stopper.stop({ eventId: running.eventId, requestId: running.requestId });
      } catch (err) {
        await this.#backToPendingApproval(running, 'sale-stop-unavailable', err);
        throw saleStopUnavailable();
      }
    }
    try {
      const job = await this.refunds.start({
        eventId: running.eventId,
        requestId: running.requestId,
        fault: r.fault,
        ruledBy: running.judgedBy ?? '',
        confirmedBy: actor.accountId,
        kind: running.kind,
        ...(running.fanNoticeReason !== null ? { fanNoticeReason: running.fanNoticeReason } : {}),
        ...(running.kind === 'POSTPONE' && running.newStartsAt ? { postponedToMs: running.newStartsAt.getTime() } : {}),
        // 판정 때 저장한 미리보기의 주문별 배상 금액을 그대로 보낸다(확정은 다시 계산하지 않는다, BAT-425 RV-02)
        ...(running.dryRun?.compensationOrders !== undefined ? { compensationOrders: running.dryRun.compensationOrders } : {}),
      });
      const status = job.state === 'COMPLETED' ? 'COMPLETED' : job.state === 'REFUND_WINDOW' ? 'REFUND_WINDOW' : 'RUNNING';
      const doneMs = this.now();
      const next: EventCancellationRecord = { ...running, status, refundJobState: job.state, version: running.version + 1, updatedAt: new Date(doneMs) };
      if (!(await this.store.save(next, audit('EVENT_CANCELLATION_STARTED', next.requestId, { ...eventBase(next), status: next.status, jobState: job.state }, doneMs)))) throw conflict();
      // Start까지 끝났다: core 회차 상태를 반영한다. 실패는 확정을 되돌리지 않는다(던지지 않는다, 다시 하기가 잇는다)
      await this.#applyCore({ requestId: next.requestId, eventId: next.eventId, kind: next.kind, ...(next.newStartsAt ? { newStartsAt: next.newStartsAt } : {}) }, this.now());
      return eventCancellationDetailView(next);
    } catch (err) {
      // 외부 호출이 실패하면 다시 확정할 수 있게 PENDING_APPROVAL로 되돌린다(외부 시작은 요청 ID 멱등에 기댄다).
      await this.#backToPendingApproval(running, 'event-refund-start-failed', err);
      throw err;
    }
  }

  /**
   * core 반영 다시 하기 한 바퀴(1분 [가정]마다 시작 조립이 부른다, R-T41 ③): 반영하지 않은 요청을 20건 [가정]까지 잡아 다시 부르고, 성공하면 core_applied_at을 쓴다.
   * 그 뒤 확정 뒤 10분 [가정]이 지나도 비어 있는 요청마다 SEV2 로그를 한 번 남긴다. 던지지 않는다(저장소 실패는 경고 뒤 다음 바퀴)
   */
  async retryCoreApply(nowMs: number = this.now()): Promise<CoreApplyRetryResult> {
    const { core, coreApplies } = this.extra;
    if (!core || !coreApplies) return { applied: 0, failed: 0, overdue: 0 };
    let applied = 0;
    let failed = 0;
    let due: Awaited<ReturnType<CoreApplyStore['claimCoreApplies']>> = [];
    try {
      due = await coreApplies.claimCoreApplies(nowMs, CORE_APPLY_BATCH, CORE_APPLY_RETRY_MS);
    } catch (err) {
      this.extra.log?.warn({ event: 'event-cancellation-core-apply-claim-failed', err: err instanceof Error ? err.name : 'unknown' }, 'event-cancellation-core-apply-claim-failed: 다시 할 core 반영을 읽지 못했다(다음 바퀴)');
    }
    for (const d of due) {
      if (await this.#applyCore(d, nowMs)) applied++;
      else failed++;
    }
    let overdue: Awaited<ReturnType<CoreApplyStore['markCoreApplyOverdue']>> = [];
    try {
      overdue = await coreApplies.markCoreApplyOverdue(this.now(), CORE_APPLY_OVERDUE_MS, 100);
    } catch (err) {
      this.extra.log?.warn({ event: 'event-cancellation-core-apply-claim-failed', err: err instanceof Error ? err.name : 'unknown' }, 'event-cancellation-core-apply-claim-failed: 늦은 core 반영을 표시하지 못했다(다음 바퀴)');
    }
    for (const o of overdue) {
      this.extra.log?.error?.(
        { event: 'event-cancellation-core-apply-overdue', severity: 'SEV2', requestId: o.requestId, eventId: o.eventId },
        'event-cancellation-core-apply-overdue: 확정 뒤 10분이 지나도 core 회차 상태를 반영하지 못했다(SEV2)',
      );
    }
    return { applied, failed, overdue: overdue.length };
  }

  /**
   * core 반영 한 번. 성공하면 core_applied_at을 쓰고(같은 회차의 앞 요청은 대체 표시) true. 실패는 경고(4xx는 오류)·지표 뒤 false다. 던지지 않는다.
   * 4xx(401 제외, 계약 결함)는 다음 볼 시각을 지금 + 10분 [가정]으로 미뤄 늘 거절되는 요청이 새 요청의 자리를 막지 않게 한다(RV-06). 5xx·무응답·401은 잡기의 1분 그대로다
   */
  async #applyCore(r: { readonly requestId: string; readonly eventId: string; readonly kind: EventCancellationKind; readonly newStartsAt?: Date }, nowMs: number): Promise<boolean> {
    const core = this.extra.core;
    if (!core) return false;
    try {
      await core.apply({ eventId: r.eventId, requestId: r.requestId, kind: r.kind, ...(r.kind === 'POSTPONE' && r.newStartsAt ? { postponedTo: r.newStartsAt } : {}) });
    } catch (err) {
      const fields = { event: 'event-cancellation-core-apply-failed', requestId: r.requestId };
      const msg = 'event-cancellation-core-apply-failed: core 회차 상태 반영이 실패했다(확정은 그대로, 다시 하기가 잇는다)';
      if (err instanceof CoreEventStatusRejected && this.extra.log?.error) this.extra.log.error({ ...fields, status: err.status }, msg);
      else this.extra.log?.warn(fields, msg);
      this.extra.coreApplyFailures?.inc();
      if (err instanceof CoreEventStatusRejected && err.status !== 401) {
        try {
          await this.extra.coreApplies?.deferCoreApply(r.requestId, nowMs + CORE_APPLY_REJECTED_RETRY_MS);
        } catch {
          // 미루기를 못 써도 잡기의 1분 뒤 다시 본다
        }
      }
      return false;
    }
    try {
      await this.extra.coreApplies?.markCoreApplied(r.requestId, this.now());
    } catch (err) {
      // core는 반영했고 표시만 못 썼다. 다음 바퀴가 다시 부르고 core가 멱등이라 바뀐 것이 없다
      this.extra.log?.warn({ event: 'event-cancellation-core-apply-mark-failed', requestId: r.requestId, err: err instanceof Error ? err.name : 'unknown' }, 'event-cancellation-core-apply-mark-failed: core 반영 표시를 쓰지 못했다');
    }
    return true;
  }

  /**
   * 반려(R-T37 ③). 판정 전(REQUESTED)은 commander만 하고 REJECTED·반려 사유를 남긴다.
   * 판정 뒤(JUDGED·PENDING_APPROVAL)는 판정자 외 operator 이상이 하고 JUDGED(재판정 대기, T7)로 돌려 미리보기를 지운다.
   * 판정 전 반려(CANCEL)는 판정이 끝났으므로 미룸을 푼다(실패는 경고만, 기한에 저절로 풀린다). 판정 뒤 반려는 판정이 끝나지 않아 풀지 않는다(R-T38 ②).
   */
  async reject(requestId: string, actor: OpsActor, reason: string): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    if (APPROVED_STATUSES.has(r.status)) throw new EventCancellationProblem('already-approved', 409, '이미 확정된 요청입니다');
    if (r.status === 'REJECTED') throw conflict();
    const nowMs = this.now();
    const now = new Date(nowMs);
    let next: EventCancellationRecord;
    if (r.status === 'REQUESTED') {
      if (actor.role !== 'commander') throw new EventCancellationProblem('rejection-not-allowed', 403, '판정 전 반려는 commander만 할 수 있습니다');
      next = { ...r, status: 'REJECTED', rejectionReason: reason, version: r.version + 1, updatedAt: now };
    } else {
      if (r.judgedBy === actor.accountId) throw new EventCancellationProblem('approver-ineligible', 403, '판정자는 반려할 수 없습니다');
      next = { ...r, status: 'JUDGED', dryRun: null, version: r.version + 1, updatedAt: now };
    }
    if (!(await this.store.save(next, audit('EVENT_CANCELLATION_REJECTED', next.requestId, { ...eventBase(next), status: next.status, reason }, nowMs)))) throw conflict();
    if (next.status === 'REJECTED' && next.kind === 'CANCEL') await this.#releaseHold(next);
    return eventCancellationDetailView(next);
  }

  async pause(requestId: string, actor: OpsActor, input: { pg?: EventCancellationPg; reason: string }): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    if (r.status !== 'RUNNING' && r.status !== 'PAUSED') throw new EventCancellationProblem('not-running', 409, '진행 중인 요청이 아닙니다');
    if (!this.refunds) throw refundUnavailable();
    const job = await this.refunds.pause({ requestId, ...(input.pg ? { pg: input.pg } : {}), reason: input.reason });
    const nowMs = this.now();
    const next: EventCancellationRecord = { ...r, status: 'PAUSED', refundJobState: job.state, version: r.version + 1, updatedAt: new Date(nowMs) };
    await this.store.save(
      next,
      audit('EVENT_CANCELLATION_PAUSED', next.requestId, { ...eventBase(next), status: next.status, pg: input.pg ?? 'ALL', reason: input.reason, refundJobState: next.refundJobState }, nowMs),
    );
    return eventCancellationView(next);
  }

  async resume(requestId: string, actor: OpsActor, input: { pg?: EventCancellationPg; reason: string }): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    if (r.status !== 'PAUSED' && r.status !== 'RUNNING') throw new EventCancellationProblem('not-running', 409, '멈춘 요청이 아닙니다');
    if (!this.refunds) throw refundUnavailable();
    const job = await this.refunds.resume({ requestId, ...(input.pg ? { pg: input.pg } : {}), reason: input.reason });
    const nowMs = this.now();
    const next: EventCancellationRecord = { ...r, status: 'RUNNING', refundJobState: job.state, version: r.version + 1, updatedAt: new Date(nowMs) };
    await this.store.save(
      next,
      audit('EVENT_CANCELLATION_RESUMED', next.requestId, { ...eventBase(next), status: next.status, pg: input.pg ?? 'ALL', reason: input.reason, refundJobState: next.refundJobState }, nowMs),
    );
    return eventCancellationView(next);
  }

  async #find(requestId: string): Promise<EventCancellationRecord> {
    const r = await this.store.find(requestId);
    if (!r) throw notFound();
    return r;
  }

  /** 재인증: 검증기가 없으면 503, 토큰의 계정이 요청자와 다르거나 패스키를 거치지 않았으면 403(act APPROVAL, 요청자 세션) */
  async #verifyReauth(actor: OpsActor, token: string | undefined): Promise<void> {
    if (!this.reauth) throw new EventCancellationProblem('reauth-unavailable', 503, '재인증 검증기를 조립하지 못했습니다(identity JWKS URL 없음)');
    const verified = await this.reauth.verify(token, { sessionId: actor.sessionId ?? '', act: 'APPROVAL' });
    if (verified.accountId !== actor.accountId || !verified.factors.includes('passkey')) throw reauthRequired();
  }

  /** core 판매 설정으로 소속을 본다. 없는 회차·다른 파트너 회차는 같은 404, 조립·응답이 없으면 503 */
  async #ownedEvent(eventId: string, tenantId: string): Promise<{ promoterId: string; startsAtMs: number; endsAtMs?: number }> {
    if (!tenantId || !UUID.test(tenantId) || !this.extra.owners) throw authzUnavailable();
    const owner = await this.extra.owners.find(eventId).catch(() => {
      throw authzUnavailable();
    });
    if (!owner || owner.promoterId.toLowerCase() !== tenantId.toLowerCase()) throw notFound();
    return owner;
  }

  /**
   * commander 요청에 적을 회차의 테넌트(core 판매 설정의 promoterId, 웨이브 끝 리뷰 S2). 판매 설정 읽기가 실패하면 503 authz-unavailable이다.
   * 소속 확인을 조립하지 않았거나 판매 설정이 없으면(core 404) 비운다(그 파트너가 보지 못하는 행으로 남는다)
   */
  async #commanderPromoter(eventId: string): Promise<string | null> {
    if (!this.extra.owners) return null;
    const owner = await this.extra.owners.find(eventId).catch(() => {
      throw authzUnavailable();
    });
    return owner ? owner.promoterId.toLowerCase() : null;
  }

  #newRecord(
    o: Pick<EventCancellationRecord, 'eventId' | 'kind' | 'reason' | 'requestedBy'> & Required<Pick<EventCancellationRecord, 'requestedVia' | 'promoterId' | 'faultOpinion' | 'evidenceRef' | 'newStartsAt'>>,
    nowMs: number,
  ): EventCancellationRecord {
    const now = new Date(nowMs);
    return {
      requestId: randomUUID(),
      eventId: o.eventId,
      kind: o.kind,
      status: 'REQUESTED',
      reason: o.reason,
      requestedBy: o.requestedBy,
      requestedAt: now,
      fault: null,
      judgementReason: null,
      fanNoticeReason: null,
      judgedBy: null,
      judgedAt: null,
      approvedBy: null,
      approvedAt: null,
      refundJobState: null,
      version: 1,
      updatedAt: now,
      requestedVia: o.requestedVia,
      promoterId: o.promoterId,
      faultOpinion: o.faultOpinion,
      evidenceRef: o.evidenceRef,
      newStartsAt: o.newStartsAt,
      dryRun: null,
      rejectionReason: null,
    };
  }

  /**
   * 멱등 키와 함께 넣고, 새로 넣었으면 CS 처리함 '판정 대기' 건을 연다(실패해도 요청은 접수된다).
   * 회차 취소(CANCEL)는 넣기 전에 미룸을 건다(BAT-420 몫 D 보충 2 ①): 같은 키의 처음 응답이 있으면 그것을 주고(걸지 않음), 진행 중 요청이 있으면 걸지 않고 409,
   * 없으면 새 요청 ID로 지금 + 72시간까지 건다. 걸기가 ALREADY_EXISTS면 진행 중 요청을 다시 보아 있으면 409, 없으면 경고와 503이다.
   * 걸기가 그 밖으로 실패하면 503이고 행·감사·CS 건·멱등 기록을 남기지 않는다. 건 뒤 넣기가 진행 중(유일 색인)·다시 온 요청·오류로 끝나면 자기 요청 ID로 푼다
   */
  async #insert(record: EventCancellationRecord, nowMs: number, idem?: IdempotencyRequest): Promise<EventCancellationView> {
    const requested = audit(
      'EVENT_CANCELLATION_REQUESTED',
      record.requestId,
      { ...eventBase(record), reason: record.reason, status: record.status, requestedVia: record.requestedVia, ...(record.promoterId ? { promoterId: record.promoterId } : {}) },
      nowMs,
    );
    const holding = record.kind === 'CANCEL';
    if (holding) {
      if (idem && this.store.replayOf) {
        const replay = await this.store.replayOf(idem);
        if (replay) return replay;
      }
      const existing = await this.store.findActiveByEvent(record.eventId);
      if (existing) throw active(existing.requestId);
      await this.#placeHold(record, nowMs, (eventId) => this.store.findActiveByEvent(eventId));
    }
    let result: Awaited<ReturnType<EventCancellationStore['insert']>>;
    try {
      result = await this.store.insert(record, requested, idem);
    } catch (err) {
      if (holding) await this.#releaseHold(record);
      throw err;
    }
    if (holding && result.status !== 'INSERTED') await this.#releaseHold(record);
    if (result.status === 'REPLAYED') return result.view;
    if (result.status === 'ACTIVE') throw active(result.requestId);
    if (this.extra.cases) {
      try {
        await this.extra.cases.judgementPending(record.requestId, nowMs);
      } catch (err) {
        this.extra.log?.warn({ requestId: record.requestId, err: err instanceof Error ? err.name : 'unknown' }, 'event-cancellation-judgement-case-failed');
      }
    }
    return eventCancellationView(record);
  }

  /**
   * 파트너 저장소로 넣기(웨이브 끝 리뷰 S2). 차례는 #insert와 같고, 확인·넣기·감사·CS '판정 대기' 건은 모두 파트너 저장소(파트너 DB 풀, 세션 테넌트)로 한다.
   * CS 건은 넣기와 같은 트랜잭션의 정의자 함수가 연다(관제 저장소·관제 CS 저장소를 부르지 않는다)
   */
  async #insertAsTenant(p: PartnerEventCancellationStore, tenantId: string, record: EventCancellationRecord, nowMs: number, idem?: IdempotencyRequest): Promise<EventCancellationView> {
    const requested = audit(
      'EVENT_CANCELLATION_REQUESTED',
      record.requestId,
      { ...eventBase(record), reason: record.reason, status: record.status, requestedVia: record.requestedVia, ...(record.promoterId ? { promoterId: record.promoterId } : {}) },
      nowMs,
    );
    const holding = record.kind === 'CANCEL';
    const findActive = p.activeForEventAsTenant ? (eventId: string) => p.activeForEventAsTenant!(tenantId, eventId) : undefined;
    if (holding) {
      if (idem && p.replayOfAsTenant) {
        const replay = await p.replayOfAsTenant(tenantId, idem);
        if (replay) return replay;
      }
      if (findActive) {
        const existing = await findActive(record.eventId);
        if (existing) throw active(existing.requestId);
      }
      await this.#placeHold(record, nowMs, findActive);
    }
    let result: EventCancellationInsert;
    try {
      // CS '판정 대기' 건의 기한(요청 + 1영업일)을 앱 달력으로 세어 정의자 함수에 넘긴다(SQL에는 달력이 없다)
      result = (await p.insertAsTenant(tenantId, record, requested, idem, { nowMs, resultDueMs: this.#judgementDueMs(record.requestedAt.getTime()) })) ?? { status: 'INSERTED' };
    } catch (err) {
      if (holding) await this.#releaseHold(record);
      throw err;
    }
    if (holding && result.status !== 'INSERTED') await this.#releaseHold(record);
    if (result.status === 'REPLAYED') return result.view;
    if (result.status === 'ACTIVE') throw active(result.requestId);
    return eventCancellationView(record);
  }

  /** 새 요청의 미룸 걸기(지금 + 72시간). 실패는 503(ALREADY_EXISTS면 진행 중 요청을 다시 본다, 다시 볼 길이 없으면 503) */
  async #placeHold(record: EventCancellationRecord, nowMs: number, findActive?: (eventId: string) => Promise<EventCancellationRecord | undefined>): Promise<void> {
    const holds = this.extra.holds;
    if (!holds) throw refundUnavailable();
    try {
      await holds.hold({ eventId: record.eventId, requestId: record.requestId, held: true, expiresAtMs: nowMs + EVENT_REFUND_HOLD_MS });
    } catch (err) {
      if (err instanceof EventRefundHoldConflict) {
        // 걸기와 진행 중 확인 사이에 다른 요청이 들어왔거나(그 요청을 알린다), 풀기를 놓친 옛 미룸이 기한 전이다(경고, 기한에 저절로 풀린다)
        const again = findActive ? await findActive(record.eventId) : undefined;
        if (again) throw active(again.requestId);
        this.extra.log?.warn({ eventId: record.eventId, requestId: record.requestId }, 'event-refund-hold-conflict: 진행 중 요청이 없는데 그 회차에 다른 요청의 환급 미룸이 걸려 있다');
      }
      throw refundUnavailable();
    }
  }

  /** 판정·확정 시도 때 같은 요청 ID로 기한을 그 시각 + 72시간으로 늘린다. 늘리지 못하면 503(부른 쪽은 아무것도 저장하지 않는다) */
  async #extendHold(r: EventCancellationRecord, nowMs: number): Promise<void> {
    const holds = this.extra.holds;
    if (!holds) throw refundUnavailable();
    try {
      await holds.hold({ eventId: r.eventId, requestId: r.requestId, held: true, expiresAtMs: nowMs + EVENT_REFUND_HOLD_MS });
    } catch {
      throw refundUnavailable();
    }
  }

  /** 같은 요청 ID로 미룸을 푼다. 실패는 경고만 남긴다(기한에 저절로 풀리고 purchase-svc가 SEV2를 남긴다) */
  async #releaseHold(r: EventCancellationRecord): Promise<void> {
    if (!this.extra.holds) return;
    try {
      await this.extra.holds.hold({ eventId: r.eventId, requestId: r.requestId, held: false });
    } catch (err) {
      this.extra.log?.warn({ eventId: r.eventId, requestId: r.requestId, err: err instanceof Error ? err.name : 'unknown' }, 'event-refund-hold-release-failed');
    }
  }

  /** 일괄 환불 진행률(읽기 실패·조립 없음은 undefined) */
  async #job(requestId: string): Promise<EventRefundJobProgress | undefined> {
    if (!this.extra.reader) return undefined;
    try {
      return await this.extra.reader.job({ requestId });
    } catch {
      return undefined;
    }
  }

  /** RUNNING 고착 다시 확정의 전제: purchase-svc에 그 요청 ID의 일괄 환불이 없다(웨이브 끝 리뷰 K4). 있으면 409 already-approved, 읽기 실패·조립 없음은 503 */
  async #requireMissingJob(r: EventCancellationRecord): Promise<void> {
    if (!this.extra.reader) throw refundUnavailable();
    let job: EventRefundJobProgress | undefined;
    try {
      job = await this.extra.reader.job({ requestId: r.requestId });
    } catch {
      throw new EventCancellationProblem('event-refund-unavailable', 503, '일괄 환불이 있는지 확인하지 못했습니다');
    }
    if (job) throw new EventCancellationProblem('already-approved', 409, '이미 확정된 요청입니다');
  }

  /**
   * 확정 실패 뒤 PENDING_APPROVAL로 되돌린다(다시 확정할 수 있게). 저장이 던지면 원래 오류를 가리지 않고 오류 로그 event-cancellation-revert-failed와
   * 지표 ops_event_cancellation_revert_failures_total을 남긴다(웨이브 끝 리뷰 K4: 그 요청은 RUNNING에 남고 approve의 다시 확정이 이어 간다).
   * 다른 요청이 먼저 바꿔 저장이 0행이면 경고만 남긴다
   */
  async #backToPendingApproval(running: EventCancellationRecord, error: string, err: unknown): Promise<void> {
    const backMs = this.now();
    const back: EventCancellationRecord = { ...running, status: 'PENDING_APPROVAL', approvedBy: null, approvedAt: null, version: running.version + 1, updatedAt: new Date(backMs) };
    let saved: boolean;
    try {
      saved = await this.store.save(back, audit('EVENT_CANCELLATION_APPROVAL_FAILED', back.requestId, { ...eventBase(back), status: back.status, error, cause: err instanceof Error ? err.name : 'unknown' }, backMs));
    } catch (revertErr) {
      const fields = { event: 'event-cancellation-revert-failed', requestId: running.requestId, error, err: revertErr instanceof Error ? revertErr.name : 'unknown' };
      const msg = 'event-cancellation-revert-failed: 확정 실패 뒤 PENDING_APPROVAL로 되돌리지 못했다(RUNNING에 남고, 일괄 환불이 없으면 다시 확정이 이어 간다)';
      if (this.extra.log?.error) this.extra.log.error(fields, msg);
      else this.extra.log?.warn(fields, msg);
      this.extra.revertFailures?.inc();
      return;
    }
    if (!saved) this.extra.log?.warn({ event: 'event-cancellation-revert-conflict', requestId: running.requestId, error }, 'event-cancellation-revert-conflict: 되돌리는 사이 다른 요청이 먼저 바꿨다');
  }
}

/** 멈춘 까닭의 종류: 결제사 몫 가운데 commander 수동 멈춤(MANUAL)이 있으면 OPERATOR, 그 밖은 AUTOMATIC([가정], openapi pausedBy) */
function pausedByOf(job: EventRefundJobProgress): 'AUTOMATIC' | 'OPERATOR' {
  return job.perPg.some((p) => p.pauseReason === 'MANUAL') ? 'OPERATOR' : 'AUTOMATIC';
}
