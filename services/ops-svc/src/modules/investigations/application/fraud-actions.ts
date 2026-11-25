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
    activeForCase(caseId: string): Promise<readonly { accountId: string; restrictionId: string; untilMs: number; version: number }[]>;
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
  readonly now: () => number;
  readonly audit?: { append(r: CaseAuditRecord): Promise<void> };
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const clone = <T>(v: T): T => structuredClone(v);
const active = (c: FraudCaseRecord): FraudClusterMemberRecord[] => c.members.filter((m) => m.removedAtMs === null);
const openStatuses: readonly FraudApprovalStatus[] = ['PENDING_APPROVAL', 'EXECUTING', 'FAILED'];

export class FraudActions {
  readonly executions = new Map<string, { restrictionId: string; version: number; results: readonly any[] }>();
  readonly #copied = new Set<string>();
  constructor(private readonly d: FraudActionsDeps) {}

  async request(
    actor: FraudActionActor & { accountId: string },
    caseId: string,
    idem: IdempotentWrite,
    body: { fraudAction: FraudAction; accountIds: string[]; ticketIds?: string[]; restrictionEndsAt?: string; reason: string },
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
    const dueAtMs = body.fraudAction === 'CANCEL_TICKETS' ? current.cancelDeadlineAtMs : nowMs + ACTION_APPROVAL_BUSINESS_DAYS * DAY;
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
    const seq = (current.events.at(-1)?.seq ?? 0) + 1;
    const event: FraudCaseEventRecord = {
      seq,
      kind: 'ACTION_REQUESTED',
      actorId: actor.accountId,
      note: null,
      detail: { approvalId, action: body.fraudAction, accountIds: [...body.accountIds], targets: record.targets, restrictionEndsAt: record.restrictionEndsAtMs === null ? null : new Date(record.restrictionEndsAtMs).toISOString(), dueAt: new Date(dueAtMs).toISOString() },
      occurredAtMs: nowMs,
    };
    next.events = [...current.events, event];
    const result = this.#approvalView(record, current);
    await this.d.approvals.request(record, {
      events: [event],
      idem,
      result,
      caseStatus: decision.nextStatus,
      ...(this.d.audit ? { audit: { recordType: 'ADMIN_DATA_ACCESS', recordId: approvalId, payload: { caseId, action: body.fraudAction, accountIds: body.accountIds }, nowMs } } : {}),
    });
    if (!(this.d.approvals as unknown as { updatesCase?: boolean }).updatesCase) {
      await this.d.store.updateCase(next, current.version, [event], { idem, result, ...(this.d.audit ? { audit: { recordType: 'ADMIN_DATA_ACCESS', recordId: approvalId, payload: { caseId, action: body.fraudAction }, nowMs } } : {}) });
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
    if (!outcome.ok) throw bareProblem('precondition-failed', 412, '다른 곳에서 먼저 고쳤습니다');
    if (body.outcomeLabel === 'HUMAN') await this.d.labels.apply({ eventId: current.eventId, caseId, accountIds: r.lockReleases, label: 'HUMAN', actedBy: actor.accountId });
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
    return { ...this.#approvalView(r, c), summaryViewedAt: viewedAt === null ? null : iso(viewedAt) };
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
      if (c) items.push(this.#approvalView(r, c));
    }
    return { items, nextCursor: null };
  }

  async approve(
    approvalId: string,
    actor: FraudActionActor & { accountId: string },
    reauthToken: string | undefined,
    body: { reason?: string; excludeAccountIds?: string[]; excludeTicketIds?: string[] },
  ): Promise<Record<string, unknown>> {
    const r = await this.d.approvals.get(approvalId);
    if (!r) throw bareProblem('not-found', 404, '승인 업무를 찾을 수 없습니다');
    const c = await this.d.store.getCase(r.caseId);
    if (!c) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    if (r.action === 'CANCEL_TICKETS' && this.d.now() >= c.cancelDeadlineAtMs) throw bareProblem('cancel-deadline-passed', 409, '취소 마감이 지났습니다');
    if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED' && r.status !== 'EXECUTING') throw bareProblem('approval-not-pending', 409, '승인 대기 중인 업무가 아닙니다');
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
    const recentlyRevoked = (await this.#recentRevocations(actor.accountId)).filter((x) => x.revokedAtMs > this.d.now() - 90 * DAY).map((x) => x.kind);
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
    await this.d.approvals.setStatus({ approvalId, status: 'EXECUTING', nowMs: this.d.now() });
    const excludedAccounts = new Set(check.excludedAccounts);
    const excludedTickets = new Set(check.excludedTickets);
    const targetAccounts = r.accountIds.filter((a) => !excludedAccounts.has(a));
    if (r.action === 'CANCEL_TICKETS') {
      const prior = this.executions.get(approvalId);
      const failedBefore = prior?.results.some((x) => x.outcome === 'FAILED') === true;
      const targets = (failedBefore ? r.targets.filter((t) => prior!.results.some((x) => x.outcome === 'FAILED' && x.ticketId === t.ticketId)) : r.targets).filter(
        (t) => targetAccounts.includes(t.payerAccountId) && !excludedTickets.has(t.ticketId),
      );
      let results: readonly any[] = [];
      if (targets.length > 0 && this.d.cancellations) {
        results = await this.d.cancellations.cancel({
          approvalId,
          caseId: r.caseId,
          eventId: r.eventId,
          targets: targets.map((t) => ({ ticketId: t.ticketId, expectedHolderAccountId: t.holderAccountId })),
          requestedBy: r.requestedBy,
          approvedBy: actor.accountId,
          approvedAtMs: this.d.now(),
        });
      }
      const failed = results.find((x) => x.outcome === 'FAILED') ?? (targets.length > 0 && !this.d.cancellations ? { ticketId: targets[0]!.ticketId, outcome: 'FAILED', failureCode: 'CANCELLATION_UNAVAILABLE' } : undefined);
      this.executions.set(approvalId, { restrictionId: prior?.restrictionId ?? randomUUID(), version: prior?.version ?? 1, results });
      if (failed) {
        await this.d.approvals.setStatus({ approvalId, status: 'FAILED', approverId: actor.accountId, reason: body.reason ?? null, closeReason: 'FAILED', nowMs: this.d.now() });
        await this.#appendEvent(c, 'ACTION_FAILED', { approvalId, action: r.action, results }, actor.accountId);
        return this.#approvalView((await this.d.approvals.get(approvalId))!, c);
      }
      await this.#releaseForDone(r.caseId, r.eventId, targetAccounts, actor.accountId);
      if (excludedAccounts.size > 0) await this.#release(r.caseId, r.eventId, [...excludedAccounts], actor.accountId, 'ACTION_CLOSED');
      const next = await this.#actioned(c, targetAccounts, actor.accountId, { approvalId, action: r.action, results, excludedAccounts: [...excludedAccounts], excludedTickets: [...excludedTickets] });
      for (const h of results.filter((x) => x.outcome === 'SKIPPED_HOLDER_CHANGED')) {
        const t = r.targets.find((x) => x.ticketId === h.ticketId);
        if (t && t.holderAccountId !== t.payerAccountId) await this.d.notifier.holderResult({ eventId: c.eventId, caseId: c.caseId, accountId: t.holderAccountId, ticketIds: [t.ticketId], result: 'EXCLUDED' });
      }
      await this.d.labels.apply({ eventId: c.eventId, caseId: c.caseId, accountIds: targetAccounts, label: 'BOT', source: 'FRAUD_ACTIONED', version: next.version, actedBy: actor.accountId });
      for (const a of targetAccounts) {
        await this.d.notifier.actionNotice({
          eventId: c.eventId,
          caseId: c.caseId,
          accountId: a,
          action: r.action,
          ticketIds: r.targets.filter((t) => t.payerAccountId === a).map((t) => t.ticketId),
          restrictionEndsAtMs: null,
        });
      }
    } else if (r.action === 'RESTRICT') {
      const prior = this.executions.get(approvalId);
      const restrictionId = prior?.restrictionId ?? randomUUID();
      const version = prior?.version ?? 1;
      const untilMs = r.restrictionEndsAtMs ?? this.d.now() + RESTRICTION_MAX_MS;
      try {
        for (const a of targetAccounts) {
          await this.d.restrictions!.identity.restrict({ accountId: a, caseId: r.caseId, version, untilMs });
          await this.d.restrictions!.queue.set({ accountId: a, caseId: r.caseId, restrictionId, state: 'ACTIVE', version, untilMs });
          await this.d.restrictions!.purchase.set({ accountId: a, caseId: r.caseId, restrictionId, state: 'ACTIVE', version, untilMs });
          await this.d.restrictionRows?.restrict({ accountId: a, caseId: r.caseId, restrictionId, version, untilMs, actedBy: actor.accountId });
        }
        this.executions.set(approvalId, { restrictionId, version, results: [] });
      } catch {
        this.executions.set(approvalId, { restrictionId, version, results: [] });
        await this.d.approvals.setStatus({ approvalId, status: 'FAILED', approverId: actor.accountId, reason: body.reason ?? null, closeReason: 'FAILED', nowMs: this.d.now() });
        return this.#approvalView((await this.d.approvals.get(approvalId))!, c);
      }
      const next = await this.#actioned(c, targetAccounts, actor.accountId, { approvalId, action: r.action });
      await this.d.labels.apply({ eventId: c.eventId, caseId: c.caseId, accountIds: targetAccounts, label: 'BOT', source: 'FRAUD_ACTIONED', version: next.version, actedBy: actor.accountId });
      for (const a of targetAccounts) await this.d.notifier.actionNotice({ eventId: c.eventId, caseId: c.caseId, accountId: a, action: r.action, ticketIds: [], restrictionEndsAtMs: untilMs });
    } else {
      try {
        for (const a of targetAccounts) {
          const prior = this.executions.get(approvalId);
          const activeRows = await this.d.restrictions!.activeForCase(r.caseId);
          await this.d.restrictions!.identity.lift({ accountId: a, caseId: r.caseId, version: prior?.version ?? 1 });
          await this.d.restrictions!.queue.set({ accountId: a, caseId: r.caseId, restrictionId: randomUUID(), state: 'LIFTED', version: prior?.version ?? 1, untilMs: this.d.now() });
          await this.d.restrictions!.purchase.set({ accountId: a, caseId: r.caseId, restrictionId: randomUUID(), state: 'LIFTED', version: prior?.version ?? 1, untilMs: this.d.now() });
          await this.d.restrictionRows?.lift({
            accountId: a,
            caseId: r.caseId,
            restrictionId: activeRows.find((x) => x.accountId === a)?.restrictionId ?? randomUUID(),
            version: (prior?.version ?? 1) + 1,
            actedBy: actor.accountId,
          });
        }
      } catch {
        await this.d.approvals.setStatus({ approvalId, status: 'FAILED', approverId: actor.accountId, reason: body.reason ?? null, closeReason: 'FAILED', nowMs: this.d.now() });
        return this.#approvalView((await this.d.approvals.get(approvalId))!, c);
      }
      const accepted = active(c).filter((m) => m.objectionResult === 'ACCEPTED');
      const allAccepted = accepted.length > 0 && authAllAccepted(c);
      const next = clone(c);
      next.version = c.version + 1;
      if (allAccepted) {
        next.status = 'REVERSED';
        next.outcomeLabel = 'HUMAN';
        next.closedAtMs = this.d.now();
        next.events = [...next.events, { seq: (c.events.at(-1)?.seq ?? 0) + 1, kind: 'REVERSED', actorId: actor.accountId, note: null, detail: { reason: 'ALL_OBJECTIONS_ACCEPTED' }, occurredAtMs: this.d.now() }];
        await this.d.labels.apply({ eventId: c.eventId, caseId: c.caseId, accountIds: targetAccounts, label: 'HUMAN', source: 'FRAUD_APPEAL_ACCEPTED', version: next.version, actedBy: actor.accountId });
        for (const a of targetAccounts) await this.d.notifier.restrictionLifted({ eventId: c.eventId, caseId: c.caseId, accountId: a });
        const grants = await this.#reversalPriority(c, targetAccounts, actor.accountId);
        if (grants.length > 0) {
          const last = next.events[next.events.length - 1]!;
          next.events = [...next.events.slice(0, -1), { ...last, detail: { ...(last.detail ?? {}), grants } }];
        }
      }
      await this.d.store.updateCase(next, c.version, next.events.slice(c.events.length), {});
      await this.d.approvals.setStatus({ approvalId, status: 'DONE', approverId: actor.accountId, reason: body.reason ?? null, nowMs: this.d.now() });
      return this.#approvalView((await this.d.approvals.get(approvalId))!, (await this.d.store.getCase(c.caseId)) ?? next);
    }
    await this.d.approvals.setStatus({ approvalId, status: 'DONE', approverId: actor.accountId, reason: body.reason ?? null, nowMs: this.d.now() });
    return this.#approvalView((await this.d.approvals.get(approvalId))!, (await this.d.store.getCase(r.caseId)) ?? c);
  }

  async reject(approvalId: string, actor: FraudActionActor & { accountId: string }, reason: string): Promise<Record<string, unknown>> {
    const r = await this.d.approvals.get(approvalId);
    if (!r) throw bareProblem('not-found', 404, '승인 업무를 찾을 수 없습니다');
    const c = await this.d.store.getCase(r.caseId);
    if (!c) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    const priorDone = c.events.some((e) => e.kind === 'ACTION_EXECUTED');
    await this.d.approvals.setStatus({ approvalId, status: 'REJECTED', approverId: actor.accountId, reason, closeReason: 'REJECTED', nowMs: this.d.now() });
    await this.#closeAction(c, priorDone ? 'ACTIONED' : 'INVESTIGATING', 'REJECTED', actor.accountId, !priorDone);
    return this.#approvalView((await this.d.approvals.get(approvalId))!, (await this.d.store.getCase(r.caseId)) ?? c);
  }

  async withdraw(approvalId: string, actor: FraudActionActor & { accountId: string }, reason: string): Promise<Record<string, unknown>> {
    const r = await this.d.approvals.get(approvalId);
    if (!r) throw bareProblem('not-found', 404, '승인 업무를 찾을 수 없습니다');
    const c = await this.d.store.getCase(r.caseId);
    if (!c) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    const priorDone = c.events.some((e) => e.kind === 'ACTION_EXECUTED');
    await this.d.approvals.setStatus({ approvalId, status: 'WITHDRAWN', closeReason: reason, nowMs: this.d.now() });
    await this.#closeAction(c, priorDone ? 'ACTIONED' : 'INVESTIGATING', 'WITHDRAWN', actor.accountId, false);
    return this.#approvalView((await this.d.approvals.get(approvalId))!, (await this.d.store.getCase(r.caseId)) ?? c);
  }

  async receiveObjection(caseId: string, body: { appealId: string; accountId: string; party: 'PAYER' | 'HOLDER'; submittedAt: string }): Promise<{ result: string; status?: number }> {
    const c = await this.d.store.getCase(caseId);
    if (!c) throw bareProblem('not-found', 404, '사건을 찾을 수 없습니다');
    const r = this.#domain(() => receiveObjection({ case: c, accountId: body.accountId, party: body.party, appealId: body.appealId, nowMs: Date.parse(body.submittedAt) }));
    if (r.result === 'INVALID') throw bareProblem('fraud-case-state', 409, '이의를 접수할 수 없습니다');
    if (r.next.version !== c.version) await this.d.store.updateCase(r.next, c.version, r.events, {});
    if (r.result === 'EXPIRED') await this.d.notifier.objectionDecided({ eventId: c.eventId, caseId, accountId: body.accountId, decision: 'REJECTED', reason: '기한 경과', restrictionLifted: false });
    return { result: r.result };
  }

  async decideObjections(actor: FraudActionActor & { accountId: string }, c: FraudCaseRecord, decisions: readonly { accountId: string; decision: 'ACCEPTED' | 'REJECTED'; reason: string }[]): Promise<FraudCaseRecord> {
    const restricted = this.d.restrictions ? await this.d.restrictions.activeForCase(c.caseId) : [];
    const r = this.#domain(() => decideObjections({ case: c, decisions, nowMs: this.d.now(), reversalComplete: false, restrictedAccountIds: restricted.map((x) => x.accountId) }));
    let next = r.next;
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
        dueAtMs: this.d.now() + ACTION_APPROVAL_BUSINESS_DAYS * DAY,
        status: 'PENDING_APPROVAL',
        requestedAtMs: this.d.now(),
        approverId: null,
        approvedAtMs: null,
        closeReason: null,
        approvals: [],
      };
      await this.d.approvals.request(record, { events: [] });
      next = { ...next, approvalId };
    }
    await this.d.store.updateCase(next, c.version, r.events, {});
    for (const id of r.liftAccountIds) await this.d.notifier.objectionDecided({ eventId: c.eventId, caseId: c.caseId, accountId: id, decision: 'ACCEPTED', reason: decisions.find((d) => d.accountId === id)?.reason ?? '', restrictionLifted: false });
    for (const d of decisions) if (d.decision === 'REJECTED') await this.d.notifier.objectionDecided({ eventId: c.eventId, caseId: c.caseId, accountId: d.accountId, decision: 'REJECTED', reason: d.reason, restrictionLifted: false });
    return next;
  }

  async expireDue(nowMs: number): Promise<number> {
    let n = 0;
    const rows = await this.d.approvals.list({ status: openStatuses, limit: 1000 });
    for (const r of rows) {
      if (r.dueAtMs > nowMs) continue;
      await this.d.approvals.setStatus({ approvalId: r.approvalId, status: 'EXPIRED', closeReason: 'EXPIRED', nowMs });
      const c = await this.d.store.getCase(r.caseId);
      if (c) await this.#closeAction(c, c.events.some((e) => e.kind === 'ACTION_EXECUTED') ? 'ACTIONED' : 'INVESTIGATING', 'EXPIRED', null, c.status !== 'ACTIONED');
      n += 1;
    }
    const cases = await this.d.store.listCases({ limit: 1000 });
    for (const c of cases.items) {
      for (const m of active(c)) {
        if (m.lockExpiresAtMs === null) continue;
        const schedule = await this.#schedule(c.eventId);
        const entryOpensAtMs = schedule?.entryOpensAtMs ?? null;
        if (nowMs < m.lockExpiresAtMs && (entryOpensAtMs === null || nowMs < entryOpensAtMs)) continue;
        const key = `${c.caseId}:${m.accountId}`;
        if (this.#copied.has(key)) continue;
        this.#copied.add(key);
        await this.d.copies?.set({
          caseId: c.caseId,
          eventId: c.eventId,
          accountId: m.accountId,
          version: c.version,
          lockActive: false,
          objectionDueAtMs: m.actionNotifiedAtMs === undefined || m.actionNotifiedAtMs === null ? null : m.actionNotifiedAtMs + OBJECTION_WINDOW_MS,
          actionResult: null,
        });
      }
    }
    return n;
  }

  async notifyDeadlines(nowMs: number): Promise<number> {
    let n = 0;
    const rows = await this.d.approvals.list({ status: openStatuses, limit: 1000 });
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
      await this.d.store.updateCase({ ...c, version: c.version + 1 }, c.version, [{ seq, kind: 'CANCEL_DEADLINE_NOTICE', actorId: null, note: null, detail: { approvalId: r.approvalId, leadMs: wants }, occurredAtMs: nowMs }], {});
      n += 1;
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
      await this.d.store.updateCase(r.next, c.version, r.events, {});
      n += 1;
    }
    return n;
  }

  #domain<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      throw asBareProblem(e);
    }
  }

  async #appendEvent(c: FraudCaseRecord, kind: FraudCaseEventRecord['kind'], detail: Record<string, unknown>, actorId: string): Promise<void> {
    const seq = (c.events.at(-1)?.seq ?? 0) + 1;
    await this.d.store.updateCase({ ...c, version: c.version + 1 }, c.version, [{ seq, kind: kind as FraudCaseEventRecord['kind'], actorId, note: null, detail, occurredAtMs: this.d.now() }], {});
  }

  async #actioned(c: FraudCaseRecord, accounts: readonly string[], actorId: string, detail: Record<string, unknown>): Promise<FraudCaseRecord> {
    const next = clone(c);
    next.status = 'ACTIONED';
    next.outcomeLabel = 'BOT';
    next.version = c.version + 1;
    for (const m of next.members) if (accounts.includes(m.accountId)) m.actionNotifiedAtMs = this.d.now();
    const seq = (c.events.at(-1)?.seq ?? 0) + 1;
    next.events = [...c.events, { seq, kind: 'ACTION_EXECUTED', actorId, note: null, detail, occurredAtMs: this.d.now() }];
    await this.d.store.updateCase(next, c.version, next.events.slice(c.events.length), {});
    return next;
  }

  async #closeAction(c: FraudCaseRecord, status: FraudCaseRecord['status'], reason: string, actorId: string | null, release: boolean): Promise<void> {
    const next = clone(c);
    next.status = status;
    next.version = c.version + 1;
    const seq = (c.events.at(-1)?.seq ?? 0) + 1;
    next.events = [...c.events, { seq, kind: 'ACTION_CLOSED', actorId, note: null, detail: { reason }, occurredAtMs: this.d.now() }];
    if (release) await this.#release(c.caseId, c.eventId, active(c).map((m) => m.accountId), actorId ?? c.assigneeId, 'ACTION_CLOSED');
    await this.d.store.updateCase(next, c.version, next.events.slice(c.events.length), {});
  }

  async #releaseForDone(caseId: string, eventId: string, accounts: readonly string[], actorId: string): Promise<void> {
    if (accounts.length > 0) await this.#release(caseId, eventId, accounts, actorId, 'ACTION_DONE');
  }

  async #release(caseId: string, eventId: string, accounts: readonly string[], actorId: string, releaseReason: string): Promise<void> {
    if (accounts.length === 0) return;
    let version: number;
    try {
      version = await this.d.store.nextLockVersion();
    } catch {
      return;
    }
    await this.d.locks.release({ caseId, eventId, accountIds: accounts, version, actedBy: actorId, releaseReason });
  }

  async #reversalPriority(c: FraudCaseRecord, accounts: readonly string[], actorId: string): Promise<readonly Record<string, unknown>[]> {
    if (!this.d.priority) return [];
    const all: Record<string, unknown>[] = [];
    for (const e of c.events.filter((x) => x.kind === 'ACTION_EXECUTED')) {
      const results = Array.isArray(e.detail?.results) ? (e.detail!.results as any[]) : [];
      for (const a of accounts) {
        const ids = results.filter((r) => r.outcome === 'ACCEPTED' && c.members.some((m) => m.accountId === a)).map((r) => r.ticketId);
        if (ids.length === 0) continue;
        const out = await this.d.priority.run({ caseId: c.caseId, accountId: a, eventId: c.eventId, cancelledTicketIds: ids, cancelledTicketId: ids[0]!, decision: 'ACCEPTED', actedBy: actorId });
        all.push(...out.grants);
        break;
      }
      break;
    }
    return all;
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
    try {
      return (await this.d.approverIdentity?.designations(accountId)) ?? [];
    } catch {
      return [];
    }
  }

  async #recentRevocations(accountId: string): Promise<readonly { kind: string; revokedAtMs: number }[]> {
    try {
      return (await this.d.approverIdentity?.recentlyRevoked(accountId)) ?? [];
    } catch {
      return [];
    }
  }

  #approvalView(r: FraudApprovalRecord, c: FraudCaseRecord): Record<string, unknown> {
    const targets = r.accountIds.map((accountId) => ({
      accountId,
      ticketIds: r.targets.filter((t) => t.payerAccountId === accountId).map((t) => t.ticketId),
      holderTicketIds: r.targets.filter((t) => t.payerAccountId === accountId && t.holderAccountId !== accountId).map((t) => t.ticketId),
      appealOutcome: c.members.find((m) => m.accountId === accountId)?.appealResult ?? 'NOT_REQUESTED',
    }));
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
        purchaseCount: active(c).reduce((n, m) => n + m.ticketCount, 0),
        limitPerPerson: 4,
        scoreBand: 'HIGH',
        signals: [...new Set(active(c).flatMap((m) => m.signals))],
        appealOutcome: 'REJECTED',
        investigatorOpinion: c.investigatorOpinion,
        cancelDeadlineAt: iso(c.cancelDeadlineAtMs),
        targets,
      },
    };
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
      appealOutcome: 'REJECTED',
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

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const authAllAccepted = (c: FraudCaseRecord): boolean => {
  const actioned = active(c).filter((m) => m.actionNotifiedAtMs !== undefined && m.actionNotifiedAtMs !== null);
  return actioned.length > 0 && actioned.every((m) => m.objectionResult === 'ACCEPTED');
};
