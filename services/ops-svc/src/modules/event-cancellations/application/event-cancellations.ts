// 회차 취소 요청·판정·2인 확정(BAT-425 GAT-130 잔여, FR-055, POL-038, ADR-0046).
// 요청(commander) → 판정(commander) → 판정자가 아닌 operator·commander의 확정 → purchase-svc 일괄 환불 시작.
// 확정은 외부 호출 전에 RUNNING으로 조건부 저장하고, 외부가 실패하면 JUDGED로 되돌려 다시 시도할 수 있게 한다.
// 모든 상태 변화는 ops 감사 체인에도 남긴다(transfer-refund §8, settlement §5.1).
import { randomUUID } from 'node:crypto';
import type { AuditChain } from '../../audit/audit.js';
import { EventCancellationProblem, eventCancellationView, type EventCancellationFault, type EventCancellationKind, type EventCancellationPg, type EventCancellationRecord, type EventCancellationStatus, type EventCancellationView } from '../domain/event-cancellation.js';
import type { EventCancellationStore, EventRefundStarter } from '../domain/ports.js';

export interface OpsActor {
  readonly accountId: string;
  readonly sessionId?: string;
  readonly role: string;
}

/** 재인증 토큰 검증기(payouts의 ApprovalReauthVerifier와 같은 모양). 없으면 확정을 503으로 닫는다 */
export interface EventCancellationReauth {
  verify(token: string | undefined, o: { sessionId: string; act: 'APPROVAL' }): Promise<{ accountId: string; factors: string[] }>;
}

export interface EventCancellationRequestInput {
  readonly eventId: string;
  readonly kind?: EventCancellationKind;
  readonly reason: string;
}

const conflict = () => new EventCancellationProblem('event-cancellation-conflict', 409, '다른 사람이 먼저 처리했습니다');

export class EventCancellations {
  constructor(
    private readonly store: EventCancellationStore,
    private readonly refunds?: EventRefundStarter,
    private readonly now: () => number = Date.now,
    private readonly audit?: AuditChain,
    private readonly reauth?: EventCancellationReauth,
  ) {}

  async request(input: EventCancellationRequestInput, actor: OpsActor): Promise<EventCancellationView> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.eventId)) throw new EventCancellationProblem('invalid-query', 400, '회차 ID가 올바르지 않습니다');
    if (input.reason.trim() === '') throw new EventCancellationProblem('invalid-body', 400, '요청 본문이 올바르지 않습니다');
    if (input.kind !== undefined && input.kind !== 'CANCEL') throw new EventCancellationProblem('invalid-body', 400, '요청 본문이 올바르지 않습니다');
    if (await this.store.findActiveByEvent(input.eventId)) throw new EventCancellationProblem('sale-not-suspended', 409, '이미 진행 중인 회차 취소 요청이 있습니다');
    const now = new Date(this.now());
    const record: EventCancellationRecord = {
      requestId: randomUUID(),
      eventId: input.eventId,
      kind: 'CANCEL',
      status: 'REQUESTED',
      reason: input.reason,
      requestedBy: actor.accountId,
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
    };
    await this.store.insert(record);
    await this.#audit('EVENT_CANCELLATION_REQUESTED', record.requestId, actor.accountId, { eventId: record.eventId, reason: record.reason, status: record.status }, this.now());
    return eventCancellationView(record);
  }

  async list(filter: { eventId?: string | undefined; status?: readonly EventCancellationStatus[] | undefined; limit: number }): Promise<{ items: EventCancellationView[]; nextCursor: null }> {
    return { items: (await this.store.list(filter)).map(eventCancellationView), nextCursor: null };
  }

  async get(requestId: string): Promise<EventCancellationView> {
    return eventCancellationView(await this.#find(requestId));
  }

  async judge(requestId: string, input: { fault: EventCancellationFault; reason: string; fanNoticeReason: string }, actor: OpsActor): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    if (r.status !== 'REQUESTED' && r.status !== 'JUDGED') throw new EventCancellationProblem('judgement-not-allowed', 409, '지금은 판정할 수 없습니다');
    if (input.fanNoticeReason.length > 200) throw new EventCancellationProblem('invalid-body', 400, '요청 본문이 올바르지 않습니다');
    const now = new Date(this.now());
    const next: EventCancellationRecord = { ...r, status: 'JUDGED', fault: input.fault, judgementReason: input.reason, fanNoticeReason: input.fanNoticeReason, judgedBy: actor.accountId, judgedAt: now, version: r.version + 1, updatedAt: now };
    if (!(await this.store.save(next))) throw conflict();
    await this.#audit('EVENT_CANCELLATION_JUDGED', next.requestId, actor.accountId, { eventId: next.eventId, fault: next.fault, reason: input.reason, fanNoticeReason: input.fanNoticeReason }, this.now());
    return eventCancellationView(next);
  }

  async approve(requestId: string, actor: OpsActor, reauthToken?: string): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    if (r.status !== 'JUDGED' && r.status !== 'PENDING_APPROVAL') throw new EventCancellationProblem('judgement-required', 409, '판정 전에는 확정할 수 없습니다');
    if (r.judgedBy === actor.accountId) throw new EventCancellationProblem('approver-ineligible', 403, '판정자는 확정할 수 없습니다');
    // 계약(openapi /v1/ops/event-cancellations/{requestId}/approvals)은 재인증 토큰을 요구한다(SEC-02).
    if (!this.reauth) throw new EventCancellationProblem('dependency-unavailable', 503, '재인증 검증기를 쓸 수 없습니다');
    const verified = await this.reauth.verify(reauthToken, { sessionId: actor.sessionId ?? '', act: 'APPROVAL' });
    if (verified.accountId !== actor.accountId) throw new EventCancellationProblem('reauth-required', 403, '다시 인증해 주세요');
    if (!this.refunds) throw new EventCancellationProblem('event-refund-unavailable', 503, '일괄 환불 실행기를 쓸 수 없습니다');
    const fault = r.fault;
    if (fault === null) throw new EventCancellationProblem('judgement-required', 409, '판정 전에는 확정할 수 없습니다');
    const now = new Date(this.now());
    // 외부 호출 전에 RUNNING으로 조건부 저장한다. 두 승인자가 동시에 와도 하나만 통과한다(OPS-07).
    const running: EventCancellationRecord = { ...r, status: 'RUNNING', approvedBy: actor.accountId, approvedAt: now, version: r.version + 1, updatedAt: now };
    if (!(await this.store.save(running))) throw conflict();
    await this.#audit('EVENT_CANCELLATION_APPROVED', running.requestId, actor.accountId, { eventId: running.eventId, judgedBy: running.judgedBy, fault: running.fault }, this.now());
    try {
      const job = await this.refunds.start({ eventId: running.eventId, requestId: running.requestId, fault, ruledBy: running.judgedBy ?? '', confirmedBy: actor.accountId, kind: running.kind, ...(running.fanNoticeReason !== null ? { fanNoticeReason: running.fanNoticeReason } : {}) });
      const status = job.state === 'COMPLETED' ? 'COMPLETED' : job.state === 'REFUND_WINDOW' ? 'REFUND_WINDOW' : 'RUNNING';
      const next: EventCancellationRecord = { ...running, status, refundJobState: job.state, version: running.version + 1, updatedAt: new Date(this.now()) };
      if (!(await this.store.save(next))) throw conflict();
      await this.#audit('EVENT_CANCELLATION_STARTED', next.requestId, actor.accountId, { eventId: next.eventId, status: next.status, jobState: job.state }, this.now());
      return eventCancellationView(next);
    } catch (err) {
      // 외부 호출이 실패하면 다시 시도할 수 있게 JUDGED로 되돌린다(이미 시작됐을 수 있으므로 purchase-svc 멱등 키가 받친다).
      const back: EventCancellationRecord = { ...running, status: 'JUDGED', approvedBy: null, approvedAt: null, version: running.version + 1, updatedAt: new Date(this.now()) };
      await this.store.save(back).catch(() => false);
      await this.#audit('EVENT_CANCELLATION_APPROVAL_FAILED', running.requestId, actor.accountId, { eventId: running.eventId, error: err instanceof Error ? err.name : 'unknown' }, this.now());
      throw err;
    }
  }

  async reject(requestId: string, actor: OpsActor, reason: string): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    if (r.status === 'APPROVED' || r.status === 'RUNNING' || r.status === 'PAUSED' || r.status === 'COMPLETED' || r.status === 'REFUND_WINDOW') throw new EventCancellationProblem('already-approved', 409, '이미 확정된 요청입니다');
    if (r.status === 'JUDGED' && r.judgedBy === actor.accountId) throw new EventCancellationProblem('approver-ineligible', 403, '판정자는 반려할 수 없습니다');
    const now = new Date(this.now());
    const next: EventCancellationRecord = r.status === 'JUDGED'
      ? { ...r, status: 'REQUESTED', fault: null, judgementReason: null, fanNoticeReason: null, judgedBy: null, judgedAt: null, version: r.version + 1, updatedAt: now }
      : { ...r, status: 'REJECTED', reason: r.reason, version: r.version + 1, updatedAt: now };
    if (!(await this.store.save(next))) throw conflict();
    await this.#audit('EVENT_CANCELLATION_REJECTED', next.requestId, actor.accountId, { eventId: next.eventId, reason, status: next.status }, this.now());
    return eventCancellationView(next);
  }

  async pause(requestId: string, actor: OpsActor, input: { pg?: EventCancellationPg; reason: string }): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    if (r.status !== 'RUNNING' && r.status !== 'PAUSED') throw new EventCancellationProblem('not-running', 409, '진행 중인 요청이 아닙니다');
    if (!this.refunds) throw new EventCancellationProblem('event-refund-unavailable', 503, '일괄 환불 실행기를 쓸 수 없습니다');
    const job = await this.refunds.pause({ requestId, ...(input.pg ? { pg: input.pg } : {}), reason: input.reason });
    const next: EventCancellationRecord = { ...r, status: 'PAUSED', refundJobState: job.state, version: r.version + 1, updatedAt: new Date(this.now()) };
    if (!(await this.store.save(next))) throw conflict();
    await this.#audit('EVENT_CANCELLATION_PAUSED', next.requestId, actor.accountId, { eventId: next.eventId, pg: input.pg ?? null, reason: input.reason }, this.now());
    return eventCancellationView(next);
  }

  async resume(requestId: string, actor: OpsActor, input: { pg?: EventCancellationPg; reason: string }): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    if (r.status !== 'PAUSED' && r.status !== 'RUNNING') throw new EventCancellationProblem('not-running', 409, '멈춘 요청이 아닙니다');
    if (!this.refunds) throw new EventCancellationProblem('event-refund-unavailable', 503, '일괄 환불 실행기를 쓸 수 없습니다');
    const job = await this.refunds.resume({ requestId, ...(input.pg ? { pg: input.pg } : {}), reason: input.reason });
    const next: EventCancellationRecord = { ...r, status: 'RUNNING', refundJobState: job.state, version: r.version + 1, updatedAt: new Date(this.now()) };
    if (!(await this.store.save(next))) throw conflict();
    await this.#audit('EVENT_CANCELLATION_RESUMED', next.requestId, actor.accountId, { eventId: next.eventId, pg: input.pg ?? null, reason: input.reason }, this.now());
    return eventCancellationView(next);
  }

  async #find(requestId: string): Promise<EventCancellationRecord> {
    const r = await this.store.find(requestId);
    if (!r) throw new EventCancellationProblem('not-found', 404, '회차 취소 요청을 찾을 수 없습니다');
    return r;
  }

  async #audit(recordType: string, recordId: string, actorRef: string, payload: Record<string, unknown>, nowMs: number): Promise<void> {
    await this.audit?.append({ recordType, recordId, payload: { ...payload, actorRef }, nowMs });
  }
}
