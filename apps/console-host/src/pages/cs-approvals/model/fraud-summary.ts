// F-04-15 SCR-046 부정 예매 조치의 사건 요약 모델(동결 로컬, LCH-310).
// 정본: docs/features/forensic-replay.md §6.7.5 '승인자가 보는 것', docs/api/openapi.yaml FraudCaseSummary.
export interface FraudSummaryTarget {
  accountId: string;
  ticketIds: readonly string[];
  holderTicketIds: readonly string[];
  appealOutcome: string;
}

export interface FraudSummary {
  caseId: string;
  eventId: string;
  reasonCategory: string;
  accountCount: number;
  ticketCount: number;
  purchaseCount: number;
  limitPerPerson: number;
  scoreBand: 'HIGH' | 'MEDIUM' | 'LOW';
  sharedAttributes: readonly string[];
  signals: readonly string[];
  appealOutcome: string;
  appealCounts: { accepted: number; rejected: number; expired: number; submitted: number; pending: number };
  investigatorOpinion: string | null;
  cancelDeadlineAt: string;
  snapshotHash: string;
  targets: readonly FraudSummaryTarget[];
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const obj = (v: unknown): Record<string, any> | null => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : null);
const len = (s: string) => Array.from(s).length;

export function mapFraudSummary(raw: Record<string, unknown>): FraudSummary | null {
  if (typeof raw.caseId !== 'string' || raw.caseId === '') return null;
  const counts = obj(raw.appealCounts) ?? {};
  return {
    caseId: raw.caseId,
    eventId: str(raw.eventId),
    reasonCategory: str(raw.reasonCategory),
    accountCount: num(raw.accountCount),
    ticketCount: num(raw.ticketCount),
    purchaseCount: num(raw.purchaseCount),
    limitPerPerson: num(raw.limitPerPerson, 1),
    scoreBand: raw.scoreBand === 'MEDIUM' || raw.scoreBand === 'LOW' ? raw.scoreBand : 'HIGH',
    sharedAttributes: arr(raw.sharedAttributes),
    signals: arr(raw.signals),
    appealOutcome: str(raw.appealOutcome, 'NOT_REQUESTED'),
    appealCounts: { accepted: num(counts.accepted), rejected: num(counts.rejected), expired: num(counts.expired), submitted: num(counts.submitted), pending: num(counts.pending) },
    investigatorOpinion: typeof raw.investigatorOpinion === 'string' ? raw.investigatorOpinion : null,
    cancelDeadlineAt: str(raw.cancelDeadlineAt),
    snapshotHash: str(raw.snapshotHash),
    targets: Array.isArray(raw.targets) ? raw.targets.map((t) => {
      const o = t as Record<string, any>;
      return { accountId: str(o.accountId), ticketIds: arr(o.ticketIds), holderTicketIds: arr(o.holderTicketIds), appealOutcome: str(o.appealOutcome, 'NOT_REQUESTED') };
    }) : [],
  };
}

export function summaryTargets(s: FraudSummary): { label: string; accountId: string; ticketIds: readonly string[]; holderTicketIds: readonly string[]; appealOutcome: string }[] {
  return s.targets.map((t, i) => ({ label: `계정 ${i + 1}`, accountId: t.accountId, ticketIds: t.ticketIds, holderTicketIds: t.holderTicketIds, appealOutcome: t.appealOutcome }));
}

export function approveBlockReason(i: { summary: FraudSummary | null; status: string; canApprove: boolean; requesterId: string; meId: string; role: string; designations: readonly string[]; summaryViewedAt: string | null }): string | undefined {
  if (!i.summary) return '사건 요약이 아직 실리지 않았습니다';
  if (!i.canApprove) return '서버가 이 요청을 승인할 수 없다고 판정했습니다';
  if (i.meId === i.requesterId) return '요청자 본인은 승인할 수 없습니다';
  if (i.role !== 'commander') return '승인 권한이 없습니다';
  if (i.designations.includes('PSEUDONYM_HANDLER')) return '가명정보 취급자는 승인할 수 없습니다';
  if (i.summaryViewedAt === null) return '사건 요약을 먼저 여세요';
  if (i.status !== 'PENDING_APPROVAL') return '지금 승인할 수 있는 요청이 아닙니다';
  return undefined;
}

export function approvalReasonError(reason: string): string | undefined {
  const n = len(reason.trim());
  if (n === 0) return '판단 이유를 적어 주세요';
  if (n > 1_000) return '판단 이유는 1,000자까지 쓸 수 있습니다';
  return undefined;
}

export function exclusionIssues(s: FraudSummary, excluded: readonly string[]): string | undefined {
  const labels = summaryTargets(s).map((t) => t.label);
  if (excluded.some((x) => !labels.includes(x))) return '요청 대상에 없는 계정입니다';
  if (excluded.length === labels.length && labels.length > 0) return '대상을 모두 빼면 승인할 수 없습니다';
  return undefined;
}

export function fraudApprovalBody(s: FraudSummary, i: { reason: string; excludedLabels: readonly string[] }): { reason: string; excludeAccountIds: string[]; excludeTicketIds: string[] } {
  const rows = summaryTargets(s);
  const picked = rows.filter((r) => i.excludedLabels.includes(r.label));
  return { reason: i.reason.trim(), excludeAccountIds: picked.map((r) => r.accountId), excludeTicketIds: [...new Set(picked.flatMap((r) => [...r.ticketIds, ...r.holderTicketIds]))] };
}

export function fraudApprovalProblem(e: unknown): { message: string; reload: boolean; code?: string } {
  const o = obj(e) ?? {};
  const status = typeof o.status === 'number' ? o.status : 0;
  const code = typeof o.code === 'string' ? o.code : typeof o.type === 'string' ? o.type : undefined;
  if (status === 403) return { message: '승인 권한이 없습니다', reload: false, ...(code ? { code } : {}) };
  if (status === 422) return { message: '승인 범위가 올바르지 않습니다', reload: false, ...(code ? { code } : {}) };
  if (status === 409 && code === 'fraud-summary-not-viewed') return { message: '사건 요약을 먼저 열어야 승인할 수 있습니다', reload: true, code };
  if (status === 409 && code === 'approval-already-open') return { message: '이미 진행 중인 승인 업무가 있습니다', reload: true, code };
  if (status === 404) return { message: '승인 업무를 찾을 수 없습니다', reload: false, ...(code ? { code } : {}) };
  return { message: '승인하지 못했습니다', reload: true, ...(code ? { code } : {}) };
}
