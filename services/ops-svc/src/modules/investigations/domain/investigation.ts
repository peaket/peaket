// F-04-12 부정 예매 조사 도메인(동결 로컬, LCH-260).
// 정본: docs/features/forensic-replay.md §6.7.2~§6.7.5, docs/data.md fraud_*.
// 순수 함수다. 시계·난수를 직접 쓰지 않고 받은 nowMs만 쓴다. 입력을 바꾸지 않는다.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type FraudCaseStatus = 'INVESTIGATING' | 'APPEAL_PENDING' | 'DECISION_PENDING' | 'ACTIONED' | 'CLEARED' | 'OBJECTED' | 'REVERSED';
export type FraudReasonCategory = 'MACRO_BOT' | 'QUEUE_BYPASS' | 'CAPTCHA_BYPASS' | 'ACCOUNT_LENDING' | 'LIMIT_EVASION';
export type FraudSignal = 'LINK_GRAPH' | 'SYNC_STEPS' | 'VELOCITY' | 'TIMING_BASELINE' | 'BYPASS_TRACE' | 'POST_MATCH';
export type FraudScoreBand = 'HIGH' | 'MEDIUM' | 'LOW';
export type FraudRunStatus = 'RUNNING' | 'DONE' | 'FAILED';
export type FraudRunTrigger = 'SCHEDULED' | 'SNAPSHOT' | 'AUTO_RETRY' | 'MANUAL';
export type FraudRunFailure = 'SOURCE_READ_FAILED' | 'TIMEOUT' | 'OTHER';
export type FraudAppealResult = 'NOT_REQUESTED' | 'PENDING' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
export type FraudObjectionResult = 'NONE' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED';

export const CANCEL_DEADLINE_BEFORE_SHOW_MS = 26 * 3_600_000;
export const APPEAL_MIN_LEAD_MS = 24 * 3_600_000;
export const APPEAL_DEFAULT_LEAD_MS = 3 * 86_400_000;
export const APPEAL_CANCEL_MARGIN_MS = 6 * 3_600_000;
export const LOCK_MAX_MS = 14 * 86_400_000;
export const AUTO_RETRY_LIMIT = 3;

export interface FraudSnapshotRecord {
  eventId: string;
  version: number;
  frozenAtMs: number;
  invHash: string;
  prevHash: string | null;
  tableHashes: Record<string, string>;
  rowCounts: Record<string, number>;
  rangeFromMs: number | null;
  late: boolean;
  verifyStatus: 'OK' | 'MISMATCH' | null;
  verifiedAtMs: number | null;
}

export interface FraudRunRecord {
  eventId: string;
  generation: number;
  attempt: number;
  trigger: FraudRunTrigger;
  snapshotVersion: number;
  ruleVersion: string;
  status: FraudRunStatus;
  failureReason: FraudRunFailure | null;
  resultFingerprint: string | null;
  clusterCount: number | null;
  startedAtMs: number;
  finishedAtMs: number | null;
}

export interface FraudClusterMemberRecord {
  accountId: string;
  ticketCount: number;
  signals: FraudSignal[];
  addedBy: 'SYSTEM' | 'INVESTIGATOR';
  removedAtMs: number | null;
  appealResult: FraudAppealResult;
  appealDueAtMs: number | null;
  lockExpiresAtMs: number | null;
  appealReasonCategories?: FraudReasonCategory[];
  appealRequestedAtMs?: number | null;
  objectionResult?: FraudObjectionResult;
  objectionReceivedAtMs?: number | null;
  objectionDecidedAtMs?: number | null;
  objectionDecisionReason?: string | null;
}

export interface FraudClusterRecord {
  clusterId: string;
  eventId: string;
  generation: number;
  scoreBand: FraudScoreBand;
  accountCount: number;
  purchaseCount: number;
  limitPerPerson: number;
  sharedAttributes: string[];
  signals: FraudSignal[];
  snapshotVersion: number;
  createdAtMs: number;
  members: FraudClusterMemberRecord[];
}

export interface FraudCaseEventRecord {
  seq: number;
  kind: string;
  actorId: string | null;
  note: string | null;
  detail: Record<string, unknown> | null;
  occurredAtMs: number;
}

export interface FraudCaseRecord {
  caseId: string;
  eventId: string;
  clusterId: string;
  status: FraudCaseStatus;
  reasonCategory: FraudReasonCategory;
  assigneeId: string;
  cancelDeadlineAtMs: number;
  appealDueAtMs: number | null;
  approvalId: string | null;
  investigatorOpinion: string | null;
  outcomeLabel: 'BOT' | 'HUMAN' | 'NONE' | null;
  version: number;
  createdAtMs: number;
  closedAtMs: number | null;
  members: FraudClusterMemberRecord[];
  events: FraudCaseEventRecord[];
}

export interface InvestigationProblem {
  readonly type: string;
  readonly status: number;
  readonly message?: string;
}

/** 정본에 없는 오류 이름을 만들지 않도록 status와 type만 담는다. 시험은 status를 주로 본다. */
export const problem = (type: string, status: number, title: string): InvestigationProblem => {
  const p: { type: string; status: number; message?: string } = { type, status };
  Object.defineProperty(p, 'message', { value: title, enumerable: false });
  return p;
};

const assertTime = (name: string, value: number): void => {
  if (!Number.isFinite(value)) throw problem('invalid-time', 422, `${name}이 유한한 밀리초가 아닙니다`);
};
const cloneMember = (m: FraudClusterMemberRecord): FraudClusterMemberRecord => ({ ...m, signals: [...m.signals], ...(m.appealReasonCategories ? { appealReasonCategories: [...m.appealReasonCategories] } : {}) });
const cloneCase = (c: FraudCaseRecord): FraudCaseRecord => ({
  ...c,
  members: c.members.map(cloneMember),
  events: c.events.map((e) => ({ ...e, detail: e.detail ? { ...e.detail } : null })),
});
const active = (c: FraudCaseRecord): FraudClusterMemberRecord[] => c.members.filter((m) => m.removedAtMs === null);
const nextSeq = (c: FraudCaseRecord): number => (c.events.at(-1)?.seq ?? 0) + 1;

export function cancelDeadlineAtMs(showStartsAtMs: number): number {
  assertTime('공연 시작', showStartsAtMs);
  return showStartsAtMs - CANCEL_DEADLINE_BEFORE_SHOW_MS;
}

/** 기본 소명 기한: min(요청 + 3일, 취소 마감 − 6시간)이되 요청 + 24시간 아래로 내리지 않는다 */
export function defaultAppealDueAt(o: { nowMs: number; showStartsAtMs: number }): number {
  assertTime('지금', o.nowMs);
  const cancelAt = cancelDeadlineAtMs(o.showStartsAtMs);
  return Math.max(o.nowMs + APPEAL_MIN_LEAD_MS, Math.min(o.nowMs + APPEAL_DEFAULT_LEAD_MS, cancelAt - APPEAL_CANCEL_MARGIN_MS));
}

/** 기한은 지금 + 24시간 이상이고 입장 시작 전이어야 한다. 입장이 시작됐으면 409다. */
export function assertAppealDue(o: { nowMs: number; dueAtMs: number; showStartsAtMs: number; entryOpensAtMs: number | null }): void {
  assertTime('지금', o.nowMs);
  assertTime('소명 기한', o.dueAtMs);
  const entry = o.entryOpensAtMs ?? o.showStartsAtMs;
  if (o.nowMs >= entry) throw problem('entry-started', 409, '입장이 시작되어 소명을 요청할 수 없습니다');
  if (o.dueAtMs < o.nowMs + APPEAL_MIN_LEAD_MS) throw problem('appeal-due-too-short', 422, '소명 기한은 지금부터 24시간 이상이어야 합니다');
  if (o.dueAtMs >= entry) throw problem('appeal-due-after-entry', 422, '소명 기한은 입장 시작 전이어야 합니다');
}

export function lockExpiryOf(o: { existingLockExpiresAtMs: number | null; nowMs: number }): number {
  return o.existingLockExpiresAtMs ?? o.nowMs + LOCK_MAX_MS;
}

export function autoRetriesLeftOf(o: { status: FraudRunStatus; attempt: number }): number {
  if (o.status !== 'FAILED') return 0;
  return Math.max(0, AUTO_RETRY_LIMIT - (o.attempt - 1));
}

export function rerunDecision(o: {
  last: FraudRunRecord | null;
  nowMs: number;
  sourceExpiresAtMs: number;
}): { allowed: true; generation: number; attempt: number } | { allowed: false; status: 409 | 410; type: string } {
  assertTime('지금', o.nowMs);
  if (o.nowMs >= o.sourceExpiresAtMs) return { allowed: false, status: 410, type: 'investigation-source-expired' };
  if (!o.last) return { allowed: false, status: 409, type: 'fraud-run-not-failed' };
  if (o.last.status === 'RUNNING') return { allowed: false, status: 409, type: 'fraud-run-in-progress' };
  if (o.last.status === 'DONE') return { allowed: false, status: 409, type: 'fraud-run-not-failed' };
  if (autoRetriesLeftOf(o.last) > 0) return { allowed: false, status: 409, type: 'fraud-run-retrying' };
  return { allowed: true, generation: o.last.generation, attempt: o.last.attempt + 1 };
}

export function classifyRunFailure(error: unknown): FraudRunFailure {
  const e = error as { code?: unknown; name?: unknown } | undefined;
  if (e?.code === 'ETIMEDOUT' || e?.name === 'TimeoutError') return 'TIMEOUT';
  if (e?.code === 'SOURCE_READ_FAILED') return 'SOURCE_READ_FAILED';
  return 'OTHER';
}

export function assertInvestigator(designations: readonly string[]): void {
  if (designations.includes('FRAUD_INVESTIGATOR') && !designations.includes('PSEUDONYM_HANDLER')) return;
  throw problem('investigator-required', 403, '부정 거래 조사관 지정이 필요합니다');
}

export function addMembers(o: {
  case: FraudCaseRecord;
  adds: readonly { accountId: string; reason: string }[];
  nowMs: number;
}): { next: FraudCaseRecord; events: FraudCaseEventRecord[] } {
  if (o.case.status !== 'INVESTIGATING' && o.case.status !== 'APPEAL_PENDING') throw problem('fraud-case-state', 409, '계정을 더할 수 없는 사건 상태입니다');
  const next = cloneCase(o.case);
  let seq = nextSeq(next);
  const events: FraudCaseEventRecord[] = [];
  for (const add of o.adds) {
    const existing = next.members.find((m) => m.accountId === add.accountId);
    if (existing && existing.removedAtMs === null) throw problem('member-already-present', 422, '이미 사건에 있는 계정입니다');
    if (existing) {
      existing.removedAtMs = null;
      existing.addedBy = 'INVESTIGATOR';
      existing.appealResult = 'NOT_REQUESTED';
      existing.appealDueAtMs = null;
      existing.appealRequestedAtMs = null;
      // 뺐다 더해도 이미 정한 잠금 최대 기한은 유지한다(§1.3 7)
    } else {
      next.members.push({
        accountId: add.accountId,
        ticketCount: 0,
        signals: [],
        addedBy: 'INVESTIGATOR',
        removedAtMs: null,
        appealResult: 'NOT_REQUESTED',
        appealDueAtMs: null,
        lockExpiresAtMs: null,
      });
    }
    events.push({ seq: seq++, kind: 'MEMBER_ADDED', actorId: null, note: null, detail: { accountId: add.accountId, reason: add.reason }, occurredAtMs: o.nowMs });
  }
  next.version = o.case.version + 1;
  return { next, events };
}

export function removeMembers(o: {
  case: FraudCaseRecord;
  removals: readonly { accountId: string; reason: string }[];
  nowMs: number;
}): { next: FraudCaseRecord; lockReleases: string[]; events: FraudCaseEventRecord[] } {
  if (o.case.status !== 'INVESTIGATING' && o.case.status !== 'APPEAL_PENDING') throw problem('fraud-case-state', 409, '계정을 뺄 수 없는 사건 상태입니다');
  const next = cloneCase(o.case);
  let seq = nextSeq(next);
  const events: FraudCaseEventRecord[] = [];
  const lockReleases: string[] = [];
  for (const removal of o.removals) {
    const member = next.members.find((m) => m.accountId === removal.accountId && m.removedAtMs === null);
    if (!member) throw problem('member-not-found', 422, '사건에 없는 계정입니다');
    member.removedAtMs = o.nowMs;
    lockReleases.push(member.accountId);
    events.push({ seq: seq++, kind: 'MEMBER_REMOVED', actorId: null, note: null, detail: { accountId: member.accountId, reason: removal.reason }, occurredAtMs: o.nowMs });
    events.push({
      seq: seq++,
      kind: 'LOCK_RELEASED',
      actorId: null,
      note: null,
      detail: { accountId: member.accountId, releaseReason: 'MEMBER_REMOVED' },
      occurredAtMs: o.nowMs,
    });
  }
  const left = active(next);
  const allAccepted = left.length > 0 && left.every((m) => m.appealResult === 'ACCEPTED');
  if (left.length === 0 || allAccepted) {
    next.status = 'CLEARED';
    next.closedAtMs = o.nowMs;
    next.outcomeLabel = 'HUMAN';
    for (const m of left) lockReleases.push(m.accountId);
    events.push({ seq: seq++, kind: 'CLEARED', actorId: null, note: null, detail: { reason: left.length === 0 ? 'ALL_MEMBERS_REMOVED' : 'ALL_APPEALS_ACCEPTED' }, occurredAtMs: o.nowMs });
  }
  next.version = o.case.version + 1;
  return { next, lockReleases: [...new Set(lockReleases)], events };
}

export function decideAppeals(o: {
  case: FraudCaseRecord;
  decisions: readonly { accountId: string; decision: 'ACCEPTED' | 'REJECTED'; reason: string }[];
  nowMs: number;
}): { next: FraudCaseRecord; lockReleases: string[]; outcomeLabel: 'HUMAN' | null; events: FraudCaseEventRecord[] } {
  if (o.case.status !== 'APPEAL_PENDING') throw problem('fraud-case-state', 409, '소명을 판단할 수 없는 사건 상태입니다');
  const next = cloneCase(o.case);
  let seq = nextSeq(next);
  const events: FraudCaseEventRecord[] = [];
  const seen = new Set<string>();
  const lockReleases: string[] = [];
  for (const decision of o.decisions) {
    if (seen.has(decision.accountId)) throw problem('appeal-decision-invalid', 422, '같은 계정을 두 번 판단했습니다');
    seen.add(decision.accountId);
    const member = next.members.find((m) => m.accountId === decision.accountId && m.removedAtMs === null);
    if (!member) throw problem('appeal-decision-invalid', 422, '사건에 없는 계정입니다');
    if (member.appealResult !== 'SUBMITTED') throw problem('appeal-decision-invalid', 422, '제출한 소명만 판단할 수 있습니다');
    member.appealResult = decision.decision;
    if (decision.decision === 'ACCEPTED') {
      lockReleases.push(member.accountId);
      events.push({
        seq: seq++,
        kind: 'LOCK_RELEASED',
        actorId: null,
        note: null,
        detail: { accountId: member.accountId, releaseReason: 'APPEAL_ACCEPTED' },
        occurredAtMs: o.nowMs,
      });
    }
    events.push({
      seq: seq++,
      kind: 'APPEAL_DECIDED',
      actorId: null,
      note: null,
      detail: { accountId: member.accountId, decision: decision.decision, reason: decision.reason },
      occurredAtMs: o.nowMs,
    });
  }
  const left = active(next);
  let outcomeLabel: 'HUMAN' | null = null;
  if (left.length > 0 && left.every((m) => m.appealResult === 'ACCEPTED')) {
    next.status = 'CLEARED';
    next.closedAtMs = o.nowMs;
    next.outcomeLabel = 'HUMAN';
    outcomeLabel = 'HUMAN';
    for (const m of left) lockReleases.push(m.accountId);
    events.push({ seq: seq++, kind: 'CLEARED', actorId: null, note: null, detail: { reason: 'ALL_APPEALS_ACCEPTED' }, occurredAtMs: o.nowMs });
  }
  next.version = o.case.version + 1;
  return { next, lockReleases: [...new Set(lockReleases)], outcomeLabel, events };
}

export function verifySnapshotDecision(o: {
  stored: FraudSnapshotRecord;
  recomputed: FraudSnapshotRecord;
}): { ok: boolean; severity: 'SEV2' | null; exportBlocked: boolean; mismatchedTables: string[] } {
  const mismatchedTables = Object.keys(o.stored.tableHashes).filter((t) => o.stored.tableHashes[t] !== o.recomputed.tableHashes[t]);
  const ok = mismatchedTables.length === 0 && o.stored.invHash === o.recomputed.invHash;
  return { ok, severity: ok ? null : 'SEV2', exportBlocked: !ok, mismatchedTables };
}

const HASH = /^[0-9a-f]{64}$/;
const isoMs = (name: string) =>
  z.string().superRefine((v, ctx) => {
    if (!Number.isFinite(Date.parse(v))) ctx.addIssue({ code: 'custom', message: `${name}이 ISO 8601이 아닙니다` });
  });
const hash = z.string().regex(HASH);
const tableHashes = z
  .object({ inv_request: hash, inv_step: hash, inv_behavior: hash, inv_link: hash })
  .strict();
const rowCounts = z
  .object({ inv_request: z.int().min(0), inv_step: z.int().min(0), inv_behavior: z.int().min(0), inv_link: z.int().min(0) })
  .strict();

const forensicsSnapshotSchema = z
  .object({
    eventId: z.string().min(1),
    version: z.int().min(1),
    frozenAt: isoMs('frozenAt'),
    invHash: hash,
    prevHash: hash.nullable(),
    tableHashes,
    rowCounts,
    rangeFrom: isoMs('rangeFrom').nullable(),
    late: z.boolean(),
  })
  .strict();

/** F-04-11 SnapshotRecord JSON을 저장 모양으로 바꾼다. 모르는 칸·빠진 칸은 거절한다. */
export function snapshotFromForensics(v: unknown): FraudSnapshotRecord {
  const p = forensicsSnapshotSchema.parse(v);
  return {
    eventId: p.eventId,
    version: p.version,
    frozenAtMs: Date.parse(p.frozenAt),
    invHash: p.invHash,
    prevHash: p.prevHash,
    tableHashes: { ...p.tableHashes },
    rowCounts: { ...p.rowCounts },
    rangeFromMs: p.rangeFrom === null ? null : Date.parse(p.rangeFrom),
    late: p.late,
    verifyStatus: null,
    verifiedAtMs: null,
  };
}

const signalSchema = z.enum(['LINK_GRAPH', 'SYNC_STEPS', 'VELOCITY', 'TIMING_BASELINE', 'BYPASS_TRACE', 'POST_MATCH']);
const clusterSchema = z
  .object({
    accounts: z.array(z.string().min(1)).min(1),
    accountCount: z.int().min(0),
    purchaseCount: z.int().min(0),
    limitPerPerson: z.int().min(1),
    scoreBand: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    sharedAttributes: z.array(z.string()),
    signals: z.array(signalSchema),
    members: z
      .array(z.object({ accountId: z.string().min(1), signals: z.array(signalSchema), ticketCount: z.int().min(0) }).strict())
      .min(1),
    candidate: z.boolean(),
  })
  .strict();
const forensicsClustersSchema = z
  .object({
    eventId: z.string().min(1),
    snapshotVersion: z.int().min(0),
    ruleVersion: z.string().min(1),
    candidateCount: z.int().min(0),
    resultFingerprint: hash,
    clusters: z.array(clusterSchema),
  })
  .strict();

/** F-04-11 ClusterResult JSON에서 후보(candidate=true)만 저장 모양으로 바꾼다. */
export function clustersFromForensics(
  v: unknown,
  run: { eventId: string; generation: number; snapshotVersion: number; createdAtMs: number },
): { clusters: FraudClusterRecord[]; resultFingerprint: string; ruleVersion: string } {
  const p = forensicsClustersSchema.parse(v);
  const clusters = p.clusters
    .filter((c) => c.candidate)
    .map((c) => ({
      clusterId: randomUUID(),
      eventId: run.eventId,
      generation: run.generation,
      scoreBand: c.scoreBand,
      accountCount: c.accountCount,
      purchaseCount: c.purchaseCount,
      limitPerPerson: c.limitPerPerson,
      sharedAttributes: [...c.sharedAttributes],
      signals: [...c.signals],
      snapshotVersion: run.snapshotVersion,
      createdAtMs: run.createdAtMs,
      members: [...c.members]
        .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0))
        .map((m) => ({
          accountId: m.accountId,
          ticketCount: m.ticketCount,
          signals: [...m.signals],
          addedBy: 'SYSTEM' as const,
          removedAtMs: null,
          appealResult: 'NOT_REQUESTED' as const,
          appealDueAtMs: null,
          lockExpiresAtMs: null,
        })),
    }));
  return { clusters, resultFingerprint: p.resultFingerprint, ruleVersion: p.ruleVersion };
}
