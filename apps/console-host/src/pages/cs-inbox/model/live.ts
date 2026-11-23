// SCR-045 CS 처리함 실제 화면의 값(d5 §7.6, F-06-2 GAT-280, R-T51). 서버가 준 값만 옮기고 모르는 칸·모양 틀린 값은 버린다.
// 기한 상태(dueState)는 서버가 영업일 달력으로 센 값이고 화면은 공휴일 달력을 갖지 않는다(openapi CsCase.dueState, ADR-0364 결정 3).
// 서버 글(대상·메모)은 화면이 글자 노드로만 그린다(이 파일은 값만 다룬다).
// F-06-7 GAT-280: 추가 검증 이의 심사 패널의 값(verificationAppealOf·appealPanelOf·decisionKeyAfter)과 이의 결정 오류(not-applicable·in-progress)를 더했다.

export type CaseStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
export type DueState = 'ON_TRACK' | 'DUE_SOON' | 'OVERDUE' | 'NONE';

export interface CaseView {
  caseId: string;
  kind: string;
  targetRef: string;
  category: string;
  status: CaseStatus;
  progressDueAt: string | null;
  resultDueAt: string | null;
  dueState: DueState;
  assignee: string | null;
  version: number | null;
  createdAt: string | null;
  resolvedAt: string | null;
  resultNote: string | null;
}

export interface CasePage {
  items: CaseView[];
  nextCursor: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const isoOf = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

function statusOf(v: unknown): CaseStatus | null {
  return v === 'OPEN' || v === 'IN_PROGRESS' || v === 'RESOLVED' ? v : null;
}

function dueStateOf(v: unknown): DueState {
  return v === 'ON_TRACK' || v === 'DUE_SOON' || v === 'OVERDUE' ? v : 'NONE';
}

/** 건 하나. 건 ID·종류·상태가 없거나 틀리면 null(그 행을 그리지 않는다) */
export function caseViewOf(raw: unknown): CaseView | null {
  if (!isRecord(raw)) return null;
  const caseId = textOf(raw.caseId);
  const kind = textOf(raw.kind);
  const status = statusOf(raw.status);
  if (!caseId || !kind || !status) return null;
  const version = typeof raw.version === 'number' && Number.isSafeInteger(raw.version) && raw.version > 0 ? raw.version : null;
  return {
    caseId,
    kind,
    targetRef: typeof raw.targetRef === 'string' ? raw.targetRef : '',
    category: typeof raw.category === 'string' ? raw.category : '',
    status,
    progressDueAt: isoOf(raw.progressDueAt),
    resultDueAt: isoOf(raw.resultDueAt),
    dueState: status === 'RESOLVED' ? 'NONE' : dueStateOf(raw.dueState),
    assignee: textOf(raw.assignee),
    version,
    createdAt: isoOf(raw.createdAt),
    resolvedAt: isoOf(raw.resolvedAt),
    resultNote: typeof raw.resultNote === 'string' ? raw.resultNote : null,
  };
}

/** 목록 응답. 모양 틀린 행은 버린다 */
export function casePageOf(raw: unknown): CasePage {
  if (!isRecord(raw)) return { items: [], nextCursor: null };
  const items = Array.isArray(raw.items) ? raw.items.map(caseViewOf).filter((c): c is CaseView => c !== null) : [];
  return { items, nextCursor: textOf(raw.nextCursor) };
}

/** ETag("7" 또는 W/"7")의 판 번호. 없거나 틀리면 null */
export function versionOfEtag(etag: string | null | undefined): number | null {
  if (typeof etag !== 'string') return null;
  const m = /^(?:W\/)?"(\d{1,15})"$/.exec(etag.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** PATCH If-Match 값 */
export const ifMatchOf = (version: number): string => `"${version}"`;

const KIND_LABELS: Readonly<Record<string, string>> = {
  UNKNOWN_PAYMENT: '결제 상태 불명',
  TICKET_NOT_ISSUED: '결제 뒤 미발권',
  REFUND_FAILED: '환급 실패',
  FLAGGED: '이상 표시',
  REFUND_ACCOUNT_PENDING: '환불 대기',
  COMPENSATION_PENDING: '배상 대기',
  ABUSE_FLAG: '남용 표시',
  APPEAL: '소명',
  DISPUTE: '분쟁 접수',
  INQUIRY: '문의',
  CONTENT_REPORT: '게시물 신고',
  RIGHTS_REQUEST: '권리 침해 삭제 요청',
  VERIFICATION_APPEAL: '추가 검증 이의',
  JUDGEMENT_PENDING: '판정 대기',
  STATEMENT_DISPUTE: '정산 이의',
  MINOR_CONTRACT_CANCEL: '미성년자 계약 취소',
  SELLER_KYC_REQUIRED: 'KYC 필요',
  PAYOUT_ERROR: '지급 요청 오류',
  PAYOUT_FAILED: '지급 요청 실패',
  PAYOUT_DELAYED: '지급 요청 지연',
  PORTONE_PAYOUT_EXECUTION: '포트원 일괄 지급 실행',
  PORTONE_LEDGER_MISMATCH: '포트원 원장 불일치',
  PG_BALANCE_MISMATCH: '결제사 잔액 대사 차이',
  SCANNER_UNREPORTED: '미보고 스캐너',
  KOPIS_REPORT_FAILED: '전산망 전송 실패',
  APPROVAL_EXECUTION_FAILED: '승인 업무 실행 실패',
  RETURN_DELAYED: '반품 처리 지연',
  FRAUD_OBJECTION_COMPENSATION: '부정 예매 이의 보상',
};

/** 건 종류 이름(d5 §7.6 건 종류 표). 모르는 값은 '기타 건' */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? '기타 건';
}

/**
 * 화면의 종류 필터: ops-svc가 받는 종류(ADR-0364 결정 4의 아홉과 F-07-5 ADR-0368 결정 5의 정산 이의). 넷 역할 모두의 목록에 나오는 종류다
 * (정산 이의는 CS 담당자에게 보이는 유일한 정산 건이고 operator·commander도 본다, d5 §7.6 '정산 건의 나눔', authz-matrix 정산서 행)
 */
export const FILTER_KINDS: readonly string[] = [
  'JUDGEMENT_PENDING',
  'DISPUTE',
  'REFUND_FAILED',
  'FLAGGED',
  'REFUND_ACCOUNT_PENDING',
  'COMPENSATION_PENDING',
  'VERIFICATION_APPEAL',
  'SCANNER_UNREPORTED',
  'APPROVAL_EXECUTION_FAILED',
  'STATEMENT_DISPUTE',
];

/** 지급·대사·KYC 건(operator·commander만 처리, open-items 72번) */
export const SETTLEMENT_OPS_KINDS: ReadonlySet<string> = new Set([
  'SELLER_KYC_REQUIRED',
  'PAYOUT_ERROR',
  'PAYOUT_FAILED',
  'PAYOUT_DELAYED',
  'PORTONE_PAYOUT_EXECUTION',
  'PORTONE_LEDGER_MISMATCH',
  'PG_BALANCE_MISMATCH',
]);

/** 승인 업무 실행 실패 건 가운데 운영 쪽 category(ADR-0364 결정 5, 리뷰 RV-04). 앞 하나는 operator·commander, 뒤 둘은 commander만 고친다 */
export const OPS_APPROVAL_FAILURE_CATEGORIES: ReadonlySet<string> = new Set(['PAYOUT_BATCH', 'COMMANDER_ROLE_CHANGE', 'CONTRACT_TERMS_CHANGE']);
const COMMANDER_APPROVAL_FAILURE_CATEGORIES: ReadonlySet<string> = new Set(['COMMANDER_ROLE_CHANGE', 'CONTRACT_TERMS_CHANGE']);

/**
 * 이 역할이 이 종류의 건을 고칠 수 있는가(서버 판정과 같은 규칙, 버튼을 그릴지만 정한다).
 * 승인 업무 실행 실패는 category로 나뉘어 CS 쪽·운영 쪽 모두 고칠 수 있는 종류라 true이고, 건마다 canActOnCategory로 좁힌다
 */
export function canActOn(role: string, kind: string): boolean {
  const both = kind === 'APPROVAL_EXECUTION_FAILED';
  if (role === 'cs_agent' || role === 'cs_lead') return both || !SETTLEMENT_OPS_KINDS.has(kind);
  if (role === 'operator' || role === 'commander') return both || SETTLEMENT_OPS_KINDS.has(kind);
  return false;
}

/** 승인 업무 실행 실패 건의 category별 좁힘(그 밖 종류는 true) */
export function canActOnCategory(role: string, kind: string, category: string): boolean {
  if (kind !== 'APPROVAL_EXECUTION_FAILED') return true;
  if (!OPS_APPROVAL_FAILURE_CATEGORIES.has(category)) return role === 'cs_agent' || role === 'cs_lead';
  if (COMMANDER_APPROVAL_FAILURE_CATEGORIES.has(category)) return role === 'commander';
  return role === 'operator' || role === 'commander';
}

export function statusLabel(s: CaseStatus): string {
  return s === 'OPEN' ? '열림' : s === 'IN_PROGRESS' ? '진행 중' : '해결';
}

/** 기한 배지(d5 §7.6 '기한 1영업일 전·초과' 상태). 색만으로 말하지 않게 글을 함께 둔다 */
export function dueBadge(s: DueState): { tone: 'danger' | 'warning' | 'outline'; label: string } {
  if (s === 'OVERDUE') return { tone: 'danger', label: '기한 넘김' };
  if (s === 'DUE_SOON') return { tone: 'warning', label: '1영업일 안' };
  if (s === 'ON_TRACK') return { tone: 'outline', label: '기한 안' };
  return { tone: 'outline', label: '기한 없음' };
}

const KST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** KST 'M. D. HH:mm'. 값이 없으면 '—' */
export function kstText(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? KST.format(new Date(t)).replace(/\s+/g, ' ') : '—';
}

/** 기한 글: 진행·결과 두 칸(있는 것만). 둘 다 없으면 '기한 없음' */
export function dueText(c: Pick<CaseView, 'progressDueAt' | 'resultDueAt'>): string {
  const parts: string[] = [];
  if (c.progressDueAt) parts.push(`진행 ${kstText(c.progressDueAt)}`);
  if (c.resultDueAt) parts.push(`결과 ${kstText(c.resultDueAt)}`);
  return parts.length > 0 ? parts.join(' · ') : '기한 없음';
}

/** 위 danger 배너를 그릴지(임박·넘김 건이 있으면) */
export function hasUrgent(items: readonly Pick<CaseView, 'dueState'>[]): boolean {
  return items.some((c) => c.dueState === 'DUE_SOON' || c.dueState === 'OVERDUE');
}

/** 화면이 가르는 오류(openapi updateOpsCase 응답 칸, d5 §7.6 상태 표) */
export type CaseErrorKind =
  | 'invalid-query'
  | 'forbidden'
  | 'not-found'
  | 'stale'
  | 'precondition-required'
  | 'resolved'
  | 'not-applicable'
  | 'in-progress'
  | 'note-required'
  | 'assignee-invalid'
  | 'invalid'
  | 'unavailable'
  | 'other';

export interface CaseError {
  kind: CaseErrorKind;
  text: string;
}

export interface ProblemLike {
  readonly status?: unknown;
  readonly type?: unknown;
}

const typeOf = (v: unknown): string => (typeof v === 'string' ? (v.split('/').pop() ?? '') : '');

export function errorOf(e: ProblemLike | null | undefined): CaseError {
  const status = typeof e?.status === 'number' ? e.status : 0;
  const type = typeOf(e?.type);
  if (status === 400) return { kind: 'invalid-query', text: '조건이 올바르지 않습니다. 걸러 보기를 다시 골라 주세요' };
  if (status === 403 && type === 'case-update-not-allowed') return { kind: 'forbidden', text: '이 건을 그렇게 고칠 수 있는 역할이 아닙니다' };
  if (status === 403) return { kind: 'forbidden', text: 'CS 처리함은 CS 담당자와 operator·commander가 씁니다' };
  if (status === 404) return { kind: 'not-found', text: '없는 건입니다' };
  if (status === 412) return { kind: 'stale', text: '다른 곳에서 이 건을 먼저 고쳤습니다. 다시 불러온 뒤 고쳐 주세요.' };
  if (status === 428) return { kind: 'precondition-required', text: '건을 다시 불러온 뒤 고쳐 주세요' };
  // 이의 건을 처리함 갱신으로 닫거나 다른 종류 건에 이의 결정(openapi case-action-not-applicable)
  if (status === 409 && type === 'case-action-not-applicable') return { kind: 'not-applicable', text: '이 건 종류에는 이 처리가 없습니다' };
  // 같은 요청 키의 앞선 결정을 아직 처리하는 중(d5 §7.6 '이의 결정 처리 중'). '이미 해결한 건'과 다르다
  if (status === 409 && type === 'idempotency-request-in-progress') return { kind: 'in-progress', text: '앞서 보낸 결정을 아직 처리하는 중입니다. 잠시 뒤 다시 불러와 주세요' };
  if (status === 409) return { kind: 'resolved', text: '이미 해결한 건입니다' };
  if (status === 422 && type === 'case-result-note-required') return { kind: 'note-required', text: '결과 메모를 적어 주세요' };
  if (status === 422 && type === 'case-assignee-invalid') return { kind: 'assignee-invalid', text: '맡길 수 없는 계정입니다. 활성 CS 담당자의 관리 계정 ID인지 확인해 주세요' };
  if (status === 422) return { kind: 'invalid', text: '지금 상태에서는 그렇게 바꿀 수 없습니다' };
  if (status === 503) return { kind: 'unavailable', text: '잠시 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요' };
  return { kind: 'other', text: '처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요' };
}

/** 메모 글자 수(코드 포인트, 서버와 같은 셈) */
export const noteLength = (s: string): number => [...s].length;
export const RESULT_NOTE_MAX = 2000;

// ---- 추가 검증 이의 심사 패널(F-06-7 GAT-280, B-T28 ⑦, d5 §7.6 '추가 검증 이의 상세'~'이의 반영 실패', openapi CsCaseDetail.verificationAppeal) ----
// 서버가 준 정본 칸만 옮기고(pid·계정 ID·점수·프로필 판 같은 모르는 칸은 버린다), 패널이 그릴 글과 배지는 여기서 만든다.
// 이의 글은 화면이 글자 노드로만 그린다(이 파일은 값만 다룬다).

export type AppealContentState = 'AVAILABLE' | 'PENDING' | 'GONE';
export type AppealReflectState = 'NONE' | 'PENDING' | 'APPLIED' | 'FAILED';
export type AppealDispatchCall = 'APPEAL_COPY' | 'ACCOUNT_HOLD_OPEN' | 'QUEUE_RESOLVE' | 'TRUST_LABEL' | 'ACCOUNT_HOLD_CLOSE';

// 객체 형 별칭(interface가 아니다): 응답 값(Record<string, unknown>)과 맞대어 볼 수 있게 한다
export type VerificationAppealView = {
  appealId: string;
  content: AppealContentState;
  text: string | null;
  request: 'EXPLANATION' | 'REVIEW' | null;
  reasonCategory: string | null;
  receivedAt: string | null;
  entryState: 'VERIFYING' | 'PASSED' | 'ENDED' | null;
  evidence: {
    state: 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE';
    hardSignal: 'NONE' | 'BLOCK_LIST' | 'HONEYPOT' | null;
    source: 'REALTIME' | 'REASSESS' | null;
    decidedAt: string | null;
    deviceChallenges: { sent: number; passed: number; failed: number } | null;
  };
  decision: { outcome: 'ACCEPTED' | 'REJECTED'; decidedBy: string; decidedAt: string; blockListChange: 'NONE' | 'REMOVED' | 'DEVICE_NOT_FOUND' | null } | null;
  reflectState: AppealReflectState;
  dispatch: { call: AppealDispatchCall; state: 'PENDING' | 'APPLIED' | 'FAILED'; attempts: number; lastError: string | null; updatedAt: string }[];
};

const DISPATCH_CALLS: readonly AppealDispatchCall[] = ['APPEAL_COPY', 'ACCOUNT_HOLD_OPEN', 'QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE'];
const REASON_CATEGORIES: readonly string[] = ['RAPID_REQUESTS', 'DEVICE_HISTORY', 'NETWORK', 'INTERACTION', 'HUMAN_CHECK', 'SHARED_PATTERN'];
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | null => (typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const countOf = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

function evidenceOf(raw: unknown): VerificationAppealView['evidence'] {
  const e = isRecord(raw) ? raw : {};
  const dc = isRecord(e.deviceChallenges) ? { sent: countOf(e.deviceChallenges.sent), passed: countOf(e.deviceChallenges.passed), failed: countOf(e.deviceChallenges.failed) } : null;
  return {
    state: oneOf(e.state, ['FOUND', 'NOT_FOUND', 'UNAVAILABLE'] as const) ?? 'UNAVAILABLE',
    hardSignal: oneOf(e.hardSignal, ['NONE', 'BLOCK_LIST', 'HONEYPOT'] as const),
    source: oneOf(e.source, ['REALTIME', 'REASSESS'] as const),
    decidedAt: isoOf(e.decidedAt),
    deviceChallenges: dc,
  };
}

function decisionOf(raw: unknown): VerificationAppealView['decision'] {
  if (!isRecord(raw)) return null;
  const outcome = oneOf(raw.outcome, ['ACCEPTED', 'REJECTED'] as const);
  if (!outcome) return null;
  return {
    outcome,
    decidedBy: typeof raw.decidedBy === 'string' ? raw.decidedBy : '',
    decidedAt: typeof raw.decidedAt === 'string' ? raw.decidedAt : '',
    blockListChange: oneOf(raw.blockListChange, ['NONE', 'REMOVED', 'DEVICE_NOT_FOUND'] as const),
  };
}

/** 상세 응답의 verificationAppeal. 칸이 없거나 모양이 틀리면 null(패널을 그리지 않는다) */
export function verificationAppealOf(raw: unknown): VerificationAppealView | null {
  if (!isRecord(raw) || !isRecord(raw.verificationAppeal)) return null;
  const v = raw.verificationAppeal;
  const content = oneOf(v.content, ['AVAILABLE', 'PENDING', 'GONE'] as const);
  if (typeof v.appealId !== 'string' || !content) return null;
  const dispatch: VerificationAppealView['dispatch'] = [];
  for (const d of Array.isArray(v.dispatch) ? v.dispatch : []) {
    if (!isRecord(d)) continue;
    const call = oneOf(d.call, DISPATCH_CALLS);
    const state = oneOf(d.state, ['PENDING', 'APPLIED', 'FAILED'] as const);
    if (!call || !state) continue;
    dispatch.push({ call, state, attempts: countOf(d.attempts), lastError: strOrNull(d.lastError), updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : '' });
  }
  return {
    appealId: v.appealId,
    content,
    text: strOrNull(v.text),
    request: oneOf(v.request, ['EXPLANATION', 'REVIEW'] as const),
    reasonCategory: oneOf(v.reasonCategory, REASON_CATEGORIES),
    receivedAt: isoOf(v.receivedAt),
    entryState: oneOf(v.entryState, ['VERIFYING', 'PASSED', 'ENDED'] as const),
    evidence: evidenceOf(v.evidence),
    decision: decisionOf(v.decision),
    reflectState: oneOf(v.reflectState, ['NONE', 'PENDING', 'APPLIED', 'FAILED'] as const) ?? 'NONE',
    dispatch,
  };
}

/** 이의 인정·기각 버튼은 CS 담당자만(bot-defense §12 '결정') */
export function canDecideAppeal(role: string): boolean {
  return role === 'cs_agent' || role === 'cs_lead';
}

const REASON_LABELS: Readonly<Record<string, string>> = {
  RAPID_REQUESTS: '짧은 시간 많은 요청',
  DEVICE_HISTORY: '이 기기의 이용 기록',
  NETWORK: '접속 환경',
  INTERACTION: '화면 조작 모양',
  HUMAN_CHECK: '사람 확인 결과',
  SHARED_PATTERN: '여러 계정에서 같은 모양',
};

/** 사유 범주 이름. 모르는 값이면 '—' */
export function appealReasonLabel(v: string | null): string {
  return (v !== null && REASON_LABELS[v]) || '—';
}

export function hardSignalLabel(v: string | null): string {
  return v === 'NONE' ? '없음' : v === 'BLOCK_LIST' ? '차단 기기 목록' : v === 'HONEYPOT' ? '허니팟' : '—';
}

export function evidenceSourceLabel(v: string | null): string {
  return v === 'REALTIME' ? '실시간' : v === 'REASSESS' ? '재평가' : '—';
}

export function appealRequestLabel(v: string | null): string {
  return v === 'EXPLANATION' ? '설명 요구' : v === 'REVIEW' ? '재검토 신청' : '—';
}

export function entryStateLabel(v: string | null): string {
  return v === 'VERIFYING' ? '추가 검증 중' : v === 'PASSED' ? '통과' : v === 'ENDED' ? '끝남' : '—';
}

export function blockListChangeLabel(v: string | null): string {
  return v === 'REMOVED' ? '지움' : v === 'NONE' ? '바뀐 것 없음' : v === 'DEVICE_NOT_FOUND' ? '기기를 찾지 못해 바꾸지 못함' : '—';
}

const CALL_LABELS: Readonly<Record<AppealDispatchCall, string>> = {
  APPEAL_COPY: '이의 내용 옮기기',
  ACCOUNT_HOLD_OPEN: '계정 병합 막기',
  QUEUE_RESOLVE: '대기 참여 반영',
  TRUST_LABEL: '봇 라벨·차단 목록 반영',
  ACCOUNT_HOLD_CLOSE: '계정 병합 막기 풀기',
};

export function dispatchCallLabel(call: string): string {
  return CALL_LABELS[call as AppealDispatchCall] ?? call;
}

/** 호출·요약 상태 배지(d5 §7.6 '이의 반영 중·반영됨'). 색만으로 말하지 않게 글을 함께 둔다 */
export function reflectBadge(state: string): { tone: 'success' | 'warning' | 'danger' | 'outline'; label: string } {
  if (state === 'APPLIED') return { tone: 'success', label: '반영됨' };
  if (state === 'FAILED') return { tone: 'danger', label: '반영 실패' };
  if (state === 'PENDING') return { tone: 'warning', label: '보내는 중' };
  return { tone: 'outline', label: '보낼 호출 없음' };
}

/** 다시 보내도 같은 답이라 배경 작업이 멈춘 실패(bot-defense §12 '다시 보내기') */
const STOPPED_ERRORS: ReadonlySet<string> = new Set(['INVALID_ARGUMENT', 'ALREADY_EXISTS', 'NOT_FOUND', 'FAILED_PRECONDITION', 'PERMISSION_DENIED', 'APPEAL_CONTENT_MISSING']);

/** 결정 시도의 결과: 202 성공, 0 네트워크 실패, 그 밖 HTTP 상태와 Problem type */
export interface DecisionAttempt {
  status: number;
  type?: string;
}

/** 결정 시도 뒤 요청 키: 네트워크 실패(0)·503·409 처리 중이면 같은 키를 다시 쓰고, 그 밖(202·4xx)은 null(다음 대화상자에서 새로 만든다) */
export function decisionKeyAfter(key: string, r: DecisionAttempt): string | null {
  if (r.status === 0 || r.status === 503) return key;
  if (r.status === 409 && typeOf(r.type) === 'idempotency-request-in-progress') return key;
  return null;
}

export interface AppealPanel {
  canDecide: boolean;
  fields: { label: string; value: string }[];
  text: string | null;
  contentNotice: string | null;
  evidenceNotice: string | null;
  decision: { outcome: string; decidedBy: string; decidedAt: string; blockList: string | null } | null;
  rows: { call: string; label: string; badge: { tone: string; label: string } }[];
  banner: { kind: 'retrying' | 'stopped'; text: string } | null;
}

/** 이의 심사 패널이 그릴 값(d5 §7.6 '추가 검증 이의 상세' 차례) */
export function appealPanelOf(appeal: VerificationAppealView, role: string, status: CaseStatus): AppealPanel {
  const e = appeal.evidence;
  const found = e.state === 'FOUND';
  const dc = found ? e.deviceChallenges : null;
  const fields = [
    { label: '요청 종류', value: appealRequestLabel(appeal.request) },
    { label: '사유 범주', value: appealReasonLabel(appeal.reasonCategory) },
    { label: '확정 신호', value: found ? hardSignalLabel(e.hardSignal) : '—' },
    { label: '판정 출처', value: found ? evidenceSourceLabel(e.source) : '—' },
    { label: '판정 시각', value: found ? kstText(e.decidedAt) : '—' },
    { label: '지난 30일 추가 검증 보냄', value: dc ? String(dc.sent) : '—' },
    { label: '지난 30일 추가 검증 통과', value: dc ? String(dc.passed) : '—' },
    { label: '지난 30일 추가 검증 실패', value: dc ? String(dc.failed) : '—' },
    { label: '대기 참여 상태', value: entryStateLabel(appeal.entryState) },
  ];
  const contentNotice = appeal.content === 'PENDING' ? '이의 내용을 아직 불러오지 못했습니다' : appeal.content === 'GONE' ? '이의 내용이 보관 기간이 지나 없습니다' : null;
  const evidenceNotice = e.state === 'NOT_FOUND' ? '판정 근거가 남아 있지 않아 사유 범주로만 판단합니다' : e.state === 'UNAVAILABLE' ? '판정 근거를 불러오지 못했습니다' : null;
  const d = appeal.decision;
  const decision = d
    ? {
        outcome: d.outcome === 'ACCEPTED' ? '인정' : '기각',
        decidedBy: d.decidedBy,
        decidedAt: kstText(d.decidedAt),
        blockList: d.outcome === 'ACCEPTED' && d.blockListChange !== null ? blockListChangeLabel(d.blockListChange) : null,
      }
    : null;
  const rows = appeal.dispatch.map((r) => ({ call: r.call, label: dispatchCallLabel(r.call), badge: reflectBadge(r.state) }));
  let banner: AppealPanel['banner'] = null;
  if (appeal.reflectState === 'FAILED') {
    const failed = appeal.dispatch.find((r) => r.state === 'FAILED');
    banner =
      failed && failed.lastError !== null && STOPPED_ERRORS.has(failed.lastError)
        ? { kind: 'stopped', text: '다시 보내도 같은 답이라 멈췄습니다. 관제에 알려 주세요' }
        : { kind: 'retrying', text: `반영 실패: ${failed ? dispatchCallLabel(failed.call) : '결과 반영'}을 보내지 못했습니다. 배경 작업이 다시 보냅니다(관제 경보 SEV3)` };
  }
  return {
    canDecide: canDecideAppeal(role) && status !== 'RESOLVED',
    fields,
    text: appeal.content === 'AVAILABLE' ? appeal.text : null,
    contentNotice,
    evidenceNotice,
    decision,
    rows,
    banner,
  };
}
