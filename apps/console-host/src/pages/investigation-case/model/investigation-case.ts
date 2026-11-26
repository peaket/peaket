// F-04-15 SCR-071 사건 작업대의 순수 모델(동결 로컬, LCH-310).
// 정본: docs/features/forensic-replay.md §6.7.4~§6.7.8, docs/design/d3-screens.md SCR-071.
export type CaseStatus = 'INVESTIGATING' | 'APPEAL_PENDING' | 'DECISION_PENDING' | 'ACTIONED' | 'OBJECTED' | 'CLEARED' | 'REVERSED';

export interface CaseMember {
  accountId: string;
  label: string;
  ticketCount: number;
  signals: readonly string[];
  appealResult: string;
  addedBy: string;
  removed: boolean;
  lockExpiresAt: string | null;
}

export interface CaseDetail {
  caseId: string;
  eventId: string;
  clusterId: string;
  status: CaseStatus;
  reasonCategory: string;
  assigneeId: string;
  accountCount: number;
  ticketCount: number;
  appealDueAt: string | null;
  cancelDeadlineAt: string;
  transferLocked: boolean;
  approvalId: string | null;
  outcomeLabel: string | null;
  version: number;
  createdAt: string;
  closedAt: string | null;
  members: readonly CaseMember[];
  snapshot: { version: number; frozenAt: string; invHash: string } | null;
  appealOutcome: string;
  investigatorOpinion: string | null;
  evidenceBundleIds: readonly string[];
  events: readonly { seq: number; kind: string; actorId: string | null; note: string | null; detail: Record<string, unknown> | null; occurredAt: string }[];
}

export interface GraphNode {
  nodeId: string;
  kind: 'ACCOUNT' | 'DEVICE' | 'PAYMENT_METHOD' | 'CONTACT' | 'IP' | 'ASN';
  label: string;
  inCluster: boolean;
}

export interface GraphView {
  nodes: readonly GraphNode[];
  edges: readonly { from: string; to: string; kind: string; firstSeenAt: string; lastSeenAt: string; count: number }[];
  truncated: boolean;
}

export interface AppealRequestInput {
  accountIds: readonly string[];
  reasonCategories: readonly string[];
  dueAt: string;
}

export interface ActionRequestInput {
  fraudAction: 'CANCEL_TICKETS' | 'RESTRICT' | 'LIFT_RESTRICTION';
  accountIds: readonly string[];
  ticketIds?: readonly string[];
  restrictionEndsAt?: string | null;
  reason: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const obj = (v: unknown): Record<string, any> | null => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : null);
const iso = (ms: number) => new Date(ms).toISOString();
const len = (s: string) => Array.from(s).length;

export function mapCaseDetail(raw: Record<string, unknown>): CaseDetail {
  const members = Array.isArray(raw.members) ? raw.members.map((m, i) => {
    const o = m as Record<string, any>;
    return {
      accountId: str(o.accountId),
      label: `계정 ${i + 1}`,
      ticketCount: num(o.ticketCount),
      signals: arr(o.signals),
      appealResult: str(o.appealResult, 'NOT_REQUESTED'),
      addedBy: str(o.addedBy, 'SYSTEM'),
      removed: o.removed === true,
      lockExpiresAt: typeof o.lockExpiresAt === 'string' ? o.lockExpiresAt : null,
    };
  }) : [];
  const snap = obj(raw.snapshot);
  return {
    caseId: str(raw.caseId),
    eventId: str(raw.eventId),
    clusterId: str(raw.clusterId),
    status: (raw.status === 'APPEAL_PENDING' || raw.status === 'DECISION_PENDING' || raw.status === 'ACTIONED' || raw.status === 'OBJECTED' || raw.status === 'CLEARED' || raw.status === 'REVERSED' ? raw.status : 'INVESTIGATING') as CaseStatus,
    reasonCategory: str(raw.reasonCategory),
    assigneeId: str(raw.assigneeId),
    accountCount: num(raw.accountCount, members.filter((m) => !m.removed).length),
    ticketCount: num(raw.ticketCount, members.reduce((n, m) => n + m.ticketCount, 0)),
    appealDueAt: typeof raw.appealDueAt === 'string' ? raw.appealDueAt : null,
    cancelDeadlineAt: str(raw.cancelDeadlineAt),
    transferLocked: raw.transferLocked === true,
    approvalId: typeof raw.approvalId === 'string' ? raw.approvalId : null,
    outcomeLabel: typeof raw.outcomeLabel === 'string' ? raw.outcomeLabel : null,
    version: num(raw.version, 1),
    createdAt: str(raw.createdAt),
    closedAt: typeof raw.closedAt === 'string' ? raw.closedAt : null,
    members,
    snapshot: snap ? { version: num(snap.version), frozenAt: str(snap.frozenAt), invHash: str(snap.invHash) } : null,
    appealOutcome: str(raw.appealOutcome, 'NOT_REQUESTED'),
    investigatorOpinion: typeof raw.investigatorOpinion === 'string' ? raw.investigatorOpinion : null,
    evidenceBundleIds: arr(raw.evidenceBundleIds),
    events: Array.isArray(raw.events) ? raw.events.map((e) => {
      const o = e as Record<string, any>;
      return { seq: num(o.seq), kind: str(o.kind), actorId: typeof o.actorId === 'string' ? o.actorId : null, note: typeof o.note === 'string' ? o.note : null, detail: obj(o.detail), occurredAt: str(o.occurredAt) };
    }) : [],
  };
}

export function mapGraph(raw: Record<string, unknown>): GraphView {
  return {
    nodes: Array.isArray(raw.nodes) ? raw.nodes.map((n) => {
      const o = n as Record<string, any>;
      const kind = o.kind === 'DEVICE' || o.kind === 'PAYMENT_METHOD' || o.kind === 'CONTACT' || o.kind === 'IP' || o.kind === 'ASN' ? o.kind : 'ACCOUNT';
      return { nodeId: str(o.nodeId), kind, label: str(o.label), inCluster: o.inCluster === true };
    }) : [],
    edges: Array.isArray(raw.edges) ? raw.edges.map((e) => {
      const o = e as Record<string, any>;
      return { from: str(o.from), to: str(o.to), kind: str(o.kind), firstSeenAt: str(o.firstSeenAt), lastSeenAt: str(o.lastSeenAt), count: num(o.count, 1) };
    }) : [],
    truncated: raw.truncated === true,
  };
}

export function nodeText(n: GraphNode): string {
  return n.label;
}

export function revealableNodeIds(g: GraphView): readonly string[] {
  return g.nodes.filter((n) => n.kind === 'IP').map((n) => n.nodeId);
}

export function validateIpReveal(i: { nodeIds: readonly string[]; reason: string }): string | undefined {
  if (i.nodeIds.length === 0) return 'IP 점을 하나 이상 골라 주세요';
  if (i.nodeIds.length > 50) return '한 번에 50개까지 열 수 있습니다';
  const n = len(i.reason.trim());
  if (n < 5) return '사유를 5자 이상 적어 주세요';
  if (n > 500) return '사유는 500자까지 쓸 수 있습니다';
  return undefined;
}

export function statusText(status: string): string {
  return { INVESTIGATING: '조사 중', APPEAL_PENDING: '소명 대기', DECISION_PENDING: '결정 대기', ACTIONED: '조치됨', OBJECTED: '이의 접수', CLEARED: '정상 종료', REVERSED: '이의 인정' }[status] ?? '조사 중';
}

export function appealResultText(result: string): string {
  return { NOT_REQUESTED: '요청 전', PENDING: '기다림', SUBMITTED: '제출됨', ACCEPTED: '인정', REJECTED: '불인정', EXPIRED: '기한 경과' }[result] ?? '요청 전';
}

export function lockText(lockExpiresAt: string | null, lockActive: boolean): string {
  if (!lockActive) return '잠금 풀림';
  if (!lockExpiresAt) return '잠금';
  const d = new Date(lockExpiresAt);
  return `늦어도 ${d.getMonth() + 1}월 ${d.getDate()}일까지(14일) 풀립니다`;
}

export function appealDefaults(c: CaseDetail, o: { nowMs: number; entryOpensAtMs: number | null; cancelDeadlineAtMs?: number }): { accountIds: string[]; reasonCategories: string[]; dueAt: string; lockExpiresAt: string; cancelUnavailable: boolean } {
  const cancel = o.cancelDeadlineAtMs ?? Date.parse(c.cancelDeadlineAt);
  const three = o.nowMs + 3 * DAY;
  const floor = o.nowMs + DAY;
  const byCancel = cancel - 6 * HOUR;
  const due = Math.max(floor, Math.min(three, byCancel));
  return {
    accountIds: c.members.filter((m) => !m.removed).map((m) => m.accountId),
    reasonCategories: ['MACRO_BOT'],
    dueAt: iso(due),
    lockExpiresAt: iso(o.nowMs + 14 * DAY),
    cancelUnavailable: due > byCancel,
  };
}

export function validateAppealRequest(c: CaseDetail, i: AppealRequestInput, o: { nowMs: number; entryOpensAtMs: number | null; cancelDeadlineMs: number }): string | undefined {
  if (c.status !== 'INVESTIGATING' && c.status !== 'APPEAL_PENDING') return '지금 상태에서는 소명을 요청할 수 없습니다';
  const active = new Set(c.members.filter((m) => !m.removed).map((m) => m.accountId));
  if (i.accountIds.length === 0 || i.accountIds.some((a) => !active.has(a))) return '사건 계정만 소명을 요청할 수 있습니다';
  if (i.reasonCategories.length === 0) return '사유 범주를 하나 이상 골라 주세요';
  if (i.reasonCategories.length > 5) return '사유 범주는 5개까지 고를 수 있습니다';
  const due = Date.parse(i.dueAt);
  if (!Number.isFinite(due)) return '기한이 올바르지 않습니다';
  if (due < o.nowMs + DAY) return '기한은 지금부터 24시간 이상이어야 합니다';
  if (o.entryOpensAtMs !== null && due > o.entryOpensAtMs) return '기한은 입장 시작 전이어야 합니다';
  if (due > o.cancelDeadlineMs - 6 * HOUR) return '기한이 취소 마감 6시간 전을 넘습니다. 표 취소를 고를 수 없습니다';
  return undefined;
}

export function actionDefaults(c: CaseDetail, o: { nowMs: number }): ActionRequestInput {
  return { fraudAction: 'CANCEL_TICKETS', accountIds: c.members.filter((m) => !m.removed).map((m) => m.accountId), reason: '', restrictionEndsAt: iso(o.nowMs + 365 * DAY) };
}

export function validateActionRequest(c: CaseDetail, i: ActionRequestInput, o: { nowMs: number; cancelDeadlineMs: number; openApproval?: boolean }): string | undefined {
  if (i.reason.trim() === '') return '사유를 적어 주세요';
  if (len(i.reason) > 2_000) return '사유는 2,000자까지 쓸 수 있습니다';
  if (o.openApproval) return '열린 승인 업무가 있어 새 조치를 요청할 수 없습니다';
  if (i.fraudAction === 'LIFT_RESTRICTION') {
    if (c.status !== 'OBJECTED') return '이의 접수 상태에서만 이용 제한을 풀 수 있습니다';
    return undefined;
  }
  const byId = new Map(c.members.map((m) => [m.accountId, m]));
  if (i.fraudAction === 'CANCEL_TICKETS') {
    if (o.nowMs >= o.cancelDeadlineMs) return '취소 마감이 지나 표 취소를 요청할 수 없습니다';
    for (const accountId of i.accountIds) {
      const m = byId.get(accountId);
      if (!m || (m.appealResult !== 'REJECTED' && m.appealResult !== 'EXPIRED')) return '소명 불인정·기한 경과 계정만 표 취소 대상입니다';
    }
  }
  if (i.fraudAction === 'RESTRICT' && i.restrictionEndsAt) {
    const end = Date.parse(i.restrictionEndsAt);
    if (!Number.isFinite(end) || end > o.nowMs + 365 * DAY) return '이용 제한은 1년을 넘을 수 없습니다';
  }
  return undefined;
}

export function actionRequestBody(i: ActionRequestInput): Record<string, unknown> {
  return { fraudAction: i.fraudAction, accountIds: [...i.accountIds], ...(i.ticketIds ? { ticketIds: [...i.ticketIds] } : {}), ...(i.restrictionEndsAt !== undefined && i.restrictionEndsAt !== null ? { restrictionEndsAt: i.restrictionEndsAt } : {}), reason: i.reason };
}

export function validateClearance(i: { reason: string; outcomeLabel: 'HUMAN' | 'NONE' }): string | undefined {
  if (i.reason.trim() === '') return '사유를 적어 주세요';
  if (len(i.reason) > 2_000) return '사유는 2,000자까지 쓸 수 있습니다';
  return undefined;
}

export function clearanceBody(i: { reason: string; outcomeLabel: 'HUMAN' | 'NONE' }): Record<string, unknown> {
  return { reason: i.reason.trim(), outcomeLabel: i.outcomeLabel };
}

export function holdChangeIssue(bundle: { holdReason: string; status: string }, holdReason: string, basis: string): string | undefined {
  if (bundle.status === 'DISPOSED') return '파기된 묶음은 보존 이유를 바꿀 수 없습니다';
  if (bundle.holdReason !== 'OBJECTION') return '보존 이유는 이의 기간에서 한 번만 바꿀 수 있습니다';
  if (holdReason !== 'DISPUTE' && holdReason !== 'INVESTIGATION') return '보존 이유는 분쟁·수사만 고를 수 있습니다';
  const n = len(basis.trim());
  if (n < 5) return '근거를 5자 이상 적어 주세요';
  if (n > 500) return '근거는 500자까지 쓸 수 있습니다';
  return undefined;
}

export function holdChangeBody(holdReason: 'DISPUTE' | 'INVESTIGATION', basis: string): Record<string, unknown> {
  return { holdReason, basis: basis.trim() };
}

export function holdEndIssue(bundle: { holdReason: string; status: string; holdEndRequest: unknown | null }, basis: string): string | undefined {
  if (bundle.status === 'DISPOSED') return '파기된 묶음은 보존 끝을 요청할 수 없습니다';
  if (bundle.holdReason !== 'DISPUTE' && bundle.holdReason !== 'INVESTIGATION') return '분쟁·수사 보존만 끝을 요청할 수 있습니다';
  if (bundle.holdEndRequest !== null) return '이미 확인을 기다리는 요청이 있습니다';
  const n = len(basis.trim());
  if (n < 5) return '근거를 5자 이상 적어 주세요';
  if (n > 500) return '근거는 500자까지 쓸 수 있습니다';
  return undefined;
}

export function holdEndRequestBody(basis: string): Record<string, unknown> {
  return { basis: basis.trim() };
}

export function exportIssue(kind: 'AUTHORITY' | 'PROMOTER' | 'COMPLAINT', reason: string, dataRequestId?: string): string | undefined {
  if (kind === 'AUTHORITY' && !dataRequestId) return '자료 요청 번호가 필요합니다';
  if (reason.trim() === '') return '사유를 적어 주세요';
  if (len(reason) > 1_000) return '사유는 1,000자까지 쓸 수 있습니다';
  return undefined;
}

export function exportBody(kind: 'AUTHORITY' | 'PROMOTER' | 'COMPLAINT', reason: string, dataRequestId?: string): Record<string, unknown> {
  return { kind, reason: reason.trim(), ...(kind === 'AUTHORITY' && dataRequestId ? { dataRequestId } : {}) };
}

const filenameOf = (headers?: Record<string, string | string[] | undefined>): string | undefined => {
  const raw = headers?.['content-disposition'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return undefined;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(v);
  return m?.[1];
};

export function exportFilename(kind: string, headers?: Record<string, string | string[] | undefined>, caseId?: string, documentId?: string): string {
  const fromHeader = filenameOf(headers);
  if (fromHeader) return decodeURIComponent(fromHeader);
  if (kind === 'COMPLAINT') return `complaint-${caseId ?? 'unknown'}.json`;
  if (kind === 'PROMOTER') return `promoter-report-${caseId ?? 'unknown'}.csv`;
  return `authority-${documentId ?? 'unknown'}.json`;
}

export function exportContentType(kind: string): string {
  if (kind === 'PROMOTER') return 'text/csv; charset=utf-8';
  return 'application/json';
}

export function investigationsProblem(e: unknown): { kind: 'forbidden' | 'expired' | 'conflict' | 'rate' | 'error'; message: string; reload: boolean; code?: string } {
  const o = obj(e) ?? {};
  const status = typeof o.status === 'number' ? o.status : 0;
  const code = typeof o.code === 'string' ? o.code : typeof o.type === 'string' ? o.type : undefined;
  if (status === 429) return { kind: 'rate', message: '오늘 내보낼 수 있는 한도를 넘었습니다', reload: false, ...(code ? { code } : {}) };
  if (status === 409 && code === 'evidence-not-sealed') return { kind: 'conflict', message: '아직 봉인되지 않은 묶음은 내보낼 수 없습니다', reload: true, code };
  if (status === 410 || code === 'evidence-disposed') return { kind: 'expired', message: '파기된 증거 묶음입니다', reload: false, ...(code ? { code } : {}) };
  if (status === 422 || code === 'data-request-required') return { kind: 'conflict', message: '승인된 자료 요청 번호가 필요합니다', reload: false, ...(code ? { code } : {}) };
  if (status === 409 && code === 'data-request-not-approved') return { kind: 'conflict', message: '자료 요청이 승인되지 않았거나 다른 회차입니다', reload: true, code };
  return { kind: 'error', message: '내보내지 못했습니다', reload: true, ...(code ? { code } : {}) };
}
