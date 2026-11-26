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
  LOCK_MAX_MS,
  lockExpiryOf,
  problem,
  removeMembers,
  rerunDecision,
  type FraudCaseRecord,
  type FraudClusterRecord,
  type FraudRunRecord,
  type FraudSnapshotRecord,
} from '../domain/investigation.js';
import { CaseAlreadyExistsError, type CaseAuditRecord, type IdempotentWrite } from '../domain/ports.js';
import type {
  FraudAlerts,
  FraudAppealCopies,
  FraudForensicsRunner,
  FraudGraphSource,
  FraudGraphView,
  FraudLabels,
  FraudNotifier,
  FraudOpsEventSink,
  FraudTicketDirectory,
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
  readonly fraud?: import('./fraud-actions.js').FraudActions;
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
  /** F-04-15 소명 화면용 사본. 없으면 사본을 쓰지 않는다 */
  readonly copies?: FraudAppealCopies;
  /** F-04-15 결제자별 잠긴 표를 사본에 싣기 위한 티켓 조회 */
  readonly tickets?: Pick<FraudTicketDirectory, 'listForAction'>;
  /** F-04-15 사건 상세 evidenceBundleIds. 없으면 빈 목록 */
  readonly evidence?: { listBundleIds(eventId: string, caseId: string): Promise<readonly string[]> };
  /** SCR-071 연결 그래프·IP 원문(IR-01). 없으면 빈 그래프이고 IP 원문은 열 수 없다. */
  readonly graph?: FraudGraphSource;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

const HOUR_MS = 3_600_000;
const copyStateOf = (r: string): 'OPEN' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' =>
  r === 'ACCEPTED' || r === 'REJECTED' || r === 'EXPIRED' ? r : r === 'SUBMITTED' ? 'SUBMITTED' : 'OPEN';

/** 사건 기록의 마지막 조치 실행에서 이 계정(결제자/받는 사람)의 취소 표를 뽑는다. */
function actionResultOf(c: FraudCaseRecord, accountId: string, party: 'payer' | 'holder'): { cancelledTicketIds: string[] } | null {
  for (const e of [...c.events].reverse()) {
    if (e.kind !== 'ACTION_EXECUTED' || !e.detail) continue;
    const results = Array.isArray(e.detail.results) ? (e.detail.results as { ticketId?: string; outcome?: string }[]) : [];
    const targets = Array.isArray(e.detail.targets) ? (e.detail.targets as { ticketId?: string; payerAccountId?: string; holderAccountId?: string }[]) : [];
    const ids = results
      .filter((x) => x.outcome === 'ACCEPTED')
      .map((x) => targets.find((t) => t.ticketId === x.ticketId))
      .filter((t): t is { ticketId?: string; payerAccountId?: string; holderAccountId?: string } => t !== undefined && (party === 'payer' ? t.payerAccountId === accountId : t.holderAccountId === accountId))
      .map((t) => t.ticketId)
      .filter((x): x is string => typeof x === 'string');
    if (ids.length > 0) return { cancelledTicketIds: [...new Set(ids)] };
  }
  return null;
}

function excludedForHolder(c: FraudCaseRecord, holderId: string): string[] {
  for (const e of [...c.events].reverse()) {
    if (e.kind !== 'ACTION_EXECUTED' || !e.detail) continue;
    const results = Array.isArray(e.detail.results) ? (e.detail.results as { ticketId?: string; outcome?: string }[]) : [];
    const targets = Array.isArray(e.detail.targets) ? (e.detail.targets as { ticketId?: string; holderAccountId?: string }[]) : [];
    return targets
      .filter((t) => t.holderAccountId === holderId)
      .filter((t) => results.find((r) => r.ticketId === t.ticketId)?.outcome !== 'ACCEPTED')
      .map((t) => t.ticketId)
      .filter((x): x is string => typeof x === 'string');
  }
  return [];
}

function priorityOf(c: FraudCaseRecord, accountId: string): Record<string, unknown>[] {
  const granted = [...c.events].reverse().find((e) => e.kind === 'PRIORITY_GRANTED' && e.detail);
  const grants = granted && Array.isArray(granted.detail!.grants) ? (granted.detail!.grants as Record<string, unknown>[]) : [];
  return grants
    .filter((g) => g.accountId === accountId)
    .map((g) => ({
      grantId: String(g.grantId ?? ''),
      seatLabel: String(g.seatLabel ?? g.seatId ?? g.ticketId ?? ''),
      price: Number(g.price ?? 0),
      expiresAtMs: typeof g.expiresAt === 'string' ? Date.parse(g.expiresAt) : Number(g.expiresAtMs ?? 0),
      status: g.status === 'USED' || g.status === 'EXPIRED' || g.status === 'WITHDRAWN' ? g.status : 'OFFERED',
    }));
}

function objectionNoteOf(c: FraudCaseRecord, accountId: string): string | null {
  const decided = [...c.events].reverse().find((e) => e.kind === 'OBJECTION_DECIDED' && e.detail?.accountId === accountId);
  return typeof decided?.detail?.reason === 'string' ? decided.detail.reason : null;
}
const etag = (version: number): string => `"${version}"`;
const activeMembers = (c: FraudCaseRecord) => c.members.filter((m) => m.removedAtMs === null);
const caseTicketCount = (c: FraudCaseRecord): number => activeMembers(c).reduce((n, m) => n + m.ticketCount, 0);
type AccessLine = Parameters<InvestigationAccessLog['record']>[0];
const uniqueViolation = (e: unknown): boolean => {
  const any = e as { code?: unknown; cause?: { code?: unknown } } | undefined;
  return any?.code === '23505' || any?.cause?.code === '23505';
};
const isProblem = (e: unknown): e is { type: string; status: number; message?: string } =>
  e !== null && typeof e === 'object' && 'type' in e && 'status' in e;

export { etag };

export class Investigations {
  constructor(private readonly d: InvestigationsDeps) {}

  #accessLine(
    actor: FraudActor,
    action: string,
    ids: { eventId?: string; caseId?: string; clusterId?: string },
    outcome: 'ALLOWED' | 'DENIED',
    rows?: number,
  ): AccessLine {
    return {
      accountId: actor.accountId,
      role: actor.role,
      action,
      ...(ids.eventId ? { eventId: ids.eventId } : {}),
      ...(ids.caseId ? { caseId: ids.caseId } : {}),
      ...(ids.clusterId ? { clusterId: ids.clusterId } : {}),
      ...(rows !== undefined ? { rows } : {}),
      outcome,
    };
  }

  /** 감사 체인의 record_id는 uuid다. 사건·묶음·회차가 없으면 요청 계정 ID를 쓴다(IR-03) */
  #recordId(actor: FraudActor, ids: { eventId?: string; caseId?: string; clusterId?: string }): string {
    return ids.caseId ?? ids.clusterId ?? ids.eventId ?? actor.accountId;
  }

  #caseAudit(
    actor: FraudActor,
    action: string,
    ids: { eventId?: string; caseId?: string; clusterId?: string },
    rows: number,
  ): CaseAuditRecord {
    return {
      recordType: 'ADMIN_DATA_ACCESS',
      recordId: this.#recordId(actor, ids),
      payload: this.#accessLine(actor, action, ids, 'ALLOWED', rows),
      nowMs: this.d.now(),
    };
  }

  async #record(
    actor: FraudActor,
    action: string,
    ids: { eventId?: string; caseId?: string; clusterId?: string },
    outcome: 'ALLOWED' | 'DENIED',
    rows?: number,
    opts: { audit?: boolean } = {},
  ): Promise<void> {
    const line = this.#accessLine(actor, action, ids, outcome, rows);
    await this.d.access.record(line);
    if (this.d.audit && opts.audit !== false) {
      await this.d.audit.append({
        recordType: 'ADMIN_DATA_ACCESS',
        recordId: this.#recordId(actor, ids),
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

  async allow(
    actor: FraudActor,
    action: string,
    ids: { eventId?: string; caseId?: string; clusterId?: string },
    rows: number,
    opts: { audit?: boolean } = {},
  ): Promise<void> {
    await this.#record(actor, action, ids, 'ALLOWED', rows, opts);
  }

  /** 같은 키의 커밋된 결과를 지정 확인 뒤에 읽는다. 처음 요청이 아직 처리 중이면 409다 */
  async #replay(idem: IdempotentWrite): Promise<unknown | undefined> {
    const found = await this.d.store.findIdempotent(idem);
    if (found.kind === 'reused') throw problem('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
    if (found.kind === 'in_progress') throw problem('idempotency-request-in-progress', 409, '같은 요청을 아직 처리하고 있습니다');
    if (found.kind === 'replay') return found.result;
    return undefined;
  }

  /** 감사 기록을 사건 트랜잭션 밖에서만 남기는 저장소(메모리 판)를 위한 보완 */
  async #auditIfStoreCannot(audit: CaseAuditRecord): Promise<void> {
    if (!this.d.store.auditsWrites && this.d.audit) await this.d.audit.append(audit);
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

  /** 잠금 기한이 남아 있어도 뺀 계정·인정된 소명·정상 종료 사건·입장 시작은 실제로 잠기지 않았다(IR-09·C13) */
  #lockActive(m: FraudCaseRecord['members'][number], caseStatus: FraudCaseRecord['status'] | null, nowMs: number, entryOpensAtMs?: number | null): boolean {
    return m.removedAtMs === null && m.lockExpiresAtMs !== null && m.lockExpiresAtMs > nowMs && (entryOpensAtMs === undefined || entryOpensAtMs === null || nowMs < entryOpensAtMs) && m.appealResult !== 'ACCEPTED' && caseStatus !== 'CLEARED';
  }

  memberView(m: FraudCaseRecord['members'][number], nowMs: number, caseStatus: FraudCaseRecord['status'] | null, entryOpensAtMs?: number | null): Record<string, unknown> {
    return {
      accountId: m.accountId,
      ticketCount: m.ticketCount,
      signals: m.signals,
      addedBy: m.addedBy,
      removed: m.removedAtMs !== null,
      appealResult: m.appealResult,
      appealDueAt: iso(m.appealDueAtMs),
      objectionResult: m.objectionResult ?? 'NONE',
      objectionDueAt: iso(m.actionNotifiedAtMs === undefined || m.actionNotifiedAtMs === null ? null : m.actionNotifiedAtMs + 30 * 86_400_000),
      transferLocked: this.#lockActive(m, caseStatus, nowMs, entryOpensAtMs),
      lockExpiresAt: iso(m.lockExpiresAtMs),
    };
  }

  caseView(c: FraudCaseRecord, nowMs: number, snapshot?: FraudSnapshotRecord | null, entryOpensAtMs?: number | null, evidenceBundleIds: readonly string[] = []): Record<string, unknown> {
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
      transferLocked: active.some((m) => this.#lockActive(m, c.status, nowMs, entryOpensAtMs)),
      approvalId: c.approvalId,
      outcomeLabel: c.outcomeLabel,
      version: c.version,
      createdAt: iso(c.createdAtMs),
      closedAt: iso(c.closedAtMs),
      members: c.members.map((m) => this.memberView(m, nowMs, c.status, entryOpensAtMs)),
      appealOutcome,
      investigatorOpinion: c.investigatorOpinion,
      evidenceBundleIds: [...evidenceBundleIds],
      events: c.events.map((e) => ({ seq: e.seq, kind: e.kind, actorId: e.actorId, note: e.note, detail: e.detail, occurredAt: iso(e.occurredAtMs), occurredAtMs: e.occurredAtMs })),
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
        return this.clusterView(c, found?.caseId ?? null, found?.status ?? null);
      }),
    );
    await this.allow(actor, 'FRAUD_CLUSTER_LIST', { eventId: q.eventId }, items.length);
    return { items, nextCursor: page.nextCursor };
  }

  clusterView(c: FraudClusterRecord, caseId: string | null, caseStatus: FraudCaseRecord['status'] | null): Record<string, unknown> {
    const nowMs = this.d.now();
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
      members: c.members.map((m) => this.memberView(m, nowMs, caseStatus)),
    };
  }

  async getCluster(actor: FraudActor, clusterId: string): Promise<Record<string, unknown>> {
    await this.authorize(actor, 'FRAUD_CLUSTER_GET', { clusterId });
    const c = await this.d.store.getCluster(clusterId);
    if (!c) throw problem('not-found', 404, '후보 묶음을 찾을 수 없습니다');
    const found = await this.d.store.findCaseByCluster(clusterId);
    const out = this.clusterView(c, found?.caseId ?? null, found?.status ?? null);
    await this.allow(actor, 'FRAUD_CLUSTER_GET', { clusterId }, c.accountCount);
    return out;
  }

  async createCase(
    actor: FraudActor,
    body: { clusterId: string; reasonCategory?: string },
    idem?: IdempotentWrite,
  ): Promise<{ view: Record<string, unknown>; location: string }> {
    // 지정 확인이 멱등 재생보다 먼저다(IR-01). 재생도 접속기록·감사를 남긴다
    await this.authorize(actor, 'FRAUD_CASE_CREATE', { clusterId: body.clusterId });
    if (idem) {
      const replay = await this.#replay(idem) as { view: Record<string, unknown>; location: string } | undefined;
      if (replay) {
        const view = replay.view;
        await this.allow(actor, 'FRAUD_CASE_CREATE', { caseId: String(view.caseId), eventId: String(view.eventId) }, Number(view.accountCount ?? 0));
        return replay;
      }
    }
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
    const snapshot = await this.d.store.latestSnapshot(cluster.eventId);
    const result = { view: this.caseView(created, nowMs, snapshot), location: `/v1/ops/fraud-cases/${caseId}` };
    const audit = this.#caseAudit(actor, 'FRAUD_CASE_CREATE', { caseId, eventId: cluster.eventId }, members.length);
    try {
      const write = await this.d.store.putCase(created, { ...(idem ? { idem } : {}), audit, result });
      if (write?.replayed) {
        await this.allow(actor, 'FRAUD_CASE_CREATE', { caseId, eventId: cluster.eventId }, members.length);
        return write.result as { view: Record<string, unknown>; location: string };
      }
    } catch (e) {
      if (e instanceof CaseAlreadyExistsError || uniqueViolation(e)) throw problem('fraud-case-exists', 409, '이 묶음으로 만든 사건이 이미 있습니다');
      if (isProblem(e)) throw e;
      throw problem('dependency-unavailable', 503, '사건을 저장하지 못했습니다');
    }
    await this.#auditIfStoreCannot(audit);
    await this.allow(actor, 'FRAUD_CASE_CREATE', { caseId, eventId: cluster.eventId }, members.length, { audit: false });
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
    const schedule = await this.d.schedule.get(c.eventId).catch(() => null);
    const evidenceBundleIds = this.d.evidence ? await this.d.evidence.listBundleIds(c.eventId, caseId).catch(() => []) : [];
    await this.allow(actor, 'FRAUD_CASE_GET', { caseId }, c.members.length);
    return { view: this.caseView(c, this.d.now(), snapshot, schedule?.entryOpensAtMs, evidenceBundleIds), version: c.version };
  }

  /** SCR-071 연결 그래프. IP는 가린 label만 주고 원문은 ipReveal로만 연다(IR-01). */
  async graph(actor: FraudActor, caseId: string): Promise<FraudGraphView> {
    await this.authorize(actor, 'FRAUD_CASE_GRAPH', { caseId });
    const c = await this.d.store.getCase(caseId);
    if (!c) throw problem('not-found', 404, '사건을 찾을 수 없습니다');
    const g = this.d.graph ? await this.d.graph.graph(caseId) : { nodes: [], edges: [], truncated: false };
    await this.allow(actor, 'FRAUD_CASE_GRAPH', { caseId }, g.nodes.length, { audit: false });
    return g;
  }

  async ipReveal(actor: FraudActor, caseId: string, body: { nodeIds?: unknown; reason?: unknown }): Promise<{ items: readonly { nodeId: string; ip: string }[] }> {
    const nodeIds = Array.isArray(body.nodeIds) ? body.nodeIds.filter((x): x is string => typeof x === 'string') : [];
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (nodeIds.length < 1 || nodeIds.length > 50 || new Set(nodeIds).size !== nodeIds.length) throw problem('invalid-body', 422, 'IP 점을 1~50개 골라 주세요');
    if (reason.length < 5 || reason.length > 500) throw problem('invalid-body', 422, '사유는 5~500자여야 합니다');
    await this.authorize(actor, 'FRAUD_CASE_IP_REVEAL', { caseId });
    const c = await this.d.store.getCase(caseId);
    if (!c) throw problem('not-found', 404, '사건을 찾을 수 없습니다');
    const g = this.d.graph ? await this.d.graph.graph(caseId) : { nodes: [], edges: [], truncated: false };
    const ips = new Set(g.nodes.filter((n) => n.kind === 'IP').map((n) => n.nodeId));
    if (nodeIds.some((id) => !ips.has(id))) throw problem('invalid-body', 422, '그 사건 그래프의 IP 점이 아닙니다');
    const items = this.d.graph ? await this.d.graph.revealIps(caseId, nodeIds) : [];
    await this.d.access.record({
      accountId: actor.accountId,
      role: actor.role,
      action: 'GRAPH_IP_REVEAL',
      caseId,
      rows: items.length,
      detail: { nodeCount: items.length, reason },
      outcome: 'ALLOWED',
    });
    return { items };
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
    if (body.objectionDecisions && body.objectionDecisions.length > 0) {
      if (!this.d.fraud) throw problem('dependency-unavailable', 503, '조치 승인 모듈이 조립되지 않았습니다');
      const decided = await this.d.fraud.decideObjections(actor, current, body.objectionDecisions);
      const snapshot = await this.d.store.latestSnapshot(decided.eventId);
      await this.allow(actor, 'FRAUD_CASE_PATCH', { caseId }, decided.members.length, { audit: false });
      return { view: this.caseView(decided, nowMs, snapshot), version: decided.version };
    }
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
    if (body.investigatorOpinion !== undefined) {
      next = { ...next, investigatorOpinion: body.investigatorOpinion };
      const seq = (next.events.at(-1)?.seq ?? 0) + 1;
      const event = { seq, kind: 'NOTE', actorId: actor.accountId, note: '조사 의견 변경', detail: { field: 'investigatorOpinion', value: body.investigatorOpinion }, occurredAtMs: nowMs };
      events.push(event);
      next = { ...next, events: [...next.events, event] };
    }
    if (body.reasonCategory !== undefined) {
      next = { ...next, reasonCategory: body.reasonCategory };
      const seq = (next.events.at(-1)?.seq ?? 0) + 1;
      const event = { seq, kind: 'NOTE', actorId: actor.accountId, note: '사유 범주 변경', detail: { field: 'reasonCategory', value: body.reasonCategory }, occurredAtMs: nowMs };
      events.push(event);
      next = { ...next, events: [...next.events, event] };
    }
    if (body.appealDecisions && body.appealDecisions.length > 0) {
      const r = decideAppeals({ case: next, decisions: body.appealDecisions, nowMs });
      next = { ...r.next, events: [...r.next.events, ...withActor(r.events)] };
      events.push(...withActor(r.events));
      lockReleases.push(...r.lockReleases);
      if (r.outcomeLabel === 'HUMAN') label = 'HUMAN';
    }
    if (events.length === 0) {
      throw problem('invalid-body', 400, '고칠 칸이 없습니다');
    }
    if (next.version === current.version) next = { ...next, version: current.version + 1 };
    const released = [...new Set(lockReleases)];
    // 저장 전에 풀어 해제 실패가 '정상 종료인데 표는 잠김'으로 남지 않게 한다(IR-08)
    if (released.length > 0) {
      let releaseVersion: number;
      try {
        releaseVersion = await this.d.store.nextLockVersion();
      } catch {
        throw problem('dependency-unavailable', 503, '잠금 판을 만들지 못했습니다');
      }
      try {
        await this.d.locks.release({ caseId, eventId: current.eventId, accountIds: released, version: releaseVersion, actedBy: actor.accountId });
      } catch {
        throw problem('dependency-unavailable', 503, '양도 잠금을 풀지 못했습니다');
      }
    }
    const audit = this.#caseAudit(actor, 'FRAUD_CASE_PATCH', { caseId }, next.members.length);
    let outcome: Awaited<ReturnType<InvestigationStore['updateCase']>>;
    try {
      outcome = await this.d.store.updateCase({ ...next, events: current.events }, current.version, events, { audit });
    } catch {
      await this.#relock(caseId, released, actor, nowMs);
      throw problem('dependency-unavailable', 503, '사건을 저장하지 못했습니다');
    }
    if (!outcome.ok) {
      await this.#relock(caseId, released, actor, nowMs);
      throw problem('precondition-failed', 412, '다른 곳에서 이 사건을 먼저 고쳤습니다');
    }
    await this.#auditIfStoreCannot(audit);
    if (label) await this.d.labels.apply({ eventId: current.eventId, caseId, accountIds: released, label });
    const saved = await this.d.store.getCase(caseId);
    const out = saved ?? next;
    const decided = (body.appealDecisions?.length ?? 0) > 0 || (body.objectionDecisions?.length ?? 0) > 0;
    const clearedByRemoval = out.status === 'CLEARED' && !decided;
    if (this.d.copies && (decided || clearedByRemoval)) {
      const accounts = decided
        ? [...new Set([...(body.appealDecisions ?? []).map((d) => d.accountId), ...(body.objectionDecisions ?? []).map((d) => d.accountId)])]
        : out.members.map((m) => m.accountId);
      await this.#writeDecisionCopies(out, current.eventId, accounts, nowMs);
    }
    const snapshot = await this.d.store.latestSnapshot(out.eventId);
    await this.allow(actor, 'FRAUD_CASE_PATCH', { caseId }, out.members.length, { audit: false });
    return { view: this.caseView(out, nowMs, snapshot), version: out.version };
  }

  /** 소명·이의 판단 뒤 화면용 사본(PAYER·HOLDER)을 상태·조치 결과·이의·우선 구매와 함께 쓴다(IR-04·05). */
  async #writeDecisionCopies(c: FraudCaseRecord, eventId: string, accounts: readonly string[], nowMs: number): Promise<void> {
    const copies = this.d.copies;
    if (!copies) return;
    const rows = this.d.tickets ? await this.d.tickets.listForAction({ eventId, payerAccountIds: accounts }).catch(() => []) : [];
    for (const accountId of accounts) {
      const m = c.members.find((x) => x.accountId === accountId);
      if (!m) continue;
      const paid = rows.filter((t) => t.payerAccountId === accountId);
      const state = copyStateOf(m.appealResult);
      const actionResult = actionResultOf(c, accountId, 'payer');
      const objectionState = m.objectionResult === 'SUBMITTED' || m.objectionResult === 'ACCEPTED' || m.objectionResult === 'REJECTED' ? m.objectionResult : 'NONE';
      try {
        await copies.set({
          caseId: c.caseId,
          eventId,
          accountId,
          version: c.version,
          party: 'PAYER',
          state,
          caseStatus: c.status,
          reasonCategories: [c.reasonCategory],
          ...(m.appealDueAtMs !== null ? { dueAtMs: m.appealDueAtMs } : {}),
          lockedTicketIds: paid.map((t) => t.ticketId),
          heldTicketIds: [],
          excludedTicketIds: [],
          lockActive: false,
          lockExpiresAtMs: m.lockExpiresAtMs,
          objectionDueAtMs: m.actionNotifiedAtMs === null || m.actionNotifiedAtMs === undefined ? null : m.actionNotifiedAtMs + 30 * 24 * HOUR_MS,
          objectionState,
          objectionNote: objectionNoteOf(c, accountId),
          actionResult,
          priorityPurchases: priorityOf(c, accountId),
        });
      } catch {
        // 사본 실패는 판단 저장을 막지 않는다.
      }
      const holders = new Map<string, string[]>();
      const requested = [...c.events].reverse().find((e) => e.kind === 'APPEAL_REQUESTED' && e.detail);
      const notified = requested && Array.isArray(requested.detail!.notifiedHolders) ? (requested.detail!.notifiedHolders as { accountId: string; ticketIds: string[] }[]) : [];
      for (const h of notified) holders.set(h.accountId, h.ticketIds);
      if (holders.size === 0) {
        for (const t of paid) {
          if (t.holderAccountId === t.payerAccountId) continue;
          holders.set(t.holderAccountId, [...(holders.get(t.holderAccountId) ?? []), t.ticketId]);
        }
      }
      for (const [holderId, held] of holders) {
        try {
          await copies.set({
            caseId: c.caseId,
            eventId,
            accountId: holderId,
            version: c.version,
            party: 'HOLDER',
            state,
            caseStatus: c.status,
            reasonCategories: [],
            ...(m.appealDueAtMs !== null ? { dueAtMs: m.appealDueAtMs } : {}),
            lockedTicketIds: [],
            heldTicketIds: held,
            excludedTicketIds: excludedForHolder(c, holderId),
            lockActive: false,
            lockExpiresAtMs: null,
            objectionDueAtMs: null,
            objectionState: 'NONE',
            objectionNote: null,
            actionResult: actionResultOf(c, holderId, 'holder'),
            priorityPurchases: [],
          });
        } catch {
          // 위와 같다.
        }
      }
    }
    void nowMs;
  }

  /** 저장이 실패해 되돌릴 때, 아직 잠겨 있어야 하는 계정만 다시 잠근다(다른 요청의 성공을 덮지 않는다) */
  async #relock(caseId: string, released: readonly string[], actor: FraudActor, nowMs: number): Promise<void> {
    if (released.length === 0) return;
    try {
      const saved = await this.d.store.getCase(caseId);
      if (!saved || saved.status === 'CLEARED') return;
      const accounts = released.filter((id) => {
        const m = saved.members.find((x) => x.accountId === id && x.removedAtMs === null);
        return m !== undefined && m.appealResult !== 'ACCEPTED' && m.lockExpiresAtMs !== null && m.lockExpiresAtMs > nowMs;
      });
      if (accounts.length === 0) return;
      const expiries = accounts
        .map((id) => saved.members.find((x) => x.accountId === id)!.lockExpiresAtMs)
        .filter((x): x is number => x !== null);
      const expiresAtMs = expiries.length > 0 ? Math.max(...expiries) : nowMs + LOCK_MAX_MS;
      const version = await this.d.store.nextLockVersion();
      await this.d.locks.set({ caseId, eventId: saved.eventId, accountIds: accounts, version, expiresAtMs, actedBy: actor.accountId });
    } catch {
      // 보상 실패는 원래 오류를 가리지 않는다. 다음 요청이 같은 판으로 다시 시도한다
    }
  }

  async actionRequest(
    actor: FraudActor,
    caseId: string,
    idem: IdempotentWrite,
    body: { fraudAction: 'CANCEL_TICKETS' | 'RESTRICT' | 'LIFT_RESTRICTION'; accountIds: string[]; ticketIds?: string[]; restrictionEndsAt?: string | null; reason: string },
  ): Promise<Record<string, unknown>> {
    await this.authorize(actor, 'FRAUD_CASE_ACTION_REQUEST', { caseId });
    if (!this.d.fraud) throw problem('dependency-unavailable', 503, '조치 승인 모듈이 조립되지 않았습니다');
    const out = await this.d.fraud.request(actor, caseId, idem, body);
    await this.allow(actor, 'FRAUD_CASE_ACTION_REQUEST', { caseId }, body.accountIds.length);
    return out;
  }

  async clearance(
    actor: FraudActor,
    caseId: string,
    ifMatch: string | undefined,
    idem: IdempotentWrite,
    body: { reason: string; outcomeLabel: 'HUMAN' | 'NONE' },
  ): Promise<{ view: Record<string, unknown>; version: number }> {
    await this.authorize(actor, 'FRAUD_CASE_CLEARANCE', { caseId });
    if (!this.d.fraud) throw problem('dependency-unavailable', 503, '조치 승인 모듈이 조립되지 않았습니다');
    const out = await this.d.fraud.clearance(actor, caseId, ifMatch, body, idem);
    await this.allow(actor, 'FRAUD_CASE_CLEARANCE', { caseId }, 1);
    return out;
  }

  async appeal(
    actor: FraudActor,
    caseId: string,
    idem: IdempotentWrite,
    body: { accountIds: string[]; reasonCategories: FraudCaseRecord['reasonCategory'][]; dueAt: string },
  ): Promise<Record<string, unknown>> {
    // 지정 확인이 멱등 재생보다 먼저다(IR-01)
    await this.authorize(actor, 'FRAUD_CASE_APPEAL', { caseId });
    const replay = (await this.#replay(idem)) as Record<string, unknown> | undefined;
    if (replay) {
      const accountIds = Array.isArray(replay.accountIds) ? replay.accountIds.map(String) : [];
      await this.allow(actor, 'FRAUD_CASE_APPEAL', { caseId }, accountIds.length);
      return replay;
    }
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
    const lockExpiresAtMs = nowMs + LOCK_MAX_MS;
    let lockVersion: number;
    try {
      lockVersion = await this.d.store.nextLockVersion();
    } catch {
      throw problem('dependency-unavailable', 503, '잠금 판을 만들지 못했습니다');
    }
    let lockResult: Awaited<ReturnType<TransferLocks['set']>>;
    try {
      lockResult = await this.d.locks.set({
        caseId,
        eventId: current.eventId,
        accountIds: body.accountIds,
        version: lockVersion,
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
    const notifiedHolders = [...holders].map(([accountId, ticketIds]) => ({ accountId, ticketIds }));
    const events: FraudCaseRecord['events'] = [
      {
        seq,
        kind: 'APPEAL_REQUESTED',
        actorId: actor.accountId,
        note: null,
        detail: {
          accountIds: body.accountIds,
          reasonCategories: body.reasonCategories,
          dueAt: iso(dueAtMs),
          lockExpiresAt: iso(lockExpiresAtMs),
          notifiedHolderCount: holders.size,
          notifiedHolders,
        },
        occurredAtMs: nowMs,
      },
      {
        seq: seq + 1,
        kind: 'LOCK_APPLIED',
        actorId: actor.accountId,
        note: null,
        detail: { accountIds: body.accountIds, expiresAt: iso(lockExpiresAtMs), version: lockVersion, caseVersion: current.version },
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
    const result = {
      appealRequestId: idem.key,
      caseId,
      accountIds: body.accountIds,
      dueAt: iso(dueAtMs),
      lockedTicketCount: lockResult.lockedTicketCount,
      withdrawnOfferCount: lockResult.withdrawnOfferCount,
      lockExpiresAt: firstLocked.length > 0 ? iso(lockExpiresAtMs) : null,
      notifiedHolderCount: holders.size,
    };
    const audit = this.#caseAudit(actor, 'FRAUD_CASE_APPEAL', { caseId }, body.accountIds.length);
    let outcome: Awaited<ReturnType<InvestigationStore['updateCase']>>;
    try {
      outcome = await this.d.store.updateCase({ ...next, events: current.events }, current.version, events, { idem, audit, result });
    } catch (e) {
      await this.#compensateAppeal(caseId, current, body.accountIds, actor);
      if (isProblem(e)) throw e;
      throw problem('dependency-unavailable', 503, '사건을 저장하지 못했습니다');
    }
    if (!outcome.ok) {
      await this.#compensateAppeal(caseId, current, body.accountIds, actor);
      throw problem('dependency-unavailable', 503, '사건을 저장하지 못했습니다');
    }
    if (outcome.replayed) {
      await this.allow(actor, 'FRAUD_CASE_APPEAL', { caseId }, body.accountIds.length);
      return outcome.result as Record<string, unknown>;
    }
    await this.#auditIfStoreCannot(audit);
    // F-04-15: 결제자·받은 사람 화면용 사본. 사본 실패는 소명 요청·잠금을 막지 않는다.
    if (this.d.copies) {
      const ticketRows = this.d.tickets ? await this.d.tickets.listForAction({ eventId: current.eventId, payerAccountIds: body.accountIds }).catch(() => []) : [];
      for (const accountId of body.accountIds) {
        const member = next.members.find((m) => m.accountId === accountId);
        const lockedTicketIds = ticketRows.filter((t) => t.payerAccountId === accountId).map((t) => t.ticketId);
        try {
          await this.d.copies.set({
            caseId,
            eventId: current.eventId,
            accountId,
            version: next.version,
            lockActive: true,
            objectionDueAtMs: null,
            actionResult: null,
            party: 'PAYER',
            state: 'OPEN',
            reasonCategories: [...body.reasonCategories],
            dueAtMs,
            lockedTicketIds,
            heldTicketIds: [],
            lockExpiresAtMs: member?.lockExpiresAtMs ?? null,
            caseStatus: next.status,
            objectionState: 'NONE',
            objectionNote: null,
            excludedTicketIds: [],
          });
        } catch {
          // 사본 실패는 다음 정비·재요청이 다시 쓴다.
        }
      }
      for (const [accountId, ticketIds] of holders) {
        try {
          await this.d.copies.set({ caseId, eventId: current.eventId, accountId, version: next.version, lockActive: false, objectionDueAtMs: null, actionResult: null, party: 'HOLDER', state: 'OPEN', reasonCategories: [], dueAtMs, lockedTicketIds: [], heldTicketIds: [...ticketIds], lockExpiresAtMs: null, caseStatus: next.status, objectionState: 'NONE', objectionNote: null, excludedTicketIds: [] });
        } catch {
          // 위와 같다.
        }
      }
    }
    // 알림은 사건 저장 뒤에 보낸다(IR-07). 실패해도 잠금만 남은 500이 아니라 201이고 실패를 사건 기록에 남긴다
    await this.#notifyHolders(actor, current.eventId, caseId, dueAtMs, holders, nowMs);
    await this.allow(actor, 'FRAUD_CASE_APPEAL', { caseId }, body.accountIds.length, { audit: false });
    return result;
  }

  /** 저장 실패 보상은 자기가 잡은 잠금보다 큰 새 판으로 풀고, 다른 요청이 이미 성공했으면 그 계정을 풀지 않는다(IR-02·IR-20) */
  async #compensateAppeal(caseId: string, current: FraudCaseRecord, accountIds: readonly string[], actor: FraudActor): Promise<void> {
    let release = [...accountIds];
    try {
      const saved = await this.d.store.getCase(caseId);
      if (saved && saved.version !== current.version) {
        release = release.filter((id) => {
          const m = saved.members.find((x) => x.accountId === id && x.removedAtMs === null);
          return m === undefined || m.appealResult === 'NOT_REQUESTED';
        });
      }
    } catch {
      // 다시 읽지 못하면 요청한 계정을 그대로 풀어 본다
    }
    if (release.length === 0) return;
    let version: number;
    try {
      version = await this.d.store.nextLockVersion();
    } catch {
      return;
    }
    try {
      await this.d.locks.release({ caseId, eventId: current.eventId, accountIds: release, version, actedBy: actor.accountId });
    } catch {
      // 보상 실패는 원래 503으로 알린다
    }
  }

  async #notifyHolders(
    actor: FraudActor,
    eventId: string,
    caseId: string,
    dueAtMs: number,
    holders: ReadonlyMap<string, readonly string[]>,
    nowMs: number,
  ): Promise<void> {
    const failed: string[] = [];
    for (const [accountId, ticketIds] of holders) {
      try {
        await this.d.notifier.holderNotice({ eventId, caseId, accountId, ticketIds, dueAtMs });
      } catch {
        failed.push(accountId);
      }
    }
    if (failed.length === 0) return;
    try {
      const saved = await this.d.store.getCase(caseId);
      if (!saved) return;
      const seq = (saved.events.at(-1)?.seq ?? 0) + 1;
      const events: FraudCaseRecord['events'] = [
        {
          seq,
          kind: 'NOTE',
          actorId: actor.accountId,
          note: '받은 사람 알림 실패',
          detail: { notification: 'HOLDER_NOTICE_FAILED', accountIds: failed },
          occurredAtMs: nowMs,
        },
      ];
      const audit = this.#caseAudit(actor, 'FRAUD_CASE_APPEAL', { caseId }, failed.length);
      await this.d.store.updateCase({ ...saved, version: saved.version + 1 }, saved.version, events, { audit });
      await this.#auditIfStoreCannot(audit);
    } catch {
      // 실패 기록도 실패하면 다음 정비가 다시 본다
    }
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
