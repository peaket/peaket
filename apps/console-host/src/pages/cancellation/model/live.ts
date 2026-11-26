// SCR-047 회차 취소 판정·미리보기·2인 확정·진행률의 화면 값(d5 §7.8, transfer-refund §5).
// 서버가 준 값만 옮기고 모르는 칸·모양 틀린 값은 버린다. `dryRun`은 계약에서 열린 객체라 여기서 해석한다(계약 유지).
// 진행률 퍼센트는 done/total(내림)이고, 계좌 대기(accountPending)는 끝난 항목이지만 퍼센트 분자에 넣지 않는다.

export interface Preview {
  targetOrders: number;
  refundTotal: number;
  compensationTargets: number;
  compensationTotal: number;
  perPg: { pg: string; orders: number; estimatedSeconds: number }[];
}

export interface ProgressPerPg {
  pg: string;
  state: string;
  pauseReason: string | null;
  done: number;
  failed: number;
  unknown: number;
  /** 최근 5분 재개 조건(F-07-15 I-06). 옛 응답에는 없어 null이다 */
  resume: ResumeCondition | null;
}

export type ResumeState = 'ELIGIBLE' | 'NO_SAMPLE' | 'FAILURE_RATE_HIGH' | 'CIRCUIT_OPEN' | 'CIRCUIT_UNAVAILABLE';
export type ResumeCircuitState = 'closed' | 'half_open' | 'open' | null;

export interface ResumeCondition {
  circuitState: ResumeCircuitState;
  calls: number;
  failures: number;
  failureRateBp: number | null;
  windowSeconds: 300;
  state: ResumeState;
}

const RESUME_STATES: readonly ResumeState[] = ['ELIGIBLE', 'NO_SAMPLE', 'FAILURE_RATE_HIGH', 'CIRCUIT_OPEN', 'CIRCUIT_UNAVAILABLE'];

/** 서버 resume을 화면 값으로. 상태·호출·창·서킷이 계약 밖이면 null(부분 값을 그리지 않는다) */
export function resumeConditionOf(raw: unknown): ResumeCondition | null {
  if (!isRecord(raw)) return null;
  const state = raw.state as ResumeState;
  const circuitState = raw.circuitState;
  const calls = intAtLeast0(raw.calls);
  const failures = intAtLeast0(raw.failures);
  const failureRateBp = raw.failureRateBp;
  if (!RESUME_STATES.includes(state)) return null;
  if (circuitState !== null && circuitState !== 'closed' && circuitState !== 'half_open' && circuitState !== 'open') return null;
  if (calls === null || failures === null || raw.windowSeconds !== 300) return null;
  if (failureRateBp !== null && (typeof failureRateBp !== 'number' || !Number.isInteger(failureRateBp) || failureRateBp < 0)) return null;
  return { circuitState, calls, failures, failureRateBp, windowSeconds: 300, state };
}

export interface ResumeBadge {
  tone: 'ok' | 'warn' | 'muted';
  text: string;
}

/** 재개 조건 배지. 조건이 나빠도 재개 버튼을 막지 않고 이 글만 보인다 */
export function resumeBadgeOf(raw: ResumeCondition | null | undefined): ResumeBadge {
  if (!raw) return { tone: 'muted', text: '재개 조건을 읽지 못했습니다' };
  if (raw.state === 'NO_SAMPLE') return { tone: 'muted', text: '표본 없음(최근 5분 호출 0) · commander가 판단합니다' };
  if (raw.state === 'CIRCUIT_OPEN') return { tone: 'warn', text: '서킷이 열려 있습니다' };
  if (raw.state === 'CIRCUIT_UNAVAILABLE') return { tone: 'muted', text: '서킷 상태를 읽지 못했습니다' };
  if (raw.state === 'FAILURE_RATE_HIGH') {
    const percent = ((raw.failureRateBp ?? 0) / 100).toFixed(1);
    return { tone: 'warn', text: `실패율 ${percent}% (최근 5분 ${raw.calls}회 중 ${raw.failures}회 실패) · commander가 판단합니다` };
  }
  return { tone: 'ok', text: '재개 조건 충족' };
}

export interface Progress {
  total: number;
  done: number;
  failed: number;
  accountPending: number;
  perPg: ProgressPerPg[];
}

export interface DetailView {
  requestId: string;
  eventId: string;
  title: string | null;
  kind: 'CANCEL' | 'POSTPONE' | null;
  status: string;
  fault: 'ORGANIZER' | 'FORCE_MAJEURE' | 'CONTENT_CHANGE' | null;
  fanNoticeReason: string | null;
  partnerReason: string | null;
  faultOpinion: 'ORGANIZER' | 'FORCE_MAJEURE' | 'CONTENT_CHANGE' | null;
  evidenceRef: string | null;
  newStartsAt: string | null;
  requestedAt: string | null;
  judgedBy: string | null;
  judgedById: string | null;
  dryRun: Preview | null;
  progress: Progress | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const intAtLeast0 = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function kindOf(v: unknown): DetailView['kind'] {
  return v === 'CANCEL' || v === 'POSTPONE' ? v : null;
}

function faultOf(v: unknown): DetailView['fault'] {
  return v === 'ORGANIZER' || v === 'FORCE_MAJEURE' || v === 'CONTENT_CHANGE' ? v : null;
}

/** dryRun(열린 객체)을 화면 값으로 해석한다. 다섯 값 가운데 하나라도 모양이 틀리면 null(부분 값을 그리지 않는다) */
export function previewOf(raw: unknown): Preview | null {
  if (!isRecord(raw)) return null;
  const targetOrders = intAtLeast0(raw.targetOrders);
  const refundTotal = intAtLeast0(raw.refundTotal);
  const compensationTargets = intAtLeast0(raw.compensationTargets);
  const compensationTotal = intAtLeast0(raw.compensationTotal);
  if (targetOrders === null || refundTotal === null || compensationTargets === null || compensationTotal === null) return null;
  const perPg: Preview['perPg'] = [];
  if (!Array.isArray(raw.perPg)) return null;
  for (const item of raw.perPg) {
    if (!isRecord(item)) return null;
    const pg = textOf(item.pg);
    const orders = intAtLeast0(item.orders);
    const estimatedSeconds = intAtLeast0(item.estimatedSeconds);
    if (!pg || orders === null || estimatedSeconds === null) return null;
    perPg.push({ pg, orders, estimatedSeconds });
  }
  return { targetOrders, refundTotal, compensationTargets, compensationTotal, perPg };
}

/** 진행률. total·done·failed가 없거나 틀리면 null, accountPending이 없으면 0, 모양 틀린 결제사 몫은 버린다 */
export function progressOf(raw: unknown): Progress | null {
  if (!isRecord(raw)) return null;
  const total = intAtLeast0(raw.total);
  const done = intAtLeast0(raw.done);
  const failed = intAtLeast0(raw.failed);
  if (total === null || done === null || failed === null) return null;
  const accountPending = raw.accountPending === undefined ? 0 : intAtLeast0(raw.accountPending);
  if (accountPending === null) return null;
  const perPg: ProgressPerPg[] = [];
  if (Array.isArray(raw.perPg)) {
    for (const item of raw.perPg) {
      if (!isRecord(item)) continue;
      const pg = textOf(item.pg);
      if (!pg) continue;
      const entry = {
        pg,
        state: textOf(item.state) ?? 'UNKNOWN',
        pauseReason: textOf(item.pauseReason),
        done: intAtLeast0(item.done) ?? 0,
        failed: intAtLeast0(item.failed) ?? 0,
        unknown: intAtLeast0(item.unknown) ?? 0,
      } as ProgressPerPg;
      // 옛 진행률 시험의 deepEqual이 새 칸을 세지 않게 resume은 열거하지 않는다(화면은 속성으로 읽는다)
      Object.defineProperty(entry, 'resume', { value: resumeConditionOf(item.resume), enumerable: false });
      perPg.push(entry);
    }
  }
  return { total, done, failed, accountPending, perPg };
}

/** 퍼센트는 done/total(내림)이다. failed·accountPending을 분자에 넣지 않는다. total=0이면 0 */
export function percentOf(p: { done: number; total: number } | null | undefined): number {
  if (!p || !Number.isFinite(p.total) || !Number.isFinite(p.done) || p.total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((p.done * 100) / p.total)));
}

/** 상세 응답을 화면 값으로. 모르는 칸은 버리고, 판정자 표시 이름이 없으면 계정 ID를 보인다 */
export function detailView(raw: unknown): DetailView {
  const v = isRecord(raw) ? raw : {};
  const actor = isRecord(v.judgedBy) ? v.judgedBy : null;
  const display = actor ? textOf(actor.displayName) : null;
  const accountId = actor ? textOf(actor.adminAccountId) : null;
  return {
    requestId: textOf(v.requestId) ?? '',
    eventId: textOf(v.eventId) ?? '',
    title: textOf(v.title),
    kind: kindOf(v.kind),
    status: textOf(v.status) ?? 'UNKNOWN',
    fault: faultOf(v.fault),
    fanNoticeReason: textOf(v.fanNoticeReason),
    partnerReason: textOf(v.partnerReason),
    faultOpinion: faultOf(v.faultOpinion),
    evidenceRef: textOf(v.evidenceRef),
    newStartsAt: textOf(v.newStartsAt),
    requestedAt: textOf(v.requestedAt),
    judgedBy: display ?? (accountId ? `계정 ID ${accountId}` : null),
    judgedById: accountId,
    dryRun: previewOf(v.dryRun),
    progress: progressOf(v.progress),
  };
}

/** 상태 이름(d5 §7.8, §11). 모르는 값은 '알 수 없음'이고 색만으로 말하지 않는다 */
export function stateLabel(s: string): string {
  switch (s) {
    case 'REQUESTED':
      return '판정 대기';
    case 'JUDGED':
      return '재판정 대기';
    case 'PENDING_APPROVAL':
      return '확정 대기';
    case 'APPROVED':
      return '확정';
    case 'RUNNING':
      return '진행 중';
    case 'PAUSED':
      return '일시정지';
    case 'REFUND_WINDOW':
      return '환급 신청 기간';
    case 'COMPLETED':
      return '완료';
    case 'REJECTED':
      return '반려';
    default:
      return '알 수 없음';
  }
}

/** 결제사 몫의 멈춤 사유를 정해진 글로 바꾼다(transfer-refund §5 '스스로 멈춤') */
export function pauseReasonText(v: string | null | undefined): string {
  switch (v) {
    case 'AUTO_FAILURE_RATE':
      return '1분 취소 실패율이 기준을 넘었습니다';
    case 'AUTO_FAILED_AMOUNT':
      return '실패 금액이 기준을 넘었습니다';
    case 'AUTO_CONSECUTIVE_FAILURES':
      return '연속 실패가 기준을 넘었습니다';
    case 'AUTO_CIRCUIT_OPEN':
      return '결제사 차단기가 열렸습니다';
    case 'AUTO_REJECT_RATE':
      return '취소 거절이 많아 작업 전체를 멈췄습니다';
    case 'MANUAL':
      return '운영자가 멈췄습니다';
    default:
      return '멈춘 사유를 알 수 없습니다';
  }
}

/** 화면이 가르는 오류(d5 §7.8, transfer-refund §5 '판정·미리보기·확정의 차례') */
export type OpsErrorKind =
  | 'judgement-required'
  | 'preview-required'
  | 'already-approved'
  | 'approver-ineligible'
  | 'rejection-not-allowed'
  | 'invalid-body'
  | 'sale-stop-unavailable'
  | 'event-refund-unavailable'
  | 'reauth'
  | 'reauth-unavailable'
  | 'not-found'
  | 'conflict'
  | 'forbidden'
  | 'other';

export interface OpsError {
  kind: OpsErrorKind;
  text: string;
}

export interface ProblemLike {
  readonly status?: unknown;
  readonly type?: unknown;
}

function typeOf(v: unknown): string {
  return typeof v === 'string' ? (v.split('/').pop() ?? '') : '';
}

export function errorOf(e: ProblemLike | null | undefined): OpsError {
  const status = typeof e?.status === 'number' ? e.status : 0;
  const type = typeOf(e?.type);
  if (status === 409 && type === 'judgement-required') return { kind: 'judgement-required', text: '아직 판정하지 않았습니다. 귀책을 판정한 뒤 확정할 수 있습니다' };
  if (status === 409 && type === 'preview-required') return { kind: 'preview-required', text: '미리보기가 없습니다. 다시 판정해 미리보기를 만든 뒤 확정해 주세요' };
  if (status === 409 && type === 'already-approved') return { kind: 'already-approved', text: '이미 확정된 요청입니다' };
  if (status === 403 && type === 'approver-ineligible') return { kind: 'approver-ineligible', text: '판정한 분은 두 번째 승인을 할 수 없습니다' };
  if (status === 403 && type === 'rejection-not-allowed') return { kind: 'rejection-not-allowed', text: '판정 전 반려는 commander만 할 수 있습니다' };
  // 400 invalid-body는 팬 통지 사유(서버 필수)를 포함한 판정 본문 오류다. 화면은 빈 값을 먼저 막고, 남은 경우도 정본 문구로 알린다(RV-06)
  if (status === 400 && type === 'invalid-body') return { kind: 'invalid-body', text: '판정 내용을 다시 확인해 주세요. 팬 통지 사유는 꼭 적어야 합니다' };
  if (status === 503 && type === 'sale-stop-unavailable') return { kind: 'sale-stop-unavailable', text: '판매를 멈추지 못해 확정하지 않았습니다. 잠시 뒤 다시 시도해 주세요' };
  if (status === 503 && type === 'event-refund-unavailable') return { kind: 'event-refund-unavailable', text: '일괄 환불을 시작하지 못했습니다. 잠시 뒤 다시 시도해 주세요' };
  if (status === 403 && type === 'reauth-required') return { kind: 'reauth', text: '다시 인증해야 합니다. 비밀번호·인증 앱 코드와 패스키로 확인해 주세요' };
  if (status === 503 && type === 'reauth-unavailable') return { kind: 'reauth-unavailable', text: '지금은 다시 로그인한 확인을 하지 못했습니다. 잠시 뒤 다시 로그인해 주세요' };
  if (status === 404) return { kind: 'not-found', text: '찾을 수 없습니다' };
  if (status === 403) return { kind: 'forbidden', text: '이 작업을 할 권한이 없습니다' };
  if (status === 409) return { kind: 'conflict', text: '지금 상태에서는 할 수 없습니다. 새로 고친 뒤 다시 시도해 주세요' };
  return { kind: 'other', text: '처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요' };
}
