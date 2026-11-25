// F-04-13 FRAUD_ACTION 승인·실행·이의·닫기 응용 서비스(동결 로컬, LCH-270·LCH-280).
// 정본: docs/features/forensic-replay.md §6.7.4~§6.7.8, docs/features/transfer-refund.md §7.4.
import { randomUUID } from 'node:crypto';
import { parseIfMatch } from '../../admin-accounts/index.js';
import type { ApprovalReauthVerifier } from '../../payouts/index.js';
import {
  ACTION_APPROVAL_BUSINESS_DAYS,
  CANCEL_NOTICE_LEADS_MS,
  OBJECTION_WINDOW_MS,
  RESTRICTION_MAX_MS,
  actionRequestDecision,
  approvalDecisionCheck,
  clearanceCase,
  closeActionedCaseIfDue,
  decideObjections,
  receiveObjection,
  type FraudAction,
  type FraudApprovalStatus,
} from '../domain/fraud-action.js';
import type { FraudCaseEventRecord, FraudCaseRecord, FraudClusterMemberRecord, FraudSnapshotRecord } from '../domain/investigation.js';
import { bareProblem, asBareProblem } from './bare-problem.js';
import { addBusinessDays, weekendOnlyCalendar, type BusinessCalendar } from '../../cases/index.js';
import { FraudApprovalConflictError, FraudCaseConflictError } from '../domain/ports.js';
import type {
  CaseAuditRecord,
  FraudAppealCopies,
  FraudApprovalRecord,
  FraudApprovalStore,
  FraudApproverDirectory,
  FraudApproverIdentity,
  FraudCancellations,
  FraudCaseNotifier,
  FraudIdentityHold,
  FraudLabels,
  FraudRestrictionCopies,
  FraudRestrictionRows,
  FraudTicketDirectory,
  IdempotentWrite,
  InvestigationStore,
  TransferLocks,
} from '../domain/ports.js';
import type { SaleScheduleSource } from '../../readiness/index.js';

export interface FraudActionActor {
  readonly accountId: string;
  readonly sessionId?: string;
  readonly role: string;
}

export interface FraudActionsDeps {
  readonly store: InvestigationStore;
  readonly approvals: FraudApprovalStore;
  readonly schedule: SaleScheduleSource;
  readonly tickets?: FraudTicketDirectory;
  readonly cancellations?: FraudCancellations;
  readonly restrictions?: {
    readonly identity: FraudIdentityHold;
    readonly queue: FraudRestrictionCopies;
    readonly purchase: FraudRestrictionCopies;
    activeForCase(caseId: string): Promise<readonly { accountId: string; caseId?: string; restrictionId: string; untilMs: number; version: number }[]>;
  };
  readonly restrictionRows?: FraudRestrictionRows;
  readonly locks: TransferLocks;
  readonly labels: FraudLabels;
  readonly notifier: FraudCaseNotifier;
  readonly copies?: FraudAppealCopies;
  readonly priority?: { run(i: { caseId: string; accountId: string; eventId: string; cancelledTicketIds: readonly string[]; cancelledTicketId?: string; decision: 'ACCEPTED' | 'REJECTED'; actedBy: string }): Promise<{ decision: 'ACCEPTED' | 'REJECTED'; grants: readonly Record<string, unknown>[] }> };
  readonly approverIdentity?: FraudApproverIdentity;
  readonly approverDirectory?: FraudApproverDirectory;
  readonly reauth?: ApprovalReauthVerifier;
  readonly calendar?: BusinessCalendar;
  readonly now: () => number;
  readonly audit?: { append(r: CaseAuditRecord): Promise<void> };
}

const DAY = 86_400_000;
const clone = <T>(v: T): T => structuredClone(v);
const active = (c: FraudCaseRecord): FraudClusterMemberRecord[] => c.members.filter((m) => m.removedAtMs === null);
const openStatuses: readonly FraudApprovalStatus[] = ['PENDING_APPROVAL', 'EXECUTING', 'FAILED'];
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export class FraudActions {
  readonly executions = new Map<string, { results: readonly any[]; restrictions: Map<string, { restrictionId: string; version: number }> }>();
  readonly #copied = new Set<string>();
  constructor(private readonly d: FraudActionsDeps) {}

  async request(
    actor: FraudActionActor & { accountId: string },
    caseId: string,
    idem: IdempotentWrite,
    body: { fraudAction: FraudAction; accountIds: string[]; ticketIds?: string[]; restrictionEndsAt?: string | null; reason: string },
  ): Promise<Record<string, unknown>> {
    const current = await this.d.store.getCase(caseId);
    if (!current) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    const found = await this.d.store.findIdempotent(idem);
    if (found.kind === 'reused') throw bareProblem('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
    if (found.kind === 'in_progress') throw bareProblem('idempotency-request-in-progress', 409, '같은 요청을 처리 중입니다');
    if (found.kind === 'replay') return found.result as Record<string, unknown>;
    if (body.fraudAction === 'CANCEL_TICKETS' && !this.d.tickets) throw bareProblem('dependency-unavailable', 503, '티켓 조회 경로가 조립되지 않았습니다');
    if (body.fraudAction !== 'CANCEL_TICKETS' && !this.d.restrictions) throw bareProblem('dependency-unavailable', 503, '이용 제한 경로가 조립되지 않았습니다');
    const open = current.approvalId ? await this.d.approvals.get(current.approvalId) : null;
    const restricted = this.d.restrictions ? await this.d.restrictions.activeForCase(caseId) : [];
    const tickets = body.fraudAction === 'CANCEL_TICKETS' ? await (this.d.tickets?.listForAction({ eventId: current.eventId, payerAccountIds: body.accountIds }) ?? Promise.resolve([])) : [];
    const decision = this.#domain(() => actionRequestDecision({
      case: current,
      nowMs: this.d.now(),
      action: body.fraudAction,
      accountIds: body.accountIds,
      ...(body.ticketIds ? { ticketIds: body.ticketIds } : {}),
      ...(body.restrictionEndsAt ? { restrictionEndsAtMs: Date.parse(body.restrictionEndsAt) } : {}),
      openApproval: open !== null && openStatuses.includes(open.status),
      priorActionDone: current.events.some((e) => e.kind === 'ACTION_EXECUTED'),
      tickets,
      restrictedAccountIds: restricted.map((r) => r.accountId),
    }));
    const nowMs = this.d.now();
    const approvalId = randomUUID();
    const dueAtMs = body.fraudAction === 'CANCEL_TICKETS' ? current.cancelDeadlineAtMs : addBusinessDays(this.d.calendar ?? weekendOnlyCalendar, nowMs, ACTION_APPROVAL_BUSINESS_DAYS);
    const record: FraudApprovalRecord = {
      approvalId,
      caseId,
      eventId: current.eventId,
      action: body.fraudAction,
      accountIds: body.accountIds,
      targets: decision.targets.map((t) => {
        const ticket = tickets.find((x) => x.ticketId === t.ticketId);
        return {
          ticketId: t.ticketId,
          payerAccountId: ticket?.payerAccountId ?? body.accountIds[0]!,
          holderAccountId: t.expectedHolderAccountId,
          status: ticket?.status ?? 'ISSUED',
          entryRecorded: ticket?.entryRecorded ?? false,
        };
      }),
      restrictionEndsAtMs: decision.restrictionEndsAtMs,
      reason: body.reason,
      requestedBy: actor.accountId,
      requesterRole: actor.role,
      dueAtMs,
      status: 'PENDING_APPROVAL',
      requestedAtMs: nowMs,
      approverId: null,
      approvedAtMs: null,
      closeReason: null,
      approvals: [],
    };
    const next = clone(current);
    next.status = decision.nextStatus;
    next.approvalId = approvalId;
    next.version = current.version + 1;
    for (const m of next.members) {
      if (body.accountIds.includes(m.accountId) && m.appealResult === 'PENDING') m.appealResult = 'EXPIRED';
    }
    const event: FraudCaseEventRecord = {
      seq: (current.events.at(-1)?.seq ?? 0) + 1,
      kind: 'ACTION_REQUESTED',
      actorId: actor.accountId,
      note: null,
      detail: { approvalId, action: body.fraudAction, accountIds: [...body.accountIds], targets: record.targets, restrictionEndsAt: record.restrictionEndsAtMs === null ? null : new Date(record.restrictionEndsAtMs).toISOString(), dueAt: new Date(dueAtMs).toISOString() },
      occurredAtMs: nowMs,
    };
    next.events = [...current.events, event];
    const result = await this.#approvalView(record, current);
    try {
      await this.d.approvals.request(record, {
        events: [event],
        idem,
        result,
        caseNext: next,
        expectedVersion: current.version,
        ...(this.d.audit ? { audit: { recordType: 'ADMIN_DATA_ACCESS', recordId: approvalId, payload: { caseId, action: body.fraudAction, accountIds: body.accountIds }, nowMs } } : {}),
      });
    } catch (e) {
      if (e instanceof FraudApprovalConflictError) throw bareProblem('approval-already-open', 409, '열린 조치 승인 업무가 있습니다');
      if (e instanceof FraudCaseConflictError) throw bareProblem('precondition-failed', 412, '다른 곳에서 먼저 고쳤습니다');
      throw e;
    }
    return result;
  }

  async clearance(
    actor: FraudActionActor & { accountId: string },
    caseId: string,
    ifMatch: string | undefined,
    body: { reason: string; outcomeLabel: 'HUMAN' | 'NONE' },
    idem?: IdempotentWrite,
  ): Promise<{ view: Record<string, unknown>; version: number }> {
    const current = await this.d.store.getCase(caseId);
    if (!current) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    if (idem) {
      const found = await this.d.store.findIdempotent(idem);
      if (found.kind === 'reused') throw bareProblem('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
      if (found.kind === 'in_progress') throw bareProblem('idempotency-request-in-progress', 409, '같은 요청을 처리 중입니다');
      if (found.kind === 'replay') return found.result as { view: Record<string, unknown>; version: number };
    }
    const version = parseIfMatch(ifMatch);
    if (version === null) throw bareProblem('precondition-required', 428, 'If-Match가 필요합니다');
    if (version !== current.version) throw bareProblem('precondition-failed', 412, '다른 곳에서 먼저 고쳤습니다');
    const nowMs = this.d.now();
    const r = this.#domain(() => clearanceCase({ case: current, nowMs, reason: body.reason, outcomeLabel: body.outcomeLabel }));
    await this.#release(caseId, current.eventId, r.lockReleases, actor.accountId, 'CASE_CLEARED');
    const audit: CaseAuditRecord = { recordType: 'ADMIN_DATA_ACCESS', recordId: caseId, payload: { caseId, outcomeLabel: body.outcomeLabel }, nowMs };
    const result = { view: this.caseView(r.next, null), version: r.next.version };
    const outcome = await this.d.store.updateCase(r.next, current.version, r.events, { audit, ...(idem ? { idem, result } : {}) });
    if (!outcome.ok) {
      await this.#relock(current, r.lockReleases, actor.accountId);
      throw bareProblem('precondition-failed', 412, '다른 곳에서 먼저 고쳤습니다');
    }
    if (body.outcomeLabel === 'HUMAN') {
      const accountIds = r.next.members.filter((m) => m.removedAtMs === null).map((m) => m.accountId);
      try {
        await this.d.labels.apply({ eventId: current.eventId, caseId, accountIds, label: 'HUMAN', actedBy: actor.accountId });
      } catch {
        await this.#note(caseId, 'LABEL_FAILED');
      }
    }
    const saved = (await this.d.store.getCase(caseId)) ?? r.next;
    const snapshot = await this.d.store.latestSnapshot(saved.eventId);
    const schedule = await this.#schedule(saved.eventId);
    return { view: this.caseView(saved, snapshot, schedule?.entryOpensAtMs), version: saved.version };
  }

  async getApprovalOrNull(approvalId: string): Promise<FraudApprovalRecord | null> {
    return this.d.approvals.get(approvalId);
  }

  async getApproval(approvalId: string, actor: FraudActionActor & { accountId: string }): Promise<Record<string, unknown>> {
    const r = await this.d.approvals.get(approvalId);
    if (!r) throw bareProblem('not-found', 404, '승인 업무를 찾을 수 없습니다');
    if (actor.accountId !== r.requestedBy) {
      const eligible = await this.#eligible(actor.accountId, actor.role);
      if (!eligible) throw bareProblem('not-found', 404, '승인 업무를 찾을 수 없습니다');
      await this.d.approvals.recordSummaryView({ approvalId, adminAccountId: actor.accountId, nowMs: this.d.now() });
    }
    const c = await this.d.store.getCase(r.caseId);
    if (!c) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    const viewedAt = await this.d.approvals.summaryViewedAt({ approvalId, adminAccountId: actor.accountId });
    return { ...(await this.#approvalView(r, c)), summaryViewedAt: viewedAt === null ? null : iso(viewedAt) };
  }

  async listApprovals(
    actor: FraudActionActor & { accountId: string },
    filter: { status?: readonly string[]; awaitingMyApproval?: boolean; requestedByMe?: boolean; limit: number },
  ): Promise<{ items: Record<string, unknown>[]; nextCursor: null }> {
    const rows = await this.d.approvals.list({ ...(filter.status ? { status: filter.status } : {}), ...(filter.requestedByMe ? { requesterId: actor.accountId } : {}), limit: filter.limit });
    const items: Record<string, unknown>[] = [];
    for (const r of rows) {
      if (r.requestedBy !== actor.accountId && !(await this.#eligible(actor.accountId, actor.role))) continue;
      const c = await this.d.store.getCase(r.caseId);
      if (c) items.push(await this.#approvalView(r, c));
    }
    return { items, nextCursor: null };
  }

  async approve(
    approvalId: string,
    actor: FraudActionActor & { accountId: string },
    reauthToken: string | undefined,
    body: { reason?: string; excludeAccountIds?: string[]; excludeTicketIds?: string[] },
  ): Promise<Record<string, unknown>> {
    const nowMs = this.d.now();
    const r = await this.d.approvals.get(approvalId);
    if (!r) throw bareProblem('not-found', 404, '승인 업무를 찾을 수 없습니다');
    const c = await this.d.store.getCase(r.caseId);
    if (!c) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    if (r.action === 'CANCEL_TICKETS' && nowMs >= c.cancelDeadlineAtMs) throw bareProblem('cancel-deadline-passed', 409, '취소 마감이 지났습니다');
    if (nowMs >= r.dueAtMs) {
      await this.#expireApproval(r, c, nowMs);
      throw bareProblem('approval-not-pending', 409, '승인 기한이 지났습니다');
    }
    if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED') throw bareProblem('approval-not-pending', 409, '승인 대기 중인 업무가 아닙니다');
    if (!this.d.reauth || !reauthToken) throw bareProblem('reauth-required', 403, '재인증이 필요합니다');
    let verified: { accountId: string };
    try {
      verified = await this.d.reauth.verify(reauthToken, { sessionId: actor.sessionId ?? '', act: 'APPROVAL' });
    } catch {
      throw bareProblem('reauth-required', 403, '재인증이 필요합니다');
    }
    if (verified.accountId !== actor.accountId) throw bareProblem('reauth-required', 403, '재인증이 필요합니다');
    const eligible = await this.#eligible(actor.accountId, actor.role);
    if (!eligible || actor.accountId === r.requestedBy) throw bareProblem('fraud-approver-ineligible', 403, '승인할 수 없는 사람입니다');
    const viewedAt = await this.d.approvals.summaryViewedAt({ approvalId, adminAccountId: actor.accountId });
    const designations = await this.#designations(actor.accountId);
    const recentlyRevoked = (await this.#recentRevocations(actor.accountId)).filter((x) => x.revokedAtMs > nowMs - 90 * DAY).map((x) => x.kind);
    const check = this.#domain(() => approvalDecisionCheck({
      action: r.action,
      requesterId: r.requestedBy,
      approverId: actor.accountId,
      role: actor.role,
      designations,
      recentlyRevoked,
      reason: body.reason ?? null,
      viewedAtMs: viewedAt,
      requestedAccountIds: r.accountIds,
      requestedTicketIds: r.targets.map((t) => t.ticketId),
      ...(body.excludeAccountIds ? { excludeAccountIds: body.excludeAccountIds } : {}),
      ...(body.excludeTicketIds ? { excludeTicketIds: body.excludeTicketIds } : {}),
    }));
    const claim = await this.d.approvals.setStatus({ approvalId, status: 'EXECUTING', from: ['PENDING_APPROVAL', 'FAILED'], nowMs });
    if (!claim.ok) {
      throw bareProblem('approval-not-pending', 409, '승인 대기 중인 업무가 아닙니다');
    }
    const excludedAccounts = new Set(check.excludedAccounts);
    const excludedTickets = new Set(check.excludedTickets);
    const targetAccounts = r.accountIds.filter((a) => !excludedAccounts.has(a));
    const restrictions = this.executions.get(approvalId)?.restrictions ?? new Map<string, { restrictionId: string; version: number }>();
    const priorResults = this.executions.get(approvalId)?.results ?? [];
    let next = clone(c);
    let events: FraudCaseEventRecord[] = [];
    let failed = false;
    let label: 'BOT' | 'HUMAN' | null = null;
    let labelAccounts: string[] = [];
    let noticeAccounts: string[] = [];
    let holderNotices: { accountId: string; ticketIds: string[]; result: 'CANCELED' | 'EXCLUDED' }[] = [];
    let priorityGrants: Record<string, unknown>[] = [];

    if (r.action === 'CANCEL_TICKETS') {
      const failedBefore = priorResults.some((x) => x.outcome === 'FAILED');
      const targets = (failedBefore ? r.targets.filter((t) => priorResults.some((x) => x.outcome === 'FAILED' && x.ticketId === t.ticketId)) : r.targets).filter(
        (t) => targetAccounts.includes(t.payerAccountId) && !excludedTickets.has(t.ticketId),
      );
      let results: readonly any[] = [];
      try {
        if (targets.length === 0 || !this.d.cancellations) throw new Error('취소 경로가 없습니다');
        results = await this.d.cancellations.cancel({
          approvalId,
          caseId: r.caseId,
          eventId: r.eventId,
          targets: targets.map((t) => ({ ticketId: t.ticketId, expectedHolderAccountId: t.holderAccountId })),
          requestedBy: r.requestedBy,
          approvedBy: actor.accountId,
          approvedAtMs: nowMs,
        });
      } catch {
        failed = true;
      }
      const ids = new Set(targets.map((t) => t.ticketId));
      const filtered = results.filter((x) => ids.has(x.ticketId));
      const complete = filtered.length === targets.length && new Set(filtered.map((x) => x.ticketId)).size === filtered.length;
      results = filtered;
      if (!complete || results.some((x) => x.outcome === 'FAILED')) failed = true;
      this.executions.set(approvalId, { results, restrictions });
      if (!failed) {
        const accepted = results.filter((x) => x.outcome === 'ACCEPTED');
        const acceptedAccounts = [...new Set(accepted.map((x) => r.targets.find((t) => t.ticketId === x.ticketId)!.payerAccountId))];
        if (acceptedAccounts.length === 0) {
          const ev: FraudCaseEventRecord = { seq: (c.events.at(-1)?.seq ?? 0) + 1, kind: 'ACTION_EXECUTED', actorId: actor.accountId, note: null, detail: { approvalId, action: r.action, results, targets, executed: false }, occurredAtMs: nowMs };
          const closed: FraudCaseEventRecord = { seq: ev.seq + 1, kind: 'ACTIONED', actorId: actor.accountId, note: null, detail: { reason: 'NO_ACTIONABLE_TICKETS' }, occurredAtMs: nowMs };
          next = { ...clone(c), status: 'ACTIONED', outcomeLabel: 'NONE', closedAtMs: nowMs, version: c.version + 1, events: [...c.events, ev, closed] };
          events = [ev, closed];
        } else {
          const a = this.#actionedCase(c, acceptedAccounts, { approvalId, action: r.action, results, targets, excludedAccounts: [...excludedAccounts], excludedTickets: [...excludedTickets] }, nowMs, actor.accountId);
          next = a.next;
          events = a.events;
          await this.#releaseDuringApproval(approvalId, r.caseId, r.eventId, targetAccounts, actor.accountId, 'ACTION_DONE', nowMs);
          if (excludedAccounts.size > 0) await this.#releaseDuringApproval(approvalId, r.caseId, r.eventId, [...excludedAccounts], actor.accountId, 'ACTION_CLOSED', nowMs);
          label = 'BOT';
          labelAccounts = acceptedAccounts;
          noticeAccounts = acceptedAccounts;
          const byHolder = new Map<string, { canceled: string[]; excluded: string[] }>();
          for (const t of r.targets) {
            if (t.holderAccountId === t.payerAccountId) continue;
            const res = results.find((x) => x.ticketId === t.ticketId);
            const cur = byHolder.get(t.holderAccountId) ?? { canceled: [], excluded: [] };
            if (res?.outcome === 'ACCEPTED') cur.canceled.push(t.ticketId);
            else cur.excluded.push(t.ticketId);
            byHolder.set(t.holderAccountId, cur);
          }
          holderNotices = [...byHolder].flatMap(([accountId, v]) => [
            ...(v.canceled.length > 0 ? [{ accountId, ticketIds: v.canceled, result: 'CANCELED' as const }] : []),
            ...(v.excluded.length > 0 ? [{ accountId, ticketIds: v.excluded, result: 'EXCLUDED' as const }] : []),
          ]);
        }
      }
    } else if (r.action === 'RESTRICT') {
      this.executions.set(approvalId, { results: priorResults, restrictions });
      try {
        if (!this.d.restrictions) throw new Error('이용 제한 경로가 없습니다');
        for (const a of targetAccounts) {
          const prior = restrictions.get(a);
          const restrictionId = prior?.restrictionId ?? randomUUID();
          const version = prior?.version ?? 1;
          const untilMs = r.restrictionEndsAtMs ?? nowMs + RESTRICTION_MAX_MS;
          restrictions.set(a, { restrictionId, version });
          const applied = await this.d.restrictionRows?.restrict({ accountId: a, caseId: r.caseId, restrictionId, version, untilMs, actedBy: actor.accountId });
          const v = applied?.version ?? version;
          restrictions.set(a, { restrictionId, version: v });
          await this.d.restrictions.identity.restrict({ accountId: a, caseId: r.caseId, version: v, untilMs });
          await this.d.restrictions.queue.set({ accountId: a, caseId: r.caseId, restrictionId, state: 'ACTIVE', version: v, untilMs });
          await this.d.restrictions.purchase.set({ accountId: a, caseId: r.caseId, restrictionId, state: 'ACTIVE', version: v, untilMs });
        }
        this.executions.set(approvalId, { results: priorResults, restrictions });
        const a = this.#actionedCase(c, targetAccounts, { approvalId, action: r.action }, nowMs, actor.accountId);
        next = a.next;
        events = a.events;
        label = 'BOT';
        labelAccounts = targetAccounts;
        noticeAccounts = targetAccounts;
      } catch {
        failed = true;
      }
    } else {
      try {
        if (!this.d.restrictions) throw new Error('이용 제한 경로가 없습니다');
        const activeRows = await this.d.restrictions.activeForCase(r.caseId);
        for (const a of targetAccounts) {
          const prior = restrictions.get(a);
          const row = activeRows.find((x) => x.accountId === a);
          const restrictionId = row?.restrictionId ?? prior?.restrictionId ?? randomUUID();
          const version = row?.version ?? prior?.version ?? 1;
          await this.d.restrictions.identity.lift({ accountId: a, caseId: r.caseId, version });
          await this.d.restrictions.queue.set({ accountId: a, caseId: r.caseId, restrictionId, state: 'LIFTED', version: version + 1, untilMs: nowMs });
          await this.d.restrictions.purchase.set({ accountId: a, caseId: r.caseId, restrictionId, state: 'LIFTED', version: version + 1, untilMs: nowMs });
          const lifted = await this.d.restrictionRows?.lift({ accountId: a, caseId: r.caseId, restrictionId, version: version + 1, actedBy: actor.accountId });
          restrictions.set(a, { restrictionId, version: lifted?.version ?? version + 1 });
        }
        this.executions.set(approvalId, { results: priorResults, restrictions });
        const accepted = targetAccounts.filter((a) => c.members.find((m) => m.accountId === a)?.objectionResult === 'ACCEPTED');
        const allAccepted = active(c).filter((m) => m.actionNotifiedAtMs !== undefined && m.actionNotifiedAtMs !== null).every((m) => m.objectionResult === 'ACCEPTED');
        const isReversed = allAccepted && accepted.length > 0;
        next = clone(c);
        next.version = c.version + 1;
        next.status = isReversed ? 'REVERSED' : 'ACTIONED';
        if (isReversed) {
          next.outcomeLabel = 'HUMAN';
          next.closedAtMs = nowMs;
        }
        const ev: FraudCaseEventRecord = { seq: (c.events.at(-1)?.seq ?? 0) + 1, kind: isReversed ? 'REVERSED' : 'ACTIONED', actorId: actor.accountId, note: null, detail: { reason: isReversed ? 'ALL_OBJECTIONS_ACCEPTED' : 'OBJECTIONS_DECIDED' }, occurredAtMs: nowMs };
        next.events = [...c.events, ev];
        events = [ev];
        priorityGrants = await this.#reversalPriority(c, r, accepted, actor.accountId);
        if (priorityGrants.length > 0) ev.detail = { ...(ev.detail ?? {}), grants: priorityGrants };
        label = accepted.length > 0 ? 'HUMAN' : null;
        labelAccounts = accepted;
        noticeAccounts = accepted;
      } catch {
        failed = true;
      }
    }

    if (failed) {
      const ev: FraudCaseEventRecord = { seq: (c.events.at(-1)?.seq ?? 0) + 1, kind: 'ACTION_FAILED', actorId: actor.accountId, note: null, detail: { approvalId, action: r.action }, occurredAtMs: nowMs };
      next = { ...clone(c), version: c.version + 1, events: [...c.events, ev] };
      events = [ev];
    }
    const approvalEvent: FraudCaseEventRecord = {
      seq: (next.events.at(-1)?.seq ?? 0) + 1,
      kind: 'ACTION_APPROVED',
      actorId: actor.accountId,
      note: body.reason ?? null,
      detail: { approvalId, action: r.action, approved: !failed, excludedAccounts: [...excludedAccounts], excludedTickets: [...excludedTickets], summaryViewedAt: iso(viewedAt) },
      occurredAtMs: nowMs,
    };
    events = [...events, approvalEvent];
    next = { ...next, events: [...next.events, approvalEvent] };
    const audit: CaseAuditRecord = { recordType: 'ADMIN_DATA_ACCESS', recordId: r.caseId, payload: { action: 'FRAUD_ACTION_APPROVED', approvalId, fraudAction: r.action, approverId: actor.accountId, excludedAccounts: [...excludedAccounts], excludedTickets: [...excludedTickets] }, nowMs };
    const final = await this.d.approvals.setStatus({
      approvalId,
      status: failed ? 'FAILED' : 'DONE',
      from: ['EXECUTING'],
      approverId: actor.accountId,
      reason: body.reason ?? null,
      closeReason: failed ? 'FAILED' : null,
      nowMs,
      case: { next, expectedVersion: c.version, events, audit },
    });
    if (!final.ok) {
      await this.d.approvals.setStatus({ approvalId, status: 'FAILED', from: ['EXECUTING'], closeReason: 'CONFLICT', nowMs });
      throw bareProblem('precondition-failed', 412, '다른 곳에서 먼저 고쳤습니다');
    }
    if (!failed) {
      try {
        for (const h of holderNotices) await this.d.notifier.holderResult({ eventId: c.eventId, caseId: c.caseId, accountId: h.accountId, ticketIds: h.ticketIds, result: h.result });
        if (label) await this.d.labels.apply({ eventId: c.eventId, caseId: c.caseId, accountIds: labelAccounts, label, source: label === 'HUMAN' ? 'FRAUD_APPEAL_ACCEPTED' : 'FRAUD_ACTIONED', version: next.version, actedBy: actor.accountId });
        for (const a of noticeAccounts) {
          if (next.status === 'REVERSED') await this.d.notifier.restrictionLifted({ eventId: c.eventId, caseId: c.caseId, accountId: a });
          else await this.d.notifier.actionNotice({ eventId: c.eventId, caseId: c.caseId, accountId: a, action: r.action, ticketIds: r.targets.filter((t) => t.payerAccountId === a).map((t) => t.ticketId), restrictionEndsAtMs: r.restrictionEndsAtMs });
        }
      } catch {
        await this.#note(c.caseId, 'NOTICE_FAILED');
      }
    }
    return this.#approvalView((await this.d.approvals.get(approvalId))!, (await this.d.store.getCase(r.caseId)) ?? next);
  }

  async reject(approvalId: string, actor: FraudActionActor & { accountId: string }, reason: string): Promise<Record<string, unknown>> {
    const nowMs = this.d.now();
    const r = await this.d.approvals.get(approvalId);
    if (!r) throw bareProblem('not-found', 404, '승인 업무를 찾을 수 없습니다');
    const c = await this.d.store.getCase(r.caseId);
    if (!c) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    if (nowMs >= r.dueAtMs) {
      await this.#expireApproval(r, c, nowMs);
      throw bareProblem('approval-not-pending', 409, '승인 기한이 지났습니다');
    }
    if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED') throw bareProblem('approval-not-pending', 409, '승인 대기 중인 업무가 아닙니다');
    if (actor.accountId === r.requestedBy) throw bareProblem('fraud-approver-ineligible', 403, '요청자는 반려할 수 없습니다');
    if (!(await this.#eligible(actor.accountId, actor.role))) throw bareProblem('fraud-approver-ineligible', 403, '승인할 수 없는 사람입니다');
    if (reason.trim() === '') throw bareProblem('approval-reason-required', 422, '반려 이유가 필요합니다');
    const priorDone = c.events.some((e) => e.kind === 'ACTION_EXECUTED');
    const next = this.#closedCase(c, priorDone ? 'ACTIONED' : 'INVESTIGATING', 'REJECTED', actor.accountId, nowMs);
    const approvalEvent: FraudCaseEventRecord = { seq: (next.next.events.at(-1)?.seq ?? 0) + 1, kind: 'ACTION_REJECTED', actorId: actor.accountId, note: reason, detail: { approvalId, reason, reasonKind: 'REJECTED' }, occurredAtMs: nowMs };
    const out = await this.d.approvals.setStatus({
      approvalId,
      status: 'REJECTED',
      from: ['PENDING_APPROVAL', 'FAILED'],
      approverId: actor.accountId,
      reason,
      closeReason: 'REJECTED',
      nowMs,
      case: { next: { ...next.next, events: [...next.next.events, approvalEvent] }, expectedVersion: c.version, events: [...next.events, approvalEvent], audit: { recordType: 'ADMIN_DATA_ACCESS', recordId: r.caseId, payload: { action: 'FRAUD_ACTION_REJECTED', approvalId, approverId: actor.accountId }, nowMs } },
    });
    if (!out.ok) throw bareProblem('approval-not-pending', 409, '승인 대기 중인 업무가 아닙니다');
    try {
      await this.#release(r.caseId, r.eventId, r.accountIds, actor.accountId, 'ACTION_CLOSED');
    } catch {
      await this.#note(c.caseId, 'LOCK_RELEASE_FAILED');
    }
    return this.#approvalView((await this.d.approvals.get(approvalId))!, (await this.d.store.getCase(r.caseId)) ?? next.next);
  }

  async withdraw(approvalId: string, actor: FraudActionActor & { accountId: string }, reason: string): Promise<Record<string, unknown>> {
    const nowMs = this.d.now();
    const r = await this.d.approvals.get(approvalId);
    if (!r) throw bareProblem('not-found', 404, '승인 업무를 찾을 수 없습니다');
    if (actor.accountId !== r.requestedBy) throw bareProblem('fraud-approver-ineligible', 403, '요청자만 철회할 수 있습니다');
    const c = await this.d.store.getCase(r.caseId);
    if (!c) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    if (nowMs >= r.dueAtMs) {
      await this.#expireApproval(r, c, nowMs);
      throw bareProblem('approval-not-pending', 409, '승인 기한이 지났습니다');
    }
    if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED') throw bareProblem('approval-not-pending', 409, '승인 대기 중인 업무가 아닙니다');
    const priorDone = c.events.some((e) => e.kind === 'ACTION_EXECUTED');
    const next = this.#closedCase(c, priorDone ? 'ACTIONED' : 'INVESTIGATING', 'WITHDRAWN', actor.accountId, nowMs);
    const out = await this.d.approvals.setStatus({ approvalId, status: 'WITHDRAWN', from: ['PENDING_APPROVAL', 'FAILED'], closeReason: reason, nowMs, case: { next: next.next, expectedVersion: c.version, events: next.events } });
    if (!out.ok) throw bareProblem('approval-not-pending', 409, '승인 대기 중인 업무가 아닙니다');
    return this.#approvalView((await this.d.approvals.get(approvalId))!, (await this.d.store.getCase(r.caseId)) ?? next.next);
  }

  async receiveObjection(caseId: string, body: { appealId: string; accountId: string; party: 'PAYER' | 'HOLDER'; submittedAt: string }): Promise<{ result: string; status?: number }> {
    const nowMs = Date.parse(body.submittedAt);
    if (!Number.isFinite(nowMs)) throw bareProblem('invalid-time', 400, '접수 시각이 올바르지 않습니다');
    const c = await this.d.store.getCase(caseId);
    if (!c) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    if (body.party === 'HOLDER') {
      if (c.status !== 'ACTIONED' && c.status !== 'OBJECTED') throw bareProblem('fraud-case-state', 409, '이 사건 상태에서는 받은 사람 진술을 받을 수 없습니다');
      if (c.appealDueAtMs !== null && this.d.now() >= c.appealDueAtMs) throw bareProblem('fraud-case-state', 409, '소명 기한이 지났습니다');
      if (active(c).some((m) => m.accountId === body.accountId)) throw bareProblem('fraud-case-state', 409, '사건 계정은 받은 사람 진술을 낼 수 없습니다');
      const tickets = await this.d.tickets?.listForAction({ eventId: c.eventId, payerAccountIds: active(c).map((m) => m.accountId) });
      if (!tickets || !tickets.some((t) => t.holderAccountId === body.accountId)) throw bareProblem('fraud-case-state', 409, '이 사건의 받은 사람이 아닙니다');
    }
    const r = this.#domain(() => receiveObjection({ case: c, accountId: body.accountId, party: body.party, appealId: body.appealId, nowMs }));
    if (r.result === 'INVALID') throw bareProblem('fraud-case-state', 409, '이의를 접수할 수 없습니다');
    if (r.next.version !== c.version) {
      const out = await this.d.store.updateCase(r.next, c.version, r.events, {});
      if (!out.ok) throw bareProblem('precondition-failed', 412, '다른 곳에서 먼저 고쳤습니다');
    }
    if (r.result === 'EXPIRED') await this.d.notifier.objectionDecided({ eventId: c.eventId, caseId, accountId: body.accountId, decision: 'REJECTED', reason: '기한 경과', restrictionLifted: false });
    return { result: r.result };
  }

  async decideObjections(actor: FraudActionActor & { accountId: string }, c: FraudCaseRecord, decisions: readonly { accountId: string; decision: 'ACCEPTED' | 'REJECTED'; reason: string }[]): Promise<FraudCaseRecord> {
    const restricted = this.d.restrictions ? await this.d.restrictions.activeForCase(c.caseId) : [];
    const r = this.#domain(() => decideObjections({ case: c, decisions, nowMs: this.d.now(), reversalComplete: false, restrictedAccountIds: restricted.map((x) => x.accountId) }));
    let next = r.next;
    const events = [...r.events];
    const granted: Record<string, unknown>[] = [];
    for (const d of decisions.filter((x) => x.decision === 'ACCEPTED' && !r.liftAccountIds.includes(x.accountId))) {
      const grants = await this.#priorityForAccount(c, c.caseId, d.accountId, actor.accountId);
      if (grants.length > 0) {
        granted.push(...grants);
        events.push({ seq: (next.events.at(-1)?.seq ?? 0) + 1, kind: 'PRIORITY_GRANTED', actorId: actor.accountId, note: null, detail: { accountId: d.accountId, grants }, occurredAtMs: this.d.now() });
      }
    }
    const actioned = active(next).filter((m) => m.actionNotifiedAtMs !== undefined && m.actionNotifiedAtMs !== null);
    if (r.liftAccountIds.length === 0 && actioned.length > 0 && actioned.every((m) => m.objectionResult === 'ACCEPTED')) {
      if (next.events.at(-1)?.kind === 'ACTIONED' && next.events.at(-1)?.detail?.reason === 'OBJECTIONS_DECIDED') next.events = next.events.slice(0, -1);
      if (events.at(-1)?.kind === 'ACTIONED' && events.at(-1)?.detail?.reason === 'OBJECTIONS_DECIDED') events.pop();
      next.status = 'REVERSED';
      next.outcomeLabel = 'HUMAN';
      next.closedAtMs = this.d.now();
      const reversed: FraudCaseEventRecord = { seq: (next.events.at(-1)?.seq ?? 0) + 1, kind: 'REVERSED', actorId: actor.accountId, note: null, detail: { reason: 'ALL_OBJECTIONS_ACCEPTED' }, occurredAtMs: this.d.now() };
      next = { ...next, events: [...next.events, reversed] };
      events.push(reversed);
    }
    if (r.liftAccountIds.length > 0) {
      const approvalId = randomUUID();
      const record: FraudApprovalRecord = {
        approvalId,
        caseId: c.caseId,
        eventId: c.eventId,
        action: 'LIFT_RESTRICTION',
        accountIds: r.liftAccountIds,
        targets: [],
        restrictionEndsAtMs: null,
        reason: '이의 인정',
        requestedBy: actor.accountId,
        requesterRole: actor.role,
        dueAtMs: addBusinessDays(this.d.calendar ?? weekendOnlyCalendar, this.d.now(), ACTION_APPROVAL_BUSINESS_DAYS),
        status: 'PENDING_APPROVAL',
        requestedAtMs: this.d.now(),
        approverId: null,
        approvedAtMs: null,
        closeReason: null,
        approvals: [],
      };
      const event: FraudCaseEventRecord = { seq: (next.events.at(-1)?.seq ?? 0) + 1, kind: 'ACTION_REQUESTED', actorId: actor.accountId, note: null, detail: { approvalId, action: 'LIFT_RESTRICTION', accountIds: r.liftAccountIds, targets: [], restrictionEndsAt: null, eventId: c.eventId }, occurredAtMs: this.d.now() };
      next = { ...next, approvalId, events: [...next.events, event] };
      try {
        await this.d.approvals.request(record, { events: [...events, event], caseNext: next, expectedVersion: c.version });
      } catch (e) {
        if (e instanceof FraudApprovalConflictError) throw bareProblem('approval-already-open', 409, '열린 조치 승인 업무가 있습니다');
        if (e instanceof FraudCaseConflictError) throw bareProblem('precondition-failed', 412, '다른 곳에서 먼저 고쳤습니다');
        throw e;
      }
    } else {
      const out = await this.d.store.updateCase(next, c.version, events, {});
      if (!out.ok) throw bareProblem('precondition-failed', 412, '다른 곳에서 먼저 고쳤습니다');
    }
    try {
      for (const id of r.liftAccountIds) await this.d.notifier.objectionDecided({ eventId: c.eventId, caseId: c.caseId, accountId: id, decision: 'ACCEPTED', reason: decisions.find((d) => d.accountId === id)?.reason ?? '', restrictionLifted: false });
      for (const d of decisions) if (d.decision === 'REJECTED') await this.d.notifier.objectionDecided({ eventId: c.eventId, caseId: c.caseId, accountId: d.accountId, decision: 'REJECTED', reason: d.reason, restrictionLifted: false });
    } catch {
      await this.#note(c.caseId, 'NOTICE_FAILED');
    }
    return next;
  }

  async expireDue(nowMs: number): Promise<number> {
    let n = 0;
    const rows = await this.d.approvals.list({ status: ['PENDING_APPROVAL', 'FAILED'], limit: 1000 });
    for (const r of rows) {
      if (r.dueAtMs > nowMs) continue;
      const c = await this.d.store.getCase(r.caseId);
      if (c && (await this.#expireApproval(r, c, nowMs))) n += 1;
    }
    const cases = await this.d.store.listCases({ limit: 1000 });
    for (const c of cases.items) {
      const schedule = await this.#schedule(c.eventId);
      const entryOpensAtMs = schedule?.entryOpensAtMs ?? null;
      const due = active(c).filter((m) => {
        if (m.lockExpiresAtMs === null) return false;
        return nowMs >= m.lockExpiresAtMs || (entryOpensAtMs !== null && nowMs >= entryOpensAtMs);
      });
      const pending = due.filter((m) => !this.#copied.has(`${c.caseId}:${m.accountId}`));
      if (pending.length === 0) continue;
      const events: FraudCaseEventRecord[] = pending.map((m, i) => ({
        seq: (c.events.at(-1)?.seq ?? 0) + 1 + i,
        kind: 'LOCK_RELEASED',
        actorId: null,
        note: null,
        detail: { accountId: m.accountId, releaseReason: nowMs >= (m.lockExpiresAtMs ?? Infinity) ? 'MAX_DEADLINE' : 'ENTRY_STARTED' },
        occurredAtMs: nowMs,
      }));
      const next = { ...clone(c), version: c.version + 1, events: [...c.events, ...events] };
      const out = await this.d.store.updateCase(next, c.version, events, {});
      if (!out.ok) continue;
      for (const m of pending) {
        try {
          await this.d.copies?.set({ caseId: c.caseId, eventId: c.eventId, accountId: m.accountId, version: next.version, lockActive: false, objectionDueAtMs: m.actionNotifiedAtMs === undefined || m.actionNotifiedAtMs === null ? null : m.actionNotifiedAtMs + OBJECTION_WINDOW_MS, actionResult: null });
        } catch {
          continue;
        }
        this.#copied.add(`${c.caseId}:${m.accountId}`);
        if (nowMs >= (m.lockExpiresAtMs ?? Infinity)) {
          try {
            await this.d.notifier.transferLockReleased({ eventId: c.eventId, caseId: c.caseId, accountId: m.accountId });
          } catch {
            await this.#note(c.caseId, 'NOTICE_FAILED');
          }
        }
      }
    }
    return n;
  }

  async notifyDeadlines(nowMs: number): Promise<number> {
    let n = 0;
    const rows = await this.d.approvals.list({ status: ['PENDING_APPROVAL', 'FAILED'], limit: 1000 });
    const recipients = this.d.approverDirectory ? [...new Set(await this.d.approverDirectory.listEligible())] : [];
    for (const r of rows) {
      if (r.action !== 'CANCEL_TICKETS') continue;
      const c = await this.d.store.getCase(r.caseId);
      if (!c) continue;
      const lead = r.dueAtMs - nowMs;
      const wants = lead <= CANCEL_NOTICE_LEADS_MS[0]! && lead > CANCEL_NOTICE_LEADS_MS[1]! ? CANCEL_NOTICE_LEADS_MS[0]! : lead <= CANCEL_NOTICE_LEADS_MS[1]! && lead > 0 ? CANCEL_NOTICE_LEADS_MS[1]! : null;
      if (wants === null) continue;
      if (c.events.some((e) => e.kind === 'CANCEL_DEADLINE_NOTICE' && e.detail?.approvalId === r.approvalId && e.detail?.leadMs === wants)) continue;
      const ids = [...new Set([c.assigneeId, ...recipients])];
      await this.d.notifier.deadlineNotice({ eventId: c.eventId, caseId: c.caseId, approvalId: r.approvalId, leadMs: wants, recipients: ids });
      const seq = (c.events.at(-1)?.seq ?? 0) + 1;
      const out = await this.d.store.updateCase({ ...c, version: c.version + 1 }, c.version, [{ seq, kind: 'CANCEL_DEADLINE_NOTICE', actorId: null, note: null, detail: { approvalId: r.approvalId, leadMs: wants }, occurredAtMs: nowMs }], {});
      if (out.ok) n += 1;
    }
    return n;
  }

  async closeDueCases(nowMs: number): Promise<number> {
    let n = 0;
    const cases = await this.d.store.listCases({ status: ['ACTIONED'], limit: 1000 });
    for (const c of cases.items) {
      const open = c.approvalId ? await this.d.approvals.get(c.approvalId) : null;
      const r = this.#domain(() => closeActionedCaseIfDue({ case: c, nowMs, openApproval: open !== null && openStatuses.includes(open.status) }));
      if (!r.close) continue;
      const out = await this.d.store.updateCase(r.next, c.version, r.events, {});
      if (out.ok) n += 1;
    }
    return n;
  }

  async #expireApproval(r: FraudApprovalRecord, c: FraudCaseRecord, nowMs: number): Promise<boolean> {
    if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED') return false;
    const priorDone = c.events.some((e) => e.kind === 'ACTION_EXECUTED');
    const next = this.#closedCase(c, priorDone ? 'ACTIONED' : 'INVESTIGATING', 'EXPIRED', null, nowMs);
    const expiredEvent: FraudCaseEventRecord = { seq: (next.next.events.at(-1)?.seq ?? 0) + 1, kind: 'ACTION_EXPIRED', actorId: null, note: null, detail: { approvalId: r.approvalId, reason: 'EXPIRED' }, occurredAtMs: nowMs };
    const out = await this.d.approvals.setStatus({
      approvalId: r.approvalId,
      status: 'EXPIRED',
      from: ['PENDING_APPROVAL', 'FAILED'],
      closeReason: 'EXPIRED',
      nowMs,
      case: { next: { ...next.next, events: [...next.next.events, expiredEvent] }, expectedVersion: c.version, events: [...next.events, expiredEvent], audit: { recordType: 'ADMIN_DATA_ACCESS', recordId: r.caseId, payload: { action: 'FRAUD_ACTION_EXPIRED', approvalId: r.approvalId }, nowMs } },
    });
    if (out.ok) {
      try {
        await this.#release(r.caseId, r.eventId, r.accountIds, c.assigneeId, 'ACTION_CLOSED');
      } catch {
        await this.#note(c.caseId, 'LOCK_RELEASE_FAILED');
      }
    }
    return out.ok;
  }

  #closedCase(c: FraudCaseRecord, status: FraudCaseRecord['status'], reason: string, actorId: string | null, nowMs: number): { next: FraudCaseRecord; events: FraudCaseEventRecord[] } {
    const event: FraudCaseEventRecord = { seq: (c.events.at(-1)?.seq ?? 0) + 1, kind: 'ACTION_CLOSED', actorId, note: null, detail: { reason }, occurredAtMs: nowMs };
    return { next: { ...clone(c), status, version: c.version + 1, events: [...c.events, event] }, events: [event] };
  }

  #actionedCase(c: FraudCaseRecord, accounts: readonly string[], detail: Record<string, unknown>, nowMs: number, actorId: string): { next: FraudCaseRecord; events: FraudCaseEventRecord[] } {
    const next = clone(c);
    next.status = 'ACTIONED';
    next.outcomeLabel = 'BOT';
    next.version = c.version + 1;
    for (const m of next.members) if (accounts.includes(m.accountId)) m.actionNotifiedAtMs = nowMs;
    const event: FraudCaseEventRecord = { seq: (c.events.at(-1)?.seq ?? 0) + 1, kind: 'ACTION_EXECUTED', actorId, note: null, detail, occurredAtMs: nowMs };
    next.events = [...c.events, event];
    return { next, events: [event] };
  }

  async #priorityForAccount(c: FraudCaseRecord, caseId: string, accountId: string, actorId: string): Promise<Record<string, unknown>[]> {
    if (!this.d.priority) return [];
    const ids: string[] = [];
    for (const e of c.events.filter((x) => x.kind === 'ACTION_EXECUTED')) {
      const results = Array.isArray(e.detail?.results) ? (e.detail!.results as any[]) : [];
      const targets = Array.isArray(e.detail?.targets) ? (e.detail!.targets as any[]) : [];
      for (const x of results) {
        if (x.outcome !== 'ACCEPTED') continue;
        const t = targets.find((y) => y.ticketId === x.ticketId);
        if (!t || t.payerAccountId !== accountId) continue;
        ids.push(x.ticketId);
      }
    }
    if (ids.length === 0) return [];
    const out = await this.d.priority.run({ caseId, accountId, eventId: c.eventId, cancelledTicketIds: ids, cancelledTicketId: ids[0]!, decision: 'ACCEPTED', actedBy: actorId });
    return [...out.grants];
  }

  async #reversalPriority(c: FraudCaseRecord, r: FraudApprovalRecord, accounts: readonly string[], actorId: string): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    for (const a of accounts) {
      const grants = await this.#priorityForAccount(c, r.caseId, a, actorId);
      all.push(...grants);
    }
    return all;
  }

  async #releaseDuringApproval(approvalId: string, caseId: string, eventId: string, accounts: readonly string[], actorId: string, reason: string, nowMs: number): Promise<void> {
    try {
      await this.#release(caseId, eventId, accounts, actorId, reason);
    } catch (e) {
      await this.d.approvals.setStatus({ approvalId, status: 'FAILED', from: ['EXECUTING'], closeReason: 'FAILED', nowMs });
      throw e;
    }
  }

  async #release(caseId: string, eventId: string, accounts: readonly string[], actorId: string, releaseReason: string): Promise<void> {
    if (accounts.length === 0) return;
    try {
      const version = await this.d.store.nextLockVersion();
      await this.d.locks.release({ caseId, eventId, accountIds: accounts, version, actedBy: actorId, releaseReason });
    } catch {
      throw bareProblem('dependency-unavailable', 503, '양도 잠금을 풀지 못했습니다');
    }
  }

  async #relock(c: FraudCaseRecord, accounts: readonly string[], actorId: string): Promise<void> {
    if (accounts.length === 0) return;
    const expiries = accounts.map((id) => c.members.find((m) => m.accountId === id)?.lockExpiresAtMs).filter((x): x is number => x !== null && x !== undefined);
    const version = await this.d.store.nextLockVersion();
    await this.d.locks.set({ caseId: c.caseId, eventId: c.eventId, accountIds: accounts, version, expiresAtMs: expiries.length > 0 ? Math.max(...expiries) : this.d.now() + 14 * DAY, actedBy: actorId });
  }

  async #note(caseId: string, note: string): Promise<void> {
    try {
      const c = await this.d.store.getCase(caseId);
      if (!c) return;
      const event: FraudCaseEventRecord = { seq: (c.events.at(-1)?.seq ?? 0) + 1, kind: 'NOTE', actorId: null, note, detail: { note }, occurredAtMs: this.d.now() };
      await this.d.store.updateCase({ ...c, version: c.version + 1 }, c.version, [event], {});
    } catch {
      // 부수 효과 실패 기록도 실패하면 다음 정비에 맡긴다
    }
  }

  #domain<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      throw asBareProblem(e);
    }
  }

  async #eligible(accountId: string, role: string): Promise<boolean> {
    if (role !== 'commander' || !this.d.approverIdentity) return false;
    try {
      const designations = await this.d.approverIdentity.designations(accountId);
      const revoked = (await this.d.approverIdentity.recentlyRevoked(accountId)).filter((x) => x.revokedAtMs > this.d.now() - 90 * DAY);
      return !designations.includes('PSEUDONYM_HANDLER') && !revoked.some((x) => x.kind === 'PSEUDONYM_HANDLER');
    } catch {
      return false;
    }
  }

  async #designations(accountId: string): Promise<readonly string[]> {
    if (!this.d.approverIdentity) throw bareProblem('fraud-approver-ineligible', 403, '승인할 수 없는 사람입니다');
    try {
      return await this.d.approverIdentity.designations(accountId);
    } catch {
      throw bareProblem('fraud-approver-ineligible', 403, '승인 자격을 확인할 수 없습니다');
    }
  }

  async #recentRevocations(accountId: string): Promise<readonly { kind: string; revokedAtMs: number }[]> {
    if (!this.d.approverIdentity) throw bareProblem('fraud-approver-ineligible', 403, '승인할 수 없는 사람입니다');
    try {
      return await this.d.approverIdentity.recentlyRevoked(accountId);
    } catch {
      throw bareProblem('fraud-approver-ineligible', 403, '승인 자격을 확인할 수 없습니다');
    }
  }

  async #approvalView(r: FraudApprovalRecord, c: FraudCaseRecord): Promise<Record<string, unknown>> {
    const targets = r.accountIds.map((accountId) => ({
      accountId,
      ticketIds: r.targets.filter((t) => t.payerAccountId === accountId).map((t) => t.ticketId),
      holderTicketIds: r.targets.filter((t) => t.payerAccountId === accountId && t.holderAccountId !== accountId).map((t) => t.ticketId),
      appealOutcome: c.members.find((m) => m.accountId === accountId)?.appealResult ?? 'NOT_REQUESTED',
    }));
    const cluster = await this.d.store.getCluster(c.clusterId).catch(() => null);
    return {
      approvalId: r.approvalId,
      kind: 'FRAUD_ACTION',
      targetRef: r.caseId,
      fraudAction: r.action,
      reasonCode: 'FRAUD_ACTION',
      reasonText: r.reason,
      requiredApprovals: 2,
      approvals: r.approvals,
      status: r.status,
      requestedBy: { adminAccountId: r.requestedBy, displayName: null, role: r.requesterRole ?? null },
      requestedAt: iso(r.requestedAtMs ?? r.nowMs ?? 0),
      canApprove: r.status === 'PENDING_APPROVAL',
      dueAt: iso(r.dueAtMs),
      closeReason: r.closeReason,
      summaryViewedAt: null,
      fraudCaseSummary: {
        accountCount: active(c).length,
        purchaseCount: cluster?.purchaseCount ?? active(c).reduce((n, m) => n + m.ticketCount, 0),
        limitPerPerson: cluster?.limitPerPerson ?? 4,
        scoreBand: cluster?.scoreBand ?? 'HIGH',
        sharedAttributes: cluster?.sharedAttributes ?? [],
        signals: [...new Set(active(c).flatMap((m) => m.signals))],
        appealOutcome: this.#appealOutcome(c),
        investigatorOpinion: c.investigatorOpinion,
        cancelDeadlineAt: iso(c.cancelDeadlineAtMs),
        targets,
      },
    };
  }

  #appealOutcome(c: FraudCaseRecord): string {
    const results = active(c).map((m) => m.appealResult);
    if (results.length === 0) return 'NOT_REQUESTED';
    if (results.every((r) => r === 'ACCEPTED')) return 'ACCEPTED';
    if (results.every((r) => r === 'REJECTED' || r === 'EXPIRED')) return 'REJECTED';
    if (results.every((r) => r === 'NOT_REQUESTED')) return 'NOT_REQUESTED';
    if (results.every((r) => r === 'PENDING' || r === 'SUBMITTED')) return 'PENDING';
    return 'PARTIAL';
  }

  caseView(c: FraudCaseRecord, snapshot: FraudSnapshotRecord | null, entryOpensAtMs?: number | null): Record<string, unknown> {
    const locked = (m: FraudClusterMemberRecord): boolean =>
      m.removedAtMs === null &&
      m.lockExpiresAtMs !== null &&
      m.lockExpiresAtMs > this.d.now() &&
      (entryOpensAtMs === undefined || entryOpensAtMs === null || this.d.now() < entryOpensAtMs) &&
      m.appealResult !== 'ACCEPTED' &&
      c.status !== 'CLEARED';
    return {
      caseId: c.caseId,
      eventId: c.eventId,
      clusterId: c.clusterId,
      status: c.status,
      reasonCategory: c.reasonCategory,
      assigneeId: c.assigneeId,
      accountCount: active(c).length,
      ticketCount: active(c).reduce((n, m) => n + m.ticketCount, 0),
      appealDueAt: iso(c.appealDueAtMs),
      cancelDeadlineAt: iso(c.cancelDeadlineAtMs),
      transferLocked: active(c).some(locked),
      approvalId: c.approvalId,
      outcomeLabel: c.outcomeLabel,
      version: c.version,
      createdAt: iso(c.createdAtMs),
      closedAt: iso(c.closedAtMs),
      members: c.members.map((m) => ({
        accountId: m.accountId,
        ticketCount: m.ticketCount,
        signals: m.signals,
        addedBy: m.addedBy,
        removed: m.removedAtMs !== null,
        appealResult: m.appealResult,
        appealDueAt: iso(m.appealDueAtMs),
        objectionResult: m.objectionResult ?? 'NONE',
        objectionDueAt: iso(m.actionNotifiedAtMs === undefined || m.actionNotifiedAtMs === null ? null : m.actionNotifiedAtMs + OBJECTION_WINDOW_MS),
        transferLocked: locked(m),
        lockExpiresAt: iso(m.lockExpiresAtMs),
      })),
      appealOutcome: this.#appealOutcome(c),
      investigatorOpinion: c.investigatorOpinion,
      evidenceBundleIds: [],
      events: c.events.map((e) => ({ seq: e.seq, kind: e.kind, actorId: e.actorId, note: e.note, detail: e.detail, occurredAt: iso(e.occurredAtMs) })),
      ...(snapshot ? { snapshot: { version: snapshot.version, frozenAt: iso(snapshot.frozenAtMs), invHash: snapshot.invHash, late: snapshot.late } } : {}),
    };
  }

  async #schedule(eventId: string): Promise<{ entryOpensAtMs: number | null; saleEndsAtMs: number } | null> {
    try {
      const s = await this.d.schedule.get(eventId);
      return s ? { entryOpensAtMs: s.entryOpensAtMs ?? null, saleEndsAtMs: s.saleEndsAtMs } : null;
    } catch {
      return null;
    }
  }
}
