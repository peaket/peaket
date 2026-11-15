// 회차 취소 요청·판정·2인 확정(BAT-425 GAT-130 잔여, FR-055, POL-038, ADR-0046).
// 요청(commander) → 판정(commander) → 판정자가 아닌 operator·commander의 확정 → purchase-svc 일괄 환불 시작.
import { randomUUID } from 'node:crypto';
import type { AuditRecord } from '../../audit/audit.js';
import { EventCancellationProblem, eventCancellationView, type EventCancellationFault, type EventCancellationKind, type EventCancellationPg, type EventCancellationRecord, type EventCancellationStatus, type EventCancellationView } from '../domain/event-cancellation.js';
import type { EventCancellationStore, EventRefundStarter } from '../domain/ports.js';

const audit = (recordType: string, recordId: string, payload: Record<string, unknown>, nowMs: number): AuditRecord => ({ recordType, recordId, payload, nowMs });
/** 모든 회차 취소 감사에 싣는 원본 대조용 고정 값(사유·회차·종류·요청자) */
const eventBase = (r: EventCancellationRecord): Record<string, unknown> => ({ eventId: r.eventId, kind: r.kind, requestReason: r.reason, requestedBy: r.requestedBy });

export interface OpsActor {
  readonly accountId: string;
  readonly role: string;
}

export interface EventCancellationRequestInput {
  readonly eventId: string;
  readonly kind?: EventCancellationKind;
  readonly reason: string;
}

const activeStatus = (s: EventCancellationStatus): boolean => ['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW'].includes(s);

export class EventCancellations {
  constructor(
    private readonly store: EventCancellationStore,
    private readonly refunds?: EventRefundStarter,
    private readonly now: () => number = Date.now,
  ) {}

  async request(input: EventCancellationRequestInput, actor: OpsActor): Promise<EventCancellationView> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.eventId)) throw new EventCancellationProblem('invalid-query', 400, '회차 ID가 올바르지 않습니다');
    if (input.reason.trim() === '') throw new EventCancellationProblem('invalid-body', 400, '요청 본문이 올바르지 않습니다');
    if (input.kind !== undefined && input.kind !== 'CANCEL') throw new EventCancellationProblem('invalid-body', 400, '요청 본문이 올바르지 않습니다');
    if (await this.store.findActiveByEvent(input.eventId)) throw new EventCancellationProblem('sale-not-suspended', 409, '이미 진행 중인 회차 취소 요청이 있습니다');
    const nowMs = this.now();
    const now = new Date(nowMs);
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
    await this.store.insert(
      record,
      audit('EVENT_CANCELLATION_REQUESTED', record.requestId, { ...eventBase(record), reason: record.reason, status: record.status }, nowMs),
    );
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
    const nowMs = this.now();
    const next: EventCancellationRecord = { ...r, status: 'JUDGED', fault: input.fault, judgementReason: input.reason, fanNoticeReason: input.fanNoticeReason, judgedBy: actor.accountId, judgedAt: new Date(nowMs), version: r.version + 1, updatedAt: new Date(nowMs) };
    await this.store.save(
      next,
      audit('EVENT_CANCELLATION_JUDGED', next.requestId, { ...eventBase(next), status: next.status, fault: next.fault, reason: next.judgementReason, fanNoticeReason: next.fanNoticeReason }, nowMs),
    );
    return eventCancellationView(next);
  }

  async approve(requestId: string, actor: OpsActor): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    if (r.status !== 'JUDGED' && r.status !== 'PENDING_APPROVAL') throw new EventCancellationProblem('judgement-required', 409, '판정 전에는 확정할 수 없습니다');
    if (r.judgedBy === actor.accountId) throw new EventCancellationProblem('approver-ineligible', 403, '판정자는 확정할 수 없습니다');
    if (!this.refunds) throw new EventCancellationProblem('event-refund-unavailable', 503, '일괄 환불 실행기를 쓸 수 없습니다');
    if (r.fault === null) throw new EventCancellationProblem('judgement-required', 409, '판정 전에는 확정할 수 없습니다');
    const job = await this.refunds.start({ eventId: r.eventId, requestId: r.requestId, fault: r.fault, ruledBy: r.judgedBy ?? '', confirmedBy: actor.accountId, kind: r.kind, ...(r.fanNoticeReason !== null ? { fanNoticeReason: r.fanNoticeReason } : {}) });
    const status = job.state === 'COMPLETED' ? 'COMPLETED' : job.state === 'REFUND_WINDOW' ? 'REFUND_WINDOW' : 'RUNNING';
    const nowMs = this.now();
    const next: EventCancellationRecord = { ...r, status, approvedBy: actor.accountId, approvedAt: new Date(nowMs), refundJobState: job.state, version: r.version + 1, updatedAt: new Date(nowMs) };
    await this.store.save(
      next,
      audit('EVENT_CANCELLATION_APPROVED', next.requestId, { ...eventBase(next), status: next.status, fault: next.fault, refundJobState: next.refundJobState }, nowMs),
    );
    return eventCancellationView(next);
  }

  async reject(requestId: string, actor: OpsActor, reason: string): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    if (r.status === 'APPROVED' || r.status === 'RUNNING' || r.status === 'PAUSED' || r.status === 'COMPLETED' || r.status === 'REFUND_WINDOW') throw new EventCancellationProblem('already-approved', 409, '이미 확정된 요청입니다');
    if (r.status === 'JUDGED' && r.judgedBy === actor.accountId) throw new EventCancellationProblem('approver-ineligible', 403, '판정자는 반려할 수 없습니다');
    const nowMs = this.now();
    const now = new Date(nowMs);
    const next: EventCancellationRecord = r.status === 'JUDGED'
      ? { ...r, status: 'REQUESTED', fault: null, judgementReason: null, fanNoticeReason: null, judgedBy: null, judgedAt: null, version: r.version + 1, updatedAt: now }
      : { ...r, status: 'REJECTED', reason: r.reason, version: r.version + 1, updatedAt: now };
    await this.store.save(
      next,
      audit('EVENT_CANCELLATION_REJECTED', next.requestId, { ...eventBase(next), status: next.status, reason }, nowMs),
    );
    return eventCancellationView(next);
  }

  async pause(requestId: string, actor: OpsActor, input: { pg?: EventCancellationPg; reason: string }): Promise<EventCancellationView> {
    const r = await this.#find(requestId);
    if (r.status !== 'RUNNING' && r.status !== 'PAUSED') throw new EventCancellationProblem('not-running', 409, '진행 중인 요청이 아닙니다');
    if (!this.refunds) throw new EventCancellationProblem('event-refund-unavailable', 503, '일괄 환불 실행기를 쓸 수 없습니다');
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
    if (!this.refunds) throw new EventCancellationProblem('event-refund-unavailable', 503, '일괄 환불 실행기를 쓸 수 없습니다');
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
    if (!r) throw new EventCancellationProblem('not-found', 404, '회차 취소 요청을 찾을 수 없습니다');
    return r;
  }
}

export { activeStatus };
