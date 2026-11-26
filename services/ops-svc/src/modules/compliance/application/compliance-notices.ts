// 법정 통보 접수·목록·상세·차단·철회 유스케이스(F-07-11, LCH-160, POL-024, control-tower §9).
// 등록·차단·철회는 Idempotency-Key를 계정 범위로 보고, core-svc 내부 경로가 답하지 않으면 상태를 바꾸지 않고 503으로 닫는다.
import { createHash } from 'node:crypto';
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import {
  dueAtOf,
  isFullView,
  normalizeReason,
  normalizeSummary,
  type ComplianceActionRecord,
  type ComplianceDeadline,
  type ComplianceNoticeRecord,
  type ComplianceRequester,
  type ComplianceStatus,
} from '../domain/compliance-notice.js';
import type { ComplianceAudit, ComplianceCore, ComplianceNoticeListQuery, ComplianceNoticeStore } from '../domain/ports.js';

export interface ComplianceActor {
  readonly accountId: string;
  readonly role: string;
}

export interface ComplianceNoticeView {
  readonly view: 'SUMMARY' | 'FULL';
  readonly noticeId: string;
  readonly requester: ComplianceRequester;
  readonly agencyName: string;
  readonly dueAt: string;
  readonly status: ComplianceStatus;
  readonly receivedAt?: string;
  readonly deadline?: ComplianceDeadline;
  readonly reviewIds?: readonly string[];
  readonly summary?: string;
  readonly documents?: readonly unknown[];
  readonly takenDownAt?: string | null;
  readonly withdrawnAt?: string | null;
}

export interface ComplianceNoticePageView {
  readonly items: ComplianceNoticeView[];
  readonly nextCursor: string | null;
}

export interface CreateNoticeInput {
  readonly requester: ComplianceRequester;
  readonly agencyName: string;
  readonly receivedAt: string;
  readonly deadline: ComplianceDeadline;
  readonly reviewIds: readonly string[];
  readonly summary?: string;
}

export interface ComplianceNoticesDeps {
  readonly store: ComplianceNoticeStore;
  readonly core: ComplianceCore;
  readonly audit: ComplianceAudit;
  readonly clock: Clock;
}

const hashOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());
const notFound = (): ProblemError => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const conflict = (): ProblemError => new ProblemError({ type: 'compliance-notice-conflict', status: 409, title: '지금 통보 상태에서는 할 수 없습니다' });
const invalidKey = (): ProblemError => new ProblemError({ type: 'idempotency-key-invalid', status: 400, title: '멱등 키(Idempotency-Key)가 없거나 형식이 맞지 않습니다' });
const reusedKey = (): ProblemError => new ProblemError({ type: 'idempotency-key-reused', status: 422, title: '같은 멱등 키를 다른 요청에 썼습니다' });
const coreUnavailable = (): ProblemError => new ProblemError({ type: 'compliance-core-unavailable', status: 503, title: 'core-svc 통보 경로에 닿지 못했습니다', retryAfterSeconds: 5 });
const invalid = (type: string, title: string): ProblemError => new ProblemError({ type, status: 422, title });

function fullView(n: ComplianceNoticeRecord): ComplianceNoticeView {
  return {
    view: 'FULL',
    noticeId: n.noticeId,
    requester: n.requester,
    agencyName: n.agencyName,
    dueAt: new Date(n.dueAtMs).toISOString(),
    status: n.status,
    receivedAt: new Date(n.receivedAtMs).toISOString(),
    deadline: n.deadline,
    reviewIds: n.reviewIds,
    summary: n.summary,
    documents: [],
    takenDownAt: iso(n.takenDownAtMs),
    withdrawnAt: iso(n.withdrawnAtMs),
  };
}

function summaryView(n: ComplianceNoticeRecord): ComplianceNoticeView {
  return { view: 'SUMMARY', noticeId: n.noticeId, requester: n.requester, agencyName: n.agencyName, dueAt: new Date(n.dueAtMs).toISOString(), status: n.status };
}

export class ComplianceNotices {
  constructor(private readonly d: ComplianceNoticesDeps) {}

  async create(input: CreateNoticeInput, actor: ComplianceActor, rawKey: string | undefined): Promise<{ noticeId: string; dueAt: string }> {
    if (!rawKey) throw invalidKey();
    if (new Set(input.reviewIds).size !== input.reviewIds.length) {
      throw new ProblemError({ type: 'invalid-body', status: 400, title: '중복된 후기 ID가 있습니다' });
    }
    const now = this.d.clock.now();
    const existing = await this.d.store.findByIdempotency(actor.accountId, rawKey);
    const requestHash = hashOf(input);
    if (existing) {
      if (existing.requestHash !== requestHash) throw reusedKey();
      return { noticeId: existing.noticeId, dueAt: new Date(existing.dueAtMs).toISOString() };
    }
    let summary: string;
    try {
      summary = normalizeSummary(input.summary);
    } catch {
      throw invalid('compliance-notice-invalid', '통보 요약이 너무 깁니다');
    }
    const receivedAtMs = Date.parse(input.receivedAt);
    const notice: ComplianceNoticeRecord = {
      noticeId: uuidv7(this.d.clock),
      requestedBy: actor.accountId,
      idempotencyKey: rawKey,
      requestHash,
      requester: input.requester,
      agencyName: input.agencyName,
      receivedAtMs,
      deadline: input.deadline,
      dueAtMs: dueAtOf(receivedAtMs, input.deadline),
      reviewIds: [...input.reviewIds],
      summary,
      status: 'OPEN',
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.d.store.insertNotice(notice);
    await this.d.audit.record({ action: 'NOTICE_CREATED', noticeId: notice.noticeId, actorId: actor.accountId, role: actor.role, atMs: now });
    return { noticeId: notice.noticeId, dueAt: new Date(notice.dueAtMs).toISOString() };
  }

  async list(q: ComplianceNoticeListQuery, role: string): Promise<ComplianceNoticePageView> {
    const page = await this.d.store.listNotices(q);
    const full = isFullView(role);
    return { items: page.items.map((n) => (full ? fullView(n) : summaryView(n))), nextCursor: page.nextCursor };
  }

  async detail(noticeId: string, actor: ComplianceActor): Promise<ComplianceNoticeView> {
    const n = await this.d.store.findNotice(noticeId);
    if (!n) throw notFound();
    await this.d.audit.record({ action: 'NOTICE_VIEWED', noticeId, actorId: actor.accountId, role: actor.role, atMs: this.d.clock.now() });
    return isFullView(actor.role) ? fullView(n) : summaryView(n);
  }

  async takedown(noticeId: string, rawReason: string, actor: ComplianceActor, rawKey: string | undefined): Promise<{ noticeId: string; status: 'TAKEN_DOWN'; takenDownAt: string; reason: string }> {
    if (!rawKey) throw invalidKey();
    const reason = normalizeReasonOrThrow(rawReason);
    const n = await this.d.store.findNotice(noticeId);
    if (!n) throw notFound();
    const requestHash = hashOf({ reason: rawReason });
    const replay = await this.d.store.findAction(noticeId, 'TAKEDOWN', rawKey);
    if (replay) {
      if (replay.requestHash !== requestHash) throw reusedKey();
      return { noticeId, status: 'TAKEN_DOWN', takenDownAt: new Date(replay.createdAtMs).toISOString(), reason: replay.reason };
    }
    if (n.status !== 'OPEN') throw conflict();
    try {
      await this.d.core.applyNotice({ noticeId, reviewIds: n.reviewIds, receivedAt: new Date(n.receivedAtMs).toISOString(), deadline: n.deadline, reason });
    } catch {
      throw coreUnavailable();
    }
    const now = this.d.clock.now();
    await this.d.store.updateNotice(noticeId, { status: 'TAKEN_DOWN', takenDownAtMs: now, updatedAtMs: now });
    const action: ComplianceActionRecord = {
      actionId: uuidv7(this.d.clock),
      noticeId,
      action: 'TAKEDOWN',
      idempotencyKey: rawKey,
      requestHash,
      reason,
      actorRef: actor.accountId,
      createdAtMs: now,
    };
    await this.d.store.insertAction(action);
    await this.d.audit.record({ action: 'NOTICE_TAKEN_DOWN', noticeId, actorId: actor.accountId, role: actor.role, atMs: now });
    return { noticeId, status: 'TAKEN_DOWN', takenDownAt: new Date(now).toISOString(), reason };
  }

  async withdraw(noticeId: string, rawReason: string, actor: ComplianceActor, rawKey: string | undefined): Promise<{ noticeId: string; status: 'WITHDRAWN'; withdrawnAt: string; reason: string }> {
    if (!rawKey) throw invalidKey();
    const reason = normalizeReasonOrThrow(rawReason);
    const n = await this.d.store.findNotice(noticeId);
    if (!n) throw notFound();
    const requestHash = hashOf({ reason: rawReason });
    const replay = await this.d.store.findAction(noticeId, 'WITHDRAWAL', rawKey);
    if (replay) {
      if (replay.requestHash !== requestHash) throw reusedKey();
      return { noticeId, status: 'WITHDRAWN', withdrawnAt: new Date(replay.createdAtMs).toISOString(), reason: replay.reason };
    }
    if (n.status !== 'TAKEN_DOWN') throw conflict();
    try {
      await this.d.core.withdrawNotice({ noticeId, reason });
    } catch {
      throw coreUnavailable();
    }
    const now = this.d.clock.now();
    await this.d.store.updateNotice(noticeId, { status: 'WITHDRAWN', withdrawnAtMs: now, updatedAtMs: now });
    const action: ComplianceActionRecord = {
      actionId: uuidv7(this.d.clock),
      noticeId,
      action: 'WITHDRAWAL',
      idempotencyKey: rawKey,
      requestHash,
      reason,
      actorRef: actor.accountId,
      createdAtMs: now,
    };
    await this.d.store.insertAction(action);
    await this.d.audit.record({ action: 'NOTICE_WITHDRAWN', noticeId, actorId: actor.accountId, role: actor.role, atMs: now });
    return { noticeId, status: 'WITHDRAWN', withdrawnAt: new Date(now).toISOString(), reason };
  }
}

function normalizeReasonOrThrow(raw: string): string {
  try {
    return normalizeReason(raw);
  } catch {
    throw invalid('compliance-notice-invalid', '통보 사유는 1~2,000자여야 합니다');
  }
}
