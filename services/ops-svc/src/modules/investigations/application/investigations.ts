// F-04-12 조사 응용 서비스. 권한·사건·소명 요청·후보 조회·다시 돌리기를 한곳에서 처리한다.
import { randomUUID } from 'node:crypto';
import { parseIfMatch, type AdminIdentity } from '../../admin-accounts/index.js';
import type { SaleScheduleSource } from '../../readiness/index.js';
import {
  addMembers,
  autoRetriesLeftOf,
  assertAppealDue,
  assertInvestigator,
  decideAppeals,
  defaultAppealDueAt,
  lockExpiryOf,
  problem,
  removeMembers,
  rerunDecision,
  type FraudCaseRecord,
  type FraudClusterRecord,
  type FraudRunRecord,
  type FraudSnapshotRecord,
} from '../domain/investigation.js';
import type {
  FraudAlerts,
  FraudForensicsRunner,
  FraudLabels,
  FraudNotifier,
  FraudOpsEventSink,
  InvestigationAccessLog,
  InvestigationStore,
  SnapshotVerifier,
  TransferLocks,
} from '../domain/ports.js';

export interface FraudActor {
  readonly accountId: string;
  readonly role: string;
}

export interface InvestigationsDeps {
  readonly store: InvestigationStore;
  readonly identity: Pick<AdminIdentity, 'designations'>;
  readonly schedule: SaleScheduleSource;
  readonly locks: TransferLocks;
  readonly notifier: FraudNotifier;
  readonly labels: FraudLabels;
  readonly alerts: FraudAlerts;
  readonly access: InvestigationAccessLog;
  readonly events: FraudOpsEventSink;
  readonly verifier: SnapshotVerifier;
  readonly now: () => number;
  readonly audit?: { append(r: { recordType: string; recordId: string; payload: Record<string, unknown>; nowMs: number }): Promise<void> };
  readonly runner?: FraudForensicsRunner;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const etag = (version: number): string => `"${version}"`;
const activeMembers = (c: FraudCaseRecord) => c.members.filter((m) => m.removedAtMs === null);
const caseTicketCount = (c: FraudCaseRecord): number => activeMembers(c).reduce((n, m) => n + m.ticketCount, 0);

export { etag };

export class Investigations {
  readonly #idempotent = new Map<string, unknown>();
  constructor(private readonly d: InvestigationsDeps) {}

  async #record(
    actor: FraudActor,
    action: string,
    ids: { eventId?: string; caseId?: string; clusterId?: string },
    outcome: 'ALLOWED' | 'DENIED',
    rows?: number,
  ): Promise<void> {
    const line = {
      accountId: actor.accountId,
      role: actor.role,
      action,
      ...(ids.eventId ? { eventId: ids.eventId } : {}),
      ...(ids.caseId ? { caseId: ids.caseId } : {}),
      ...(ids.clusterId ? { clusterId: ids.clusterId } : {}),
      ...(rows !== undefined ? { rows } : {}),
      outcome,
    };
    await this.d.access.record(line);
    if (this.d.audit) {
      await this.d.audit.append({
        recordType: 'ADMIN_DATA_ACCESS',
        recordId: ids.caseId ?? ids.clusterId ?? ids.eventId ?? 'fraud-investigations',
        payload: line,
        nowMs: this.d.now(),
      });
    }
  }

  /** 지정 확인은 요청마다 identity에 묻는다(캐시 없음). 거절도 접속기록에 남긴다. */
  async authorize(actor: FraudActor, action: string, ids: { eventId?: string; caseId?: string; clusterId?: string }): Promise<void> {
    let allowed = false;
    if (actor.role === 'commander' || actor.role === 'cs_lead') {
      try {
        const designations = await this.d.identity.designations(actor.accountId);
        allowed = designations.includes('FRAUD_INVESTIGATOR') && !designations.includes('PSEUDONYM_HANDLER');
      } catch {
        await this.#record(actor, action, ids, 'DENIED');
        throw problem('authz-unavailable', 503, 'identity 지정을 확인하지 못했습니다');
      }
    }
    if (!allowed) {
      await this.#record(actor, action, ids, 'DENIED');
      assertInvestigator([]);
    }
  }

  async allow(actor: FraudActor, action: string, ids: { eventId?: string; caseId?: string; clusterId?: string }, rows: number): Promise<void> {
    await this.#record(actor, action, ids, 'ALLOWED', rows);
  }

  async #schedule(eventId: string) {
    const schedule = await this.d.schedule.get(eventId);
    if (!schedule) throw problem('not-found', 404, '회차를 찾을 수 없습니다');
    return schedule;
  }

  #sourceExpiresAt(schedule: { saleEndsAtMs: number }): number {
    return schedule.saleEndsAtMs + 31 * 86_400_000;
  }
  #cancelDeadlineAt(schedule: { saleEndsAtMs: number }): number {
    return schedule.saleEndsAtMs - 2 * 3_600_000;
  }
  #showStartsAt(schedule: { saleEndsAtMs: number }): number {
    return schedule.saleEndsAtMs + 24 * 3_600_000;
  }

  snapshotView(s: FraudSnapshotRecord | null): Record<string, unknown> | null {
    return s ? { version: s.version, frozenAt: iso(s.frozenAtMs), invHash: s.invHash, late: s.late } : null;
  }

  runView(r: FraudRunRecord | null): Record<string, unknown> | null {
    if (!r) return null;
    return {
      generation: r.generation,
      snapshotVersion: r.snapshotVersion,
      ruleVersion: r.ruleVersion,
      status: r.status,
      attempt: r.attempt,
      trigger: r.trigger,
      failureReason: r.failureReason,
      startedAt: iso(r.startedAtMs),
      finishedAt: iso(r.finishedAtMs),
      clusterCount: r.clusterCount,
      autoRetriesLeft: autoRetriesLeftOf(r),
    };
  }

  memberView(m: FraudCaseRecord['members'][number], nowMs: number): Record<string, unknown> {
    return {
      accountId: m.accountId,
      ticketCount: m.ticketCount,
      signals: m.signals,
      addedBy: m.addedBy,
      removed: m.removedAtMs !== null,
      appealResult: m.appealResult,
      appealDueAt: iso(m.appealDueAtMs),
      objectionResult: m.objectionResult ?? 'NONE',
      objectionDueAt: null,
      transferLocked: m.lockExpiresAtMs !== null && m.lockExpiresAtMs > nowMs,
      lockExpiresAt: iso(m.lockExpiresAtMs),
    };
  }

  caseView(c: FraudCaseRecord, nowMs: number, snapshot?: FraudSnapshotRecord | null): Record<string, unknown> {
    const active = activeMembers(c);
    const results = active.map((m) => m.appealResult);
    let appealOutcome = 'NOT_REQUESTED';
    if (results.length > 0) {
      if (results.every((r) => r === 'ACCEPTED')) appealOutcome = 'ACCEPTED';
      else if (results.every((r) => r === 'REJECTED' || r === 'EXPIRED')) appealOutcome = 'REJECTED';
      else if (results.every((r) => r === 'NOT_REQUESTED')) appealOutcome = 'NOT_REQUESTED';
      else if (results.every((r) => r === 'PENDING' || r === 'SUBMITTED')) appealOutcome = 'PENDING';
      else appealOutcome = 'PARTIAL';
    }
    return {
      caseId: c.caseId,
      eventId: c.eventId,
      clusterId: c.clusterId,
      status: c.status,
      reasonCategory: c.reasonCategory,
      assigneeId: c.assigneeId,
      accountCount: active.length,
      ticketCount: caseTicketCount(c),
      appealDueAt: iso(c.appealDueAtMs),
      cancelDeadlineAt: iso(c.cancelDeadlineAtMs),
      transferLocked: active.some((m) => m.lockExpiresAtMs !== null && m.lockExpiresAtMs > nowMs),
      approvalId: c.approvalId,
      version: c.version,
      createdAt: iso(c.createdAtMs),
      closedAt: iso(c.closedAtMs),
      members: c.members.map((m) => this.memberView(m, nowMs)),
      appealOutcome,
      investigatorOpinion: c.investigatorOpinion,
      evidenceBundleIds: [],
      events: c.events.map((e) => ({ seq: e.seq, kind: e.kind, actorId: e.actorId, note: e.note, detail: e.detail, occurredAt: iso(e.occurredAtMs) })),
      ...(snapshot ? { snapshot: this.snapshotView(snapshot)! } : {}),
    };
  }

  async overview(actor: FraudActor, eventId: string): Promise<Record<string, unknown>> {
    await this.authorize(actor, 'FRAUD_OVERVIEW', { eventId });
    const schedule = await this.#schedule(eventId);
    const [snapshot, run, counts, cases] = await Promise.all([
      this.d.store.latestSnapshot(eventId),
      this.d.store.latestRun(eventId),
      this.d.store.countCases(eventId),
      this.d.store.listCases({ eventId, limit: 1000 }),
    ]);
    let accepted = 0;
    let judged = 0;
    for (const c of cases.items) {
      for (const m of c.members) {
        if (m.appealResult === 'ACCEPTED') accepted += 1;
        if (m.appealResult === 'ACCEPTED' || m.appealResult === 'REJECTED') judged += 1;
      }
    }
    const nowMs = this.d.now();
    const sourceExpiresAtMs = this.#sourceExpiresAt(schedule);
    const out = {
      eventId,
      snapshot: this.snapshotView(snapshot),
      latestRun: this.runView(run),
      rerunAllowed: run?.status === 'FAILED' && autoRetriesLeftOf(run) === 0 && nowMs < sourceExpiresAtMs,
      summary: {
        clusterCount: run?.clusterCount ?? 0,
        caseCount: counts.total,
        byStatus: counts.byStatus,
        actionedTicketCount: 0,
        restrictedAccountCount: 0,
        appealAcceptedRatio: judged === 0 ? null : accepted / judged,
      },
      cancelDeadlineAt: iso(this.#cancelDeadlineAt(schedule)),
      sourceExpiresAt: iso(sourceExpiresAtMs),
    };
    await this.allow(actor, 'FRAUD_OVERVIEW', { eventId }, counts.total);
    return out;
  }

  async listClusters(
    actor: FraudActor,
    q: { eventId: string; sort: 'SCORE_DESC' | 'PURCHASE_RATIO_DESC' | 'LATEST'; cursor?: string; limit: number },
  ): Promise<Record<string, unknown>> {
    await this.authorize(actor, 'FRAUD_CLUSTER_LIST', { eventId: q.eventId });
    const lastRun = await this.d.store.latestRun(q.eventId);
    const generation = lastRun?.generation ?? 1;
    const page = await this.d.store.listClusters({ ...q, generation });
    const items = await Promise.all(
      page.items.map(async (c) => {
        const found = await this.d.store.findCaseByCluster(c.clusterId);
        return this.clusterView(c, found?.caseId ?? null);
      }),
    );
    await this.allow(actor, 'FRAUD_CLUSTER_LIST', { eventId: q.eventId }, items.length);
    return { items, nextCursor: page.nextCursor };
  }

  clusterView(c: FraudClusterRecord, caseId: string | null): Record<string, unknown> {
    return {
      clusterId: c.clusterId,
      eventId: c.eventId,
      generation: c.generation,
      scoreBand: c.scoreBand,
      accountCount: c.accountCount,
      purchaseCount: c.purchaseCount,
      limitPerPerson: c.limitPerPerson,
      sharedAttributes: c.sharedAttributes,
      signals: c.signals,
      caseId,
      createdAt: iso(c.createdAtMs),
      members: c.members.map((m) => ({
        accountId: m.accountId,
        ticketCount: m.ticketCount,
        signals: m.signals,
        addedBy: m.addedBy,
        removed: m.removedAtMs !== null,
        appealResult: m.appealResult,
        appealDueAt: iso(m.appealDueAtMs),
        objectionResult: m.objectionResult ?? 'NONE',
        objectionDueAt: null,
        transferLocked: m.lockExpiresAtMs !== null && m.lockExpiresAtMs > this.d.now(),
        lockExpiresAt: iso(m.lockExpiresAtMs),
      })),
    };
  }

  async getCluster(actor: FraudActor, clusterId: string): Promise<Record<string, unknown>> {
    await this.authorize(actor, 'FRAUD_CLUSTER_GET', { clusterId });
    const c = await this.d.store.getCluster(clusterId);
    if (!c) throw problem('not-found', 404, '후보 묶음을 찾을 수 없습니다');
    const found = await this.d.store.findCaseByCluster(clusterId);
    const out = this.clusterView(c, found?.caseId ?? null);
    await this.allow(actor, 'FRAUD_CLUSTER_GET', { clusterId }, c.accountCount);
    return out;
  }

  async createCase(
    actor: FraudActor,
    body: { clusterId: string; reasonCategory?: string },
    idemKey?: string,
  ): Promise<{ view: Record<string, unknown>; location: string }> {
    const replayKey = idemKey ? `CASE:${idemKey}` : undefined;
    if (replayKey) {
      const cached = this.#idempotent.get(replayKey);
      if (cached) return cached as { view: Record<string, unknown>; location: string };
    }
    await this.authorize(actor, 'FRAUD_CASE_CREATE', { clusterId: body.clusterId });
    const cluster = await this.d.store.getCluster(body.clusterId);
    if (!cluster) throw problem('not-found', 404, '후보 묶음을 찾을 수 없습니다');
    const existing = await this.d.store.findCaseByCluster(body.clusterId);
    if (existing) throw problem('fraud-case-exists', 409, '이 묶음으로 만든 사건이 이미 있습니다');
    const schedule = await this.#schedule(cluster.eventId);
    const nowMs = this.d.now();
    const caseId = randomUUID();
    const members = cluster.members.map((m) => ({
      ...m,
      addedBy: 'SYSTEM' as const,
      appealResult: 'NOT_REQUESTED' as const,
      appealDueAtMs: null,
      lockExpiresAtMs: null,
    }));
    const created: FraudCaseRecord = {
      caseId,
      eventId: cluster.eventId,
      clusterId: cluster.clusterId,
      status: 'INVESTIGATING',
      reasonCategory: (body.reasonCategory ?? 'MACRO_BOT') as FraudCaseRecord['reasonCategory'],
      assigneeId: actor.accountId,
      cancelDeadlineAtMs: this.#cancelDeadlineAt(schedule),
      appealDueAtMs: null,
      approvalId: null,
      investigatorOpinion: null,
      outcomeLabel: null,
      version: 1,
      createdAtMs: nowMs,
      closedAtMs: null,
      members,
      events: [{ seq: 1, kind: 'CREATED', actorId: actor.accountId, note: null, detail: { reasonCategory: body.reasonCategory ?? 'MACRO_BOT' }, occurredAtMs: nowMs }],
    };
    try {
      await this.d.store.putCase(created);
    } catch {
      throw problem('fraud-case-exists', 409, '이 묶음으로 만든 사건이 이미 있습니다');
    }
    const snapshot = await this.d.store.latestSnapshot(cluster.eventId);
    await this.allow(actor, 'FRAUD_CASE_CREATE', { caseId, eventId: cluster.eventId }, members.length);
    const result = { view: this.caseView(created, nowMs, snapshot), location: `/v1/ops/fraud-cases/${caseId}` };
    if (replayKey) this.#idempotent.set(replayKey, result);
    return result;
  }

  async listCases(
    actor: FraudActor,
    q: { eventId?: string; status?: readonly FraudCaseRecord['status'][]; cursor?: string; limit: number },
  ): Promise<Record<string, unknown>> {
    await this.authorize(actor, 'FRAUD_CASE_LIST', q.eventId ? { eventId: q.eventId } : {});
    const page = await this.d.store.listCases(q);
    const items = page.items.map((c) => this.caseView(c, this.d.now()));
    await this.allow(actor, 'FRAUD_CASE_LIST', q.eventId ? { eventId: q.eventId } : {}, items.length);
    return { items, nextCursor: page.nextCursor };
  }

  async getCase(actor: FraudActor, caseId: string): Promise<{ view: Record<string, unknown>; version: number }> {
    await this.authorize(actor, 'FRAUD_CASE_GET', { caseId });
    const c = await this.d.store.getCase(caseId);
    if (!c) throw problem('not-found', 404, '사건을 찾을 수 없습니다');
    const snapshot = await this.d.store.latestSnapshot(c.eventId);
    await this.allow(actor, 'FRAUD_CASE_GET', { caseId }, c.members.length);
    return { view: this.caseView(c, this.d.now(), snapshot), version: c.version };
  }

  async patchCase(
    actor: FraudActor,
    caseId: string,
    ifMatch: string | undefined,
    body: {
      addMembers?: { accountId: string; reason: string }[];
      removeMembers?: { accountId: string; reason: string }[];
      reasonCategory?: FraudCaseRecord['reasonCategory'];
      note?: string;
      investigatorOpinion?: string;
      appealDecisions?: { accountId: string; decision: 'ACCEPTED' | 'REJECTED'; reason: string }[];
      objectionDecisions?: { accountId: string; decision: 'ACCEPTED' | 'REJECTED'; reason: string }[];
    },
  ): Promise<{ view: Record<string, unknown>; version: number }> {
    await this.authorize(actor, 'FRAUD_CASE_PATCH', { caseId });
    const current = await this.d.store.getCase(caseId);
    if (!current) throw problem('not-found', 404, '사건을 찾을 수 없습니다');
    const version = parseIfMatch(ifMatch);
    if (version === null) throw problem('precondition-required', 428, '고칠 판(If-Match)을 보내 주세요');
    if (version !== current.version) throw problem('precondition-failed', 412, '다른 곳에서 이 사건을 먼저 고쳤습니다');
    const nowMs = this.d.now();
    let next = current;
    const events: FraudCaseRecord['events'] = [];
    const lockReleases: string[] = [];
    let label: 'HUMAN' | null = null;
    const withActor = (list: FraudCaseRecord['events']) => list.map((e) => ({ ...e, actorId: actor.accountId }));
    if (body.removeMembers && body.removeMembers.length > 0) {
      const r = removeMembers({ case: next, removals: body.removeMembers, nowMs });
      next = { ...r.next, events: [...r.next.events, ...withActor(r.events)] };
      events.push(...withActor(r.events));
      lockReleases.push(...r.lockReleases);
      if (r.next.outcomeLabel === 'HUMAN') label = 'HUMAN';
    }
    if (body.addMembers && body.addMembers.length > 0) {
      const r = addMembers({ case: next, adds: body.addMembers, nowMs });
      next = { ...r.next, events: [...r.next.events, ...withActor(r.events)] };
      events.push(...withActor(r.events));
    }
    if (body.note !== undefined) {
      const seq = (next.events.at(-1)?.seq ?? 0) + 1;
      events.push({ seq, kind: 'NOTE', actorId: actor.accountId, note: body.note, detail: { note: body.note }, occurredAtMs: nowMs });
      next = { ...next, events: [...next.events, ...events.slice(-1)] };
    }
    if (body.investigatorOpinion !== undefined) next = { ...next, investigatorOpinion: body.investigatorOpinion };
    if (body.reasonCategory !== undefined) next = { ...next, reasonCategory: body.reasonCategory };
    if (body.appealDecisions && body.appealDecisions.length > 0) {
      const r = decideAppeals({ case: next, decisions: body.appealDecisions, nowMs });
      next = { ...r.next, events: [...r.next.events, ...withActor(r.events)] };
      events.push(...withActor(r.events));
      lockReleases.push(...r.lockReleases);
      if (r.outcomeLabel === 'HUMAN') label = 'HUMAN';
    }
    if (events.length === 0 && body.investigatorOpinion === undefined && body.reasonCategory === undefined) {
      throw problem('invalid-body', 400, '고칠 칸이 없습니다');
    }
    if (body.investigatorOpinion !== undefined || body.reasonCategory !== undefined) {
      next = { ...next, version: current.version + 1 };
    }
    if (next.version === current.version) next = { ...next, version: current.version + 1 };
    const ok = await this.d.store.updateCase({ ...next, events: current.events }, current.version, events);
    if (!ok) throw problem('precondition-failed', 412, '다른 곳에서 이 사건을 먼저 고쳤습니다');
    if (lockReleases.length > 0) await this.d.locks.release({ caseId, eventId: current.eventId, accountIds: [...new Set(lockReleases)], version: next.version, actedBy: actor.accountId });
    if (label) await this.d.labels.apply({ eventId: current.eventId, caseId, accountIds: [...new Set(lockReleases)], label });
    const saved = await this.d.store.getCase(caseId);
    const out = saved ?? next;
    const snapshot = await this.d.store.latestSnapshot(out.eventId);
    await this.allow(actor, 'FRAUD_CASE_PATCH', { caseId }, out.members.length);
    return { view: this.caseView(out, nowMs, snapshot), version: out.version };
  }

  async appeal(
    actor: FraudActor,
    caseId: string,
    idemKey: string,
    body: { accountIds: string[]; reasonCategories: FraudCaseRecord['reasonCategory'][]; dueAt: string },
  ): Promise<Record<string, unknown>> {
    const replayKey = `APPEAL:${idemKey}`;
    const cached = this.#idempotent.get(replayKey);
    if (cached) return cached as Record<string, unknown>;
    await this.authorize(actor, 'FRAUD_CASE_APPEAL', { caseId });
    const current = await this.d.store.getCase(caseId);
    if (!current) throw problem('not-found', 404, '사건을 찾을 수 없습니다');
    const schedule = await this.#schedule(current.eventId);
    const nowMs = this.d.now();
    const dueAtMs = Date.parse(body.dueAt);
    assertAppealDue({ nowMs, dueAtMs, showStartsAtMs: this.#showStartsAt(schedule), entryOpensAtMs: schedule.entryOpensAtMs });
    const targets = body.accountIds.map((id) => current.members.find((m) => m.accountId === id && m.removedAtMs === null));
    if (targets.some((m) => !m)) throw problem('appeal-target-invalid', 422, '사건에 없는 계정이 있습니다');
    if (current.status !== 'INVESTIGATING') {
      if (current.status !== 'APPEAL_PENDING') throw problem('fraud-case-state', 409, '소명을 요청할 수 없는 사건 상태입니다');
      if (targets.some((m) => m!.addedBy !== 'INVESTIGATOR' || m!.appealResult !== 'NOT_REQUESTED')) {
        throw problem('fraud-case-state', 409, '이미 소명을 요청한 계정입니다');
      }
    }
    const firstLocked = targets.filter((m) => m!.lockExpiresAtMs === null).map((m) => m!.accountId);
    const lockExpiresAtMs = nowMs + 14 * 86_400_000;
    let lockResult: Awaited<ReturnType<TransferLocks['set']>>;
    try {
      lockResult = await this.d.locks.set({
        caseId,
        eventId: current.eventId,
        accountIds: body.accountIds,
        version: current.version,
        expiresAtMs: lockExpiresAtMs,
        actedBy: actor.accountId,
      });
    } catch {
      throw problem('dependency-unavailable', 503, '양도 잠금을 걸지 못했습니다');
    }
    const caseAccounts = new Set(current.members.map((m) => m.accountId));
    const holders = new Map<string, string[]>();
    for (const h of lockResult.holders) {
      if (caseAccounts.has(h.accountId)) continue;
      const list = holders.get(h.accountId) ?? [];
      for (const t of h.ticketIds) if (!list.includes(t)) list.push(t);
      holders.set(h.accountId, list);
    }
    for (const [accountId, ticketIds] of holders) {
      await this.d.notifier.holderNotice({ eventId: current.eventId, caseId, accountId, ticketIds, dueAtMs });
    }
    const nextMembers = current.members.map((m) => {
      if (!body.accountIds.includes(m.accountId)) return m;
      return {
        ...m,
        appealResult: 'PENDING' as const,
        appealDueAtMs: dueAtMs,
        lockExpiresAtMs: lockExpiryOf({ existingLockExpiresAtMs: m.lockExpiresAtMs, nowMs }),
        appealReasonCategories: [...body.reasonCategories],
        appealRequestedAtMs: nowMs,
      };
    });
    const seq = (current.events.at(-1)?.seq ?? 0) + 1;
    const events: FraudCaseRecord['events'] = [
      {
        seq,
        kind: 'APPEAL_REQUESTED',
        actorId: actor.accountId,
        note: null,
        detail: { accountIds: body.accountIds, reasonCategories: body.reasonCategories, dueAt: iso(dueAtMs), lockExpiresAt: iso(lockExpiresAtMs), notifiedHolderCount: holders.size },
        occurredAtMs: nowMs,
      },
      {
        seq: seq + 1,
        kind: 'LOCK_APPLIED',
        actorId: actor.accountId,
        note: null,
        detail: { accountIds: body.accountIds, expiresAt: iso(lockExpiresAtMs), version: current.version },
        occurredAtMs: nowMs,
      },
    ];
    const next: FraudCaseRecord = {
      ...current,
      status: 'APPEAL_PENDING',
      appealDueAtMs: dueAtMs,
      version: current.version + 1,
      members: nextMembers,
      events: [...current.events, ...events],
    };
    try {
      const ok = await this.d.store.updateCase({ ...next, events: current.events }, current.version, events);
      if (!ok) throw new Error('version');
    } catch {
      try {
        await this.d.locks.release({ caseId, eventId: current.eventId, accountIds: body.accountIds, version: current.version + 1, actedBy: actor.accountId });
      } catch {
        // 보상 실패는 삼키지 않고 503으로 알린다
      }
      throw problem('dependency-unavailable', 503, '사건을 저장하지 못했습니다');
    }
    await this.allow(actor, 'FRAUD_CASE_APPEAL', { caseId }, body.accountIds.length);
    const result = {
      appealRequestId: idemKey,
      caseId,
      accountIds: body.accountIds,
      dueAt: iso(dueAtMs),
      lockedTicketCount: lockResult.lockedTicketCount,
      withdrawnOfferCount: lockResult.withdrawnOfferCount,
      lockExpiresAt: firstLocked.length > 0 ? iso(lockExpiresAtMs) : null,
      notifiedHolderCount: holders.size,
    };
    this.#idempotent.set(replayKey, result);
    return result;
  }

  async rerun(actor: FraudActor, eventId: string): Promise<Record<string, unknown>> {
    await this.authorize(actor, 'FRAUD_CLUSTER_RERUN', { eventId });
    const schedule = await this.#schedule(eventId);
    const last = await this.d.store.latestRun(eventId);
    const decision = rerunDecision({ last, nowMs: this.d.now(), sourceExpiresAtMs: this.#sourceExpiresAt(schedule) });
    if (!decision.allowed) throw problem(decision.type, decision.status, decision.type);
    const nowMs = this.d.now();
    const run: FraudRunRecord = {
      eventId,
      generation: decision.generation,
      attempt: decision.attempt,
      trigger: 'MANUAL',
      snapshotVersion: last!.snapshotVersion,
      ruleVersion: last!.ruleVersion,
      status: 'RUNNING',
      failureReason: null,
      resultFingerprint: null,
      clusterCount: null,
      startedAtMs: nowMs,
      finishedAtMs: null,
    };
    await this.d.store.putRun(run);
    this.d.events.emit({
      opsEvent: 'FRAUD_CLUSTER_RUN',
      stage: 'STARTED',
      eventId,
      generation: run.generation,
      attempt: run.attempt,
      trigger: 'MANUAL',
      result: 'STARTED',
    });
    await this.allow(actor, 'FRAUD_CLUSTER_RERUN', { eventId }, 1);
    return this.runView(run)!;
  }
}
