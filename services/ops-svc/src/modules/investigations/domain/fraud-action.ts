// F-04-13 부정 예매 조치 도메인(동결 로컬, LCH-270·LCH-280).
// 정본: docs/features/forensic-replay.md §6.7.4~§6.7.5, docs/features/transfer-refund.md §7.4.
// 순수 함수다. 시계·난수를 직접 쓰지 않고 받은 nowMs만 쓴다. 입력을 바꾸지 않는다.
import type { FraudCaseEventRecord, FraudCaseRecord, FraudCaseStatus, FraudClusterMemberRecord, InvestigationProblem } from './investigation.js';
import { problem } from './investigation.js';

export type FraudAction = 'CANCEL_TICKETS' | 'RESTRICT' | 'LIFT_RESTRICTION';
export type FraudApprovalStatus = 'PENDING_APPROVAL' | 'EXECUTING' | 'DONE' | 'FAILED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED';
export type FraudObjectionResult = 'NONE' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED';

export const RESTRICTION_MAX_MS = 365 * 86_400_000;
export const ACTION_APPROVAL_BUSINESS_DAYS = 5;
export const OBJECTION_WINDOW_MS = 30 * 86_400_000;
export const CANCEL_NOTICE_LEADS_MS: readonly number[] = [12 * 3_600_000, 2 * 3_600_000];
export const ACTION_EXPIRY_MS = 5 * 86_400_000;

export interface FraudTicketRef {
  readonly ticketId: string;
  readonly payerAccountId: string;
  readonly holderAccountId: string;
  readonly status: string;
  readonly entryRecorded: boolean;
}

export interface FraudCancelTarget {
  readonly ticketId: string;
  readonly expectedHolderAccountId: string;
}

const cloneMember = (m: FraudClusterMemberRecord): FraudClusterMemberRecord => ({ ...m, signals: [...m.signals] });
const cloneCase = (c: FraudCaseRecord): FraudCaseRecord => ({
  ...c,
  members: c.members.map(cloneMember),
  events: c.events.map((e) => ({ ...e, detail: e.detail ? { ...e.detail } : null })),
});
const active = (c: FraudCaseRecord): FraudClusterMemberRecord[] => c.members.filter((m) => m.removedAtMs === null);
const nextSeq = (c: FraudCaseRecord): number => (c.events.at(-1)?.seq ?? 0) + 1;
const assertTime = (name: string, v: number): void => {
  if (!Number.isFinite(v)) throw problem('invalid-time', 400, `${name}이 유한한 밀리초가 아닙니다`);
};

export function actionRequestDecision(o: {
  readonly case: FraudCaseRecord;
  readonly nowMs: number;
  readonly action: FraudAction;
  readonly accountIds: readonly string[];
  readonly ticketIds?: readonly string[];
  readonly restrictionEndsAtMs?: number | null;
  readonly openApproval: boolean;
  readonly priorActionDone: boolean;
  readonly tickets: readonly FraudTicketRef[];
  readonly restrictedAccountIds?: readonly string[];
}): { nextStatus: FraudCaseStatus; expiresAtMs: number; restrictionEndsAtMs: number | null; targets: FraudCancelTarget[] } {
  assertTime('지금', o.nowMs);
  if (o.openApproval) throw problem('approval-already-open', 409, '열린 조치 승인 업무가 있습니다');
  if (o.accountIds.length === 0) throw problem('action-target-invalid', 422, '대상 계정이 없습니다');
  const members = active(o.case).filter((m) => o.accountIds.includes(m.accountId));
  if (members.length !== new Set(o.accountIds).size) throw problem('action-target-invalid', 422, '사건에 없는 계정이 있습니다');
  const now = o.nowMs;
  let nextStatus: FraudCaseStatus = o.case.status;
  let restrictionEndsAtMs: number | null = null;
  if (o.action === 'CANCEL_TICKETS') {
    if (now >= o.case.cancelDeadlineAtMs) throw problem('cancel-deadline-passed', 409, '취소 마감이 지났습니다');
  } else {
    const end = o.restrictionEndsAtMs ?? now + RESTRICTION_MAX_MS;
    if (end <= now || end > now + RESTRICTION_MAX_MS) throw problem('restriction-too-long', 422, '이용 제한 끝이 1년을 넘습니다');
    restrictionEndsAtMs = end;
  }
  if (o.case.status === 'APPEAL_PENDING') {
    if (o.case.appealDueAtMs === null || now < o.case.appealDueAtMs) throw problem('appeal-due-not-passed', 409, '소명 기한이 지나지 않았습니다');
    if (o.action === 'LIFT_RESTRICTION') throw problem('fraud-case-state', 409, '이 상태에서는 이용 제한 풀기를 요청할 수 없습니다');
    for (const m of members) {
      if (m.appealResult === 'SUBMITTED') throw problem('appeal-pending', 409, '판단 전 소명이 있습니다');
      if (m.appealResult === 'NOT_REQUESTED') throw problem('fraud-case-state', 409, '소명을 요청하지 않은 계정입니다');
      if (m.appealResult !== 'REJECTED' && m.appealResult !== 'EXPIRED' && m.appealResult !== 'PENDING') {
        throw problem('appeal-target-invalid', 422, '소명을 요청하지 않은 계정입니다');
      }
    }
    nextStatus = 'DECISION_PENDING';
  } else if (o.case.status === 'INVESTIGATING') {
    if (o.case.approvalId === null) throw problem('fraud-case-state', 409, '소명 요청 이력이 없습니다');
    if (o.action === 'LIFT_RESTRICTION') throw problem('fraud-case-state', 409, '이 상태에서는 이용 제한 풀기를 요청할 수 없습니다');
    for (const m of members) {
      if (m.appealResult !== 'REJECTED' && m.appealResult !== 'EXPIRED') throw problem('appeal-target-invalid', 422, '소명을 요청하지 않은 계정입니다');
    }
    nextStatus = 'DECISION_PENDING';
  } else if (o.case.status === 'ACTIONED') {
    if (o.action !== 'RESTRICT') throw problem('fraud-case-state', 409, '조치가 끝난 사건에서는 이용 제한만 요청할 수 있습니다');
    if (active(o.case).some((m) => m.objectionResult === 'SUBMITTED')) throw problem('fraud-case-state', 409, '결정되지 않은 이의가 있습니다');
    nextStatus = 'DECISION_PENDING';
  } else if (o.case.status === 'OBJECTED') {
    if (o.action !== 'LIFT_RESTRICTION') throw problem('fraud-case-state', 409, '이의 접수 상태에서는 이용 제한 풀기만 됩니다');
    const restricted = new Set(o.restrictedAccountIds ?? []);
    for (const m of members) {
      if (m.objectionResult !== 'ACCEPTED' || !restricted.has(m.accountId)) throw problem('fraud-case-state', 409, '이의 인정과 진행 중인 이용 제한이 필요합니다');
    }
    nextStatus = 'OBJECTED';
  } else {
    throw problem('fraud-case-state', 409, '조치를 요청할 수 없는 사건 상태입니다');
  }
  const explicit = o.ticketIds === undefined ? undefined : new Set(o.ticketIds);
  if (explicit !== undefined && explicit.size === 0) throw problem('action-target-invalid', 422, '취소할 표 목록이 비었습니다');
  const targets: FraudCancelTarget[] = o.action !== 'CANCEL_TICKETS'
    ? []
    : o.tickets
        .filter((t) => o.accountIds.includes(t.payerAccountId) && (explicit?.has(t.ticketId) === true || (explicit === undefined && t.holderAccountId === t.payerAccountId)))
        .map((t) => ({ ticketId: t.ticketId, expectedHolderAccountId: t.holderAccountId }));
  if (o.action === 'CANCEL_TICKETS') {
    // F-04-15 동결 로컬: 여러 계정을 한 번에 요청한데 티켓 조회가 아직 비어 있는 경우는
    // 승인 업무를 만들고(대상 표 없음) 승인 단계에서 다시 본다. 한 계정 요청의 빈 목록은 계속 422다(F-04-14 IR-10).
    if (targets.length === 0 && o.accountIds.length === 1) throw problem('action-target-invalid', 422, '취소할 표가 없습니다');
    if (explicit !== undefined) {
      const got = new Set(targets.map((t) => t.ticketId));
      const known = new Set(o.tickets.filter((t) => o.accountIds.includes(t.payerAccountId)).map((t) => t.ticketId));
      if ([...explicit].some((id) => !known.has(id)) || got.size !== explicit.size) throw problem('action-target-invalid', 422, '취소 대상 표가 회차·결제자와 맞지 않습니다');
    }
  }
  return { nextStatus, expiresAtMs: o.action === 'CANCEL_TICKETS' ? o.case.cancelDeadlineAtMs : now + ACTION_EXPIRY_MS, restrictionEndsAtMs, targets };
}

export function clearanceCase(o: {
  readonly case: FraudCaseRecord;
  readonly nowMs: number;
  readonly reason: string;
  readonly outcomeLabel: 'HUMAN' | 'NONE';
}): { next: FraudCaseRecord; lockReleases: string[]; events: FraudCaseEventRecord[] } {
  if (o.reason.trim() === '' || o.reason.length > 2000) throw problem('invalid-body', 400, '이유가 필요합니다');
  if (o.outcomeLabel !== 'HUMAN' && o.outcomeLabel !== 'NONE') throw problem('invalid-body', 400, '정답 라벨이 틀렸습니다');
  if (o.case.status !== 'INVESTIGATING') throw problem('fraud-case-state', 409, '정상 종료할 수 없는 사건 상태입니다');
  const next = cloneCase(o.case);
  let seq = nextSeq(next);
  const events: FraudCaseEventRecord[] = [];
  const lockReleases: string[] = [];
  for (const m of active(next)) {
    if (m.lockExpiresAtMs !== null) {
      lockReleases.push(m.accountId);
      events.push({ seq: seq++, kind: 'LOCK_RELEASED', actorId: null, note: null, detail: { accountId: m.accountId, releaseReason: 'CASE_CLEARED' }, occurredAtMs: o.nowMs });
    }
  }
  next.status = 'CLEARED';
  next.outcomeLabel = o.outcomeLabel;
  next.closedAtMs = o.nowMs;
  next.version = o.case.version + 1;
  next.events = [...next.events, ...events, { seq: seq++, kind: 'CLEARED', actorId: null, note: o.reason, detail: { reason: o.reason, outcomeLabel: o.outcomeLabel }, occurredAtMs: o.nowMs }];
  return { next, lockReleases, events: next.events.slice(o.case.events.length) };
}

export function receiveObjection(o: {
  readonly case: FraudCaseRecord;
  readonly accountId: string;
  readonly party: 'PAYER' | 'HOLDER';
  readonly appealId: string;
  readonly nowMs: number;
}): { result: 'ACCEPTED' | 'EXPIRED' | 'INVALID' | 'HOLDER_STATEMENT'; next: FraudCaseRecord; events: FraudCaseEventRecord[] } {
  const next = cloneCase(o.case);
  const seq = nextSeq(next);
  if (o.party === 'HOLDER') {
    const event: FraudCaseEventRecord = { seq, kind: 'APPEAL_RECEIVED', actorId: null, note: null, detail: { party: 'HOLDER', appealId: o.appealId, accountId: o.accountId }, occurredAtMs: o.nowMs };
    next.events = [...next.events, event];
    next.version = o.case.version + 1;
    return { result: 'HOLDER_STATEMENT', next, events: [event] };
  }
  const m = next.members.find((x) => x.accountId === o.accountId && x.removedAtMs === null);
  if (!m || m.actionNotifiedAtMs === undefined || m.actionNotifiedAtMs === null) return { result: 'INVALID', next: o.case, events: [] };
  if (o.case.status !== 'ACTIONED' && o.case.status !== 'OBJECTED') return { result: 'INVALID', next: o.case, events: [] };
  if (m.objectionResult !== 'NONE') return { result: 'INVALID', next: o.case, events: [] };
  if (o.nowMs >= m.actionNotifiedAtMs + OBJECTION_WINDOW_MS) {
    const event: FraudCaseEventRecord = { seq, kind: 'OBJECTION_EXPIRED', actorId: null, note: null, detail: { accountId: o.accountId, appealId: o.appealId }, occurredAtMs: o.nowMs };
    next.events = [...next.events, event];
    next.version = o.case.version + 1;
    return { result: 'EXPIRED', next, events: [event] };
  }
  m.objectionResult = 'SUBMITTED';
  m.objectionReceivedAtMs = o.nowMs;
  const event: FraudCaseEventRecord = { seq, kind: 'OBJECTION_RECEIVED', actorId: null, note: null, detail: { accountId: o.accountId, appealId: o.appealId, party: 'PAYER' }, occurredAtMs: o.nowMs };
  next.status = 'OBJECTED';
  next.version = o.case.version + 1;
  next.events = [...next.events, event];
  return { result: 'ACCEPTED', next, events: [event] };
}

export function decideObjections(o: {
  readonly case: FraudCaseRecord;
  readonly decisions: readonly { accountId: string; decision: 'ACCEPTED' | 'REJECTED'; reason: string }[];
  readonly nowMs: number;
  readonly reversalComplete: boolean;
  readonly restrictedAccountIds?: readonly string[];
}): { next: FraudCaseRecord; liftAccountIds: string[]; events: FraudCaseEventRecord[] } {
  if (o.case.status !== 'OBJECTED') throw problem('fraud-case-state', 409, '이의를 판단할 수 없는 사건 상태입니다');
  const next = cloneCase(o.case);
  let seq = nextSeq(next);
  const events: FraudCaseEventRecord[] = [];
  const liftAccountIds: string[] = [];
  const seen = new Set<string>();
  for (const d of o.decisions) {
    if (seen.has(d.accountId)) throw problem('objection-decision-invalid', 422, '같은 계정을 두 번 판단했습니다');
    seen.add(d.accountId);
    const m = next.members.find((x) => x.accountId === d.accountId && x.removedAtMs === null);
    if (!m || m.objectionResult !== 'SUBMITTED') throw problem('objection-decision-invalid', 422, '제출한 이의만 판단할 수 있습니다');
    if (d.reason.trim() === '') throw problem('objection-decision-invalid', 422, '이유가 필요합니다');
    m.objectionResult = d.decision;
    m.objectionDecidedAtMs = o.nowMs;
    m.objectionDecisionReason = d.reason;
    if (d.decision === 'ACCEPTED' && (o.restrictedAccountIds ?? []).includes(d.accountId)) liftAccountIds.push(d.accountId);
    events.push({ seq: seq++, kind: 'OBJECTION_DECIDED', actorId: null, note: d.reason, detail: { accountId: d.accountId, decision: d.decision, reason: d.reason }, occurredAtMs: o.nowMs });
  }
  const left = active(next);
  const unresolved = left.some((m) => m.objectionResult === 'SUBMITTED');
  if (unresolved) {
    next.version = o.case.version + 1;
    next.events = [...next.events, ...events];
    return { next, liftAccountIds: [], events };
  }
  const actioned = left.filter((m) => m.actionNotifiedAtMs !== undefined && m.actionNotifiedAtMs !== null);
  const allAccepted = actioned.length > 0 && actioned.every((m) => m.objectionResult === 'ACCEPTED');
  if (allAccepted && o.reversalComplete) {
    next.status = 'REVERSED';
    next.outcomeLabel = 'HUMAN';
    next.closedAtMs = o.nowMs;
    events.push({ seq: seq++, kind: 'REVERSED', actorId: null, note: null, detail: { reason: 'ALL_OBJECTIONS_ACCEPTED' }, occurredAtMs: o.nowMs });
  } else if (liftAccountIds.length > 0) {
    next.status = 'OBJECTED';
  } else {
    next.status = 'ACTIONED';
    events.push({ seq: seq++, kind: 'ACTIONED', actorId: null, note: null, detail: { reason: 'OBJECTIONS_DECIDED' }, occurredAtMs: o.nowMs });
  }
  next.version = o.case.version + 1;
  next.events = [...next.events, ...events];
  return { next, liftAccountIds: [...new Set(liftAccountIds)], events };
}

export function closeActionedCaseIfDue(o: { case: FraudCaseRecord; nowMs: number; openApproval: boolean }): { close: boolean; next: FraudCaseRecord; events: FraudCaseEventRecord[] } {
  if (o.case.status !== 'ACTIONED' || o.case.closedAtMs !== null || o.openApproval) return { close: false, next: o.case, events: [] };
  const actioned = active(o.case).filter((m) => m.actionNotifiedAtMs !== undefined && m.actionNotifiedAtMs !== null);
  if (actioned.length === 0 || actioned.some((m) => m.objectionResult === 'SUBMITTED')) return { close: false, next: o.case, events: [] };
  if (actioned.some((m) => m.actionNotifiedAtMs! + OBJECTION_WINDOW_MS > o.nowMs)) return { close: false, next: o.case, events: [] };
  const next = cloneCase(o.case);
  const event = { seq: nextSeq(next), kind: 'CLOSED', actorId: null, note: null, detail: { reason: 'OBJECTION_WINDOW_PASSED' }, occurredAtMs: o.nowMs };
  next.closedAtMs = o.nowMs;
  next.version = o.case.version + 1;
  next.events = [...next.events, event];
  return { close: true, next, events: [event] };
}

export function approvalExecutionGuard(o: { action: FraudAction; nowMs: number; cancelDeadlineAtMs: number; status: FraudApprovalStatus }): void {
  if (o.action === 'CANCEL_TICKETS' && o.nowMs >= o.cancelDeadlineAtMs) throw problem('cancel-deadline-passed', 409, '취소 마감이 지났습니다');
}

export function approvalSummaryAllowed(o: {
  viewerId: string;
  requesterId: string;
  role: string;
  designations: readonly string[];
  recentlyRevoked: readonly string[];
}): boolean {
  if (o.viewerId === o.requesterId) return true;
  if (o.role !== 'commander') return false;
  if (o.designations.includes('PSEUDONYM_HANDLER') || o.recentlyRevoked.includes('PSEUDONYM_HANDLER')) return false;
  return true;
}

export function approvalDecisionCheck(o: {
  action: FraudAction;
  requesterId: string;
  approverId: string;
  role: string;
  designations: readonly string[];
  recentlyRevoked: readonly string[];
  reason: string | null;
  viewedAtMs: number | null;
  requestedAccountIds: readonly string[];
  requestedTicketIds: readonly string[];
  excludeAccountIds?: readonly string[];
  excludeTicketIds?: readonly string[];
}): { excludedAccounts: string[]; excludedTickets: string[] } {
  if (o.approverId === o.requesterId || o.role !== 'commander' || o.designations.includes('PSEUDONYM_HANDLER') || o.recentlyRevoked.includes('PSEUDONYM_HANDLER')) {
    throw problem('fraud-approver-ineligible', 403, '승인할 수 없는 사람입니다');
  }
  if (o.reason === null || o.reason.trim() === '' || o.reason.length > 1000) throw problem('approval-reason-required', 422, '판단 이유가 필요합니다');
  if (o.viewedAtMs === null) throw problem('fraud-summary-not-viewed', 409, '사건 요약을 먼저 열어야 합니다');
  const excludeAccounts = [...new Set(o.excludeAccountIds ?? [])];
  const excludeTickets = [...new Set(o.excludeTicketIds ?? [])];
  if (excludeAccounts.some((id) => !o.requestedAccountIds.includes(id)) || excludeTickets.some((id) => !o.requestedTicketIds.includes(id))) {
    throw problem('approval-scope-invalid', 422, '요청 범위 밖의 값을 뺄 수 없습니다');
  }
  if (o.requestedAccountIds.every((id) => excludeAccounts.includes(id)) || (o.requestedTicketIds.length > 0 && o.requestedTicketIds.every((id) => excludeTickets.includes(id)))) {
    throw problem('approval-scope-invalid', 422, '대상을 모두 뺄 수 없습니다');
  }
  return { excludedAccounts: excludeAccounts, excludedTickets: excludeTickets };
}

export function objectionWindowEndMs(m: Pick<FraudClusterMemberRecord, 'actionNotifiedAtMs'>): number | null {
  return m.actionNotifiedAtMs === undefined || m.actionNotifiedAtMs === null ? null : m.actionNotifiedAtMs + OBJECTION_WINDOW_MS;
}

export type { InvestigationProblem };
