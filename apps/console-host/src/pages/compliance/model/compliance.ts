// SCR-032 법정 조치 모델(F-03-7).
// 정본: docs/features/control-tower.md §9(점검표·자료 요청 P1~P8·의무별 기한·접속기록 점검)·§9.1(통지 문안),
// docs/design/d5-screen-blueprint.md §7.5(화면 글·상태), openapi ComplianceNotice·DataRequest·SecurityIncident.
// 서버 `compliance` 모듈이 아직 없어 화면은 계약 모양대로 만들고 실제 서버 경로는 남은 위험 1로 적는다.
import type { ReauthAct } from '@/features/admin-reauth/api';

export type ComplianceRole = 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead' | (string & {});
export type ComplianceLayout = 'phone' | 'tablet' | 'desktop';
export type ComplianceTab = 'requests' | 'incidents' | 'access-reviews';

const HOUR = 60 * 60_000;

export const TABS: readonly { key: ComplianceTab; label: string }[] = [
  { key: 'requests', label: '통보·자료 요청' },
  { key: 'incidents', label: '보안 사고' },
  { key: 'access-reviews', label: '접속기록 점검' },
];

export function tabFromParam(value: string | null): ComplianceTab {
  return value === 'incidents' || value === 'access-reviews' ? value : 'requests';
}
export function tabHref(tab: ComplianceTab): string {
  return `/compliance?tab=${tab}`;
}

export type Tone = 'ok' | 'warn' | 'danger' | 'overdue' | 'none';

export function deadlineView(dueAt: string | null | undefined, nowMs: number): { remainingMs: number; tone: Tone; text: string } {
  if (!dueAt) return { remainingMs: 0, tone: 'none', text: '기한 없음' };
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return { remainingMs: 0, tone: 'none', text: '기한 없음' };
  const remainingMs = due - nowMs;
  if (remainingMs < 0) return { remainingMs, tone: 'overdue', text: '기한이 지났습니다' };
  const hours = Math.floor(remainingMs / HOUR);
  const minutes = Math.floor((remainingMs % HOUR) / 60_000);
  const text = `남은 시간 ${hours}시간 ${minutes}분`;
  const tone: Tone = remainingMs <= 2 * HOUR ? 'danger' : remainingMs <= 6 * HOUR ? 'warn' : 'ok';
  return { remainingMs, tone, text };
}

export function listViewOf(payload: unknown): 'FULL' | 'SUMMARY' | 'UNKNOWN' {
  const v = (payload as { view?: unknown } | null)?.view;
  return v === 'FULL' || v === 'SUMMARY' ? v : 'UNKNOWN';
}

/** 응답 `view`가 SUMMARY면 d5 §7.5의 건 요약 칸만 그린다(ASVS 8.1.2) */
export function visibleFields(payload: Record<string, unknown>): string[] {
  const view = listViewOf(payload);
  if ('noticeId' in payload) {
    return view === 'SUMMARY'
      ? ['noticeId', 'requester', 'agencyName', 'dueAt', 'status']
      : ['view', 'noticeId', 'requester', 'agencyName', 'dueAt', 'status', 'receivedAt', 'deadline', 'reviewIds', 'summary', 'documents', 'takenDownAt', 'withdrawnAt'];
  }
  if ('requestId' in payload) {
    return view === 'SUMMARY'
      ? ['requestId', 'requester', 'agencyName', 'kind', 'dueAt', 'status']
      : ['view', 'requestId', 'requester', 'agencyName', 'kind', 'dueAt', 'status', 'receivedAt', 'legalBasis', 'purpose', 'subjects', 'dataItems', 'periodFrom', 'periodTo', 'refusalReason', 'documents', 'extraction', 'decisions', 'submission', 'retainUntil'];
  }
  return Object.keys(payload);
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isDate = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));

export interface NoticeDraft {
  requester?: string;
  agencyName?: string;
  receivedAt?: string;
  deadline?: string;
  reviewIds?: string[];
  summary?: string;
}

export function validateNoticeDraft(d: NoticeDraft): string | null {
  if (d.requester !== 'AGENCY' && d.requester !== 'POLICE') return '통보한 기관 종류를 골라 주세요(신고기관·수사기관)';
  if (str(d.agencyName) === '') return '접수 기관 이름을 적어 주세요';
  if (!isDate(d.receivedAt)) return '공문 접수 시각을 골라 주세요';
  if (d.deadline !== 'H24' && d.deadline !== 'H10') return '처리 기한을 골라 주세요(24시간·10시간)';
  if (!Array.isArray(d.reviewIds) || d.reviewIds.length === 0) return '통보에 적힌 게시물 ID를 하나 이상 넣어 주세요';
  if ((d.summary ?? '').length > 2000) return '통보 요약은 2,000자까지입니다';
  return null;
}

export interface DataRequestDraft {
  requester?: string;
  agencyName?: string;
  kind?: string;
  receivedAt?: string;
  dueAt?: string;
  legalBasis?: string;
  purpose?: string;
  subjects?: { kind?: string; value?: string }[];
  dataItems?: string[];
  periodFrom?: string | null;
  periodTo?: string | null;
  checklist?: {
    legalBasisChecked?: boolean;
    purposeChecked?: boolean;
    scopeChecked?: boolean;
    dueChecked?: boolean;
    courtWarrantAttached?: boolean;
  };
}

export const DATA_ITEMS = ['BOOKINGS', 'BUYER_INFO', 'ACCESS_LOGS', 'POSTS', 'SUBSCRIBER_INFO'] as const;
export const DATA_ITEM_LABELS: Record<string, string> = {
  BOOKINGS: '예매 내역',
  BUYER_INFO: '구매자 정보',
  ACCESS_LOGS: '통신 접속기록',
  POSTS: '관련 게시물',
  SUBSCRIBER_INFO: '통신이용자정보',
};

export function validateDataRequestDraft(d: DataRequestDraft): string | null {
  if (d.requester !== 'AGENCY' && d.requester !== 'POLICE') return '요청 기관 종류를 골라 주세요';
  if (str(d.agencyName) === '') return '요청 기관 이름을 적어 주세요';
  if (d.kind !== 'REPORT' && d.kind !== 'CDR' && d.kind !== 'SUBSCRIBER') return '자료 종류를 골라 주세요';
  if (!isDate(d.receivedAt)) return '요청서 접수 시각을 골라 주세요';
  if (!isDate(d.dueAt)) return '제출 기한을 골라 주세요';
  if (str(d.legalBasis) === '') return '법적 근거를 적어 주세요';
  if (str(d.purpose) === '') return '요청 목적을 적어 주세요';
  if (!Array.isArray(d.subjects) || d.subjects.length === 0 || d.subjects.some((s) => str(s.value) === '')) return '대상자를 하나 이상 넣어 주세요';
  if (!Array.isArray(d.dataItems) || d.dataItems.length === 0) return '자료 항목을 하나 이상 골라 주세요';
  const c = d.checklist ?? {};
  if (!c.legalBasisChecked) return '법적 근거가 정당한지 확인해 주세요';
  if (!c.purposeChecked) return '요청 목적과 대상의 연관을 확인해 주세요';
  if (!c.scopeChecked) return '대상 범위가 요청 목적 안인지 확인해 주세요';
  if (!c.dueChecked) return '제출 기한이 적혀 있는지 확인해 주세요';
  if (d.kind === 'CDR' && !c.courtWarrantAttached) return '통신사실확인자료는 법원 허가서(영장)가 첨부돼야 합니다';
  if (d.periodFrom && d.periodTo && Date.parse(d.periodFrom) > Date.parse(d.periodTo)) return '대상 기간의 시작이 끝보다 늦습니다';
  return null;
}

export interface ExtractionDraft {
  dataItems?: string[];
  periodFrom?: string | null;
  periodTo?: string | null;
  reason?: string;
}

export function validateExtractionDraft(d: ExtractionDraft, request: { dataItems?: readonly string[]; periodFrom?: string | null; periodTo?: string | null }): string | null {
  const allowed = new Set(request.dataItems ?? []);
  if (!Array.isArray(d.dataItems) || d.dataItems.length === 0) return '뽑을 자료 항목을 하나 이상 골라 주세요';
  if (d.dataItems.some((i) => !allowed.has(i))) return '요청서에 없는 항목은 고를 수 없습니다';
  if (d.periodFrom && request.periodFrom && Date.parse(d.periodFrom) < Date.parse(request.periodFrom)) return '요청서 기간 밖의 시작입니다';
  if (d.periodTo && request.periodTo && Date.parse(d.periodTo) > Date.parse(request.periodTo)) return '요청서 기간 밖의 끝입니다';
  if (str(d.reason) === '') return '이 범위가 꼭 필요한 이유를 사유로 적어 주세요';
  if ((d.reason ?? '').length > 2000) return '사유는 2,000자까지입니다';
  return null;
}

export interface SubmissionDraft {
  submittedAt?: string;
  recipient?: string;
  channel?: string;
  fileSha256?: string;
}

export function validateSubmissionDraft(d: SubmissionDraft, expectedSha: string): string | null {
  if (!isDate(d.submittedAt)) return '제출 일시를 골라 주세요';
  if (str(d.recipient) === '') return '받는 기관을 적어 주세요';
  if (str(d.channel) === '') return '낸 방법을 적어 주세요';
  if (!/^[0-9a-f]{64}$/.test(d.fileSha256 ?? '')) return 'SHA-256은 소문자 16진수 64자입니다';
  if (d.fileSha256 !== expectedSha) return '내려받은 제출 파일과 해시가 다릅니다. 승인된 파일을 다시 내려받아 주세요';
  return null;
}

export function validateDeterminationDraft(d: { outcome?: string; reason?: string }): string | null {
  if (d.outcome !== 'APPLICABLE' && d.outcome !== 'UNDECIDED' && d.outcome !== 'NOT_APPLICABLE') return '판단을 골라 주세요(해당함·판단이 서지 않음·해당 없음)';
  if (str(d.reason) === '') return '판단 사유를 적어 주세요';
  if ((d.reason ?? '').length > 2000) return '사유는 2,000자까지입니다';
  return null;
}

export const DUTY_LABELS: Record<string, string> = {
  KISA_REPORT_24H: '침해사고 신고(24시간)',
  ADDITIONAL_24H: '추가 사실 신고(24시간)',
  USER_NOTICE: '이용자 통지',
  RELIEF_14D: '피해구제 조치(14일)',
  SUBJECT_NOTICE_72H: '정보주체 통지(72시간)',
  PIPC_REPORT_72H: '개인정보위 신고(72시간)',
  POSSIBILITY_NOTICE_72H: '유출 가능성 통지(72시간)',
  NOT_LEAKED_NOTICE: '미유출 확인 통지',
};

export function validateFilingDraft(d: { duty?: string; channel?: string; doneAt?: string; summary?: string }): string | null {
  if (!d.duty || !Object.hasOwn(DUTY_LABELS, d.duty)) return '수행한 의무를 골라 주세요';
  if (str(d.channel) === '') return '기관과 방법을 적어 주세요';
  if (!isDate(d.doneAt)) return '수행 시각을 골라 주세요';
  if (str(d.summary) === '') return '신고·통지 내용 요약을 적어 주세요';
  if ((d.summary ?? '').length > 2000) return '요약은 2,000자까지입니다';
  return null;
}

export const FINDING_ACTIONS = ['NONE', 'REPORTED', 'RECALLED', 'DELETED', 'ACCESS_REVOKED', 'INCIDENT'] as const;
export const FINDING_ACTION_LABELS: Record<string, string> = {
  NONE: '조치 없음',
  REPORTED: '보고',
  RECALLED: '회수·파기 요청',
  DELETED: '삭제',
  ACCESS_REVOKED: '권한 회수',
  INCIDENT: '보안 사고로 등록',
};

export function validateFindingResolution(d: { reason?: string; action?: string }): string | null {
  if (str(d.reason) === '') return '확인한 사유(소명)를 적어 주세요';
  if (!d.action || !(FINDING_ACTIONS as readonly string[]).includes(d.action)) return '사후조치를 골라 주세요';
  return null;
}

export const COMPLIANCE_ACTIONS = ['register', 'takedown', 'withdraw', 'extract', 'approve', 'reject', 'submit', 'determine', 'file', 'close', 'completeReview', 'resolveFinding', 'selfResolve'] as const;
export type ComplianceAction = (typeof COMPLIANCE_ACTIONS)[number];
export interface Availability {
  enabled: boolean;
  reason?: string;
}

const PHONE_WHY = '등록과 집행은 태블릿이나 데스크톱에서 합니다';

/** 화면 단추의 막힘. 권한의 정본은 서버이고 화면은 편의다(ASVS 8.3.1). 모든 동작 키를 돌려준다 */
export function actionAvailability(o: {
  role: ComplianceRole;
  tab: ComplianceTab;
  layout: ComplianceLayout;
  view: 'FULL' | 'SUMMARY' | 'UNKNOWN';
  detail?: Record<string, unknown> | null;
  demo?: boolean;
}): Record<ComplianceAction, Availability> {
  const phone = o.layout === 'phone';
  const writeRole = o.role === 'operator' || o.role === 'commander';
  const write = writeRole && !phone;
  const commander = o.role === 'commander' && !phone;
  const full = o.view === 'FULL';
  const detail = o.detail ?? {};
  const status = typeof detail.status === 'string' ? detail.status : '';
  const decidedAt = detail.decidedAt;
  const duties = Array.isArray(detail.duties) ? (detail.duties as { doneAt?: unknown }[]) : [];
  const allDutiesDone = duties.length > 0 && duties.every((d) => typeof d.doneAt === 'string' && d.doneAt !== '');
  const self = detail.self === true;
  const requestedBySelf = detail.requestedBySelf === true;
  const blocked = (reason: string): Availability => ({ enabled: false, reason });
  const allowed: Availability = { enabled: true };

  const out: Record<ComplianceAction, Availability> = {
    register: write && o.tab !== 'access-reviews' ? allowed : blocked(phone ? PHONE_WHY : writeRole ? '이 탭에서는 등록할 수 없습니다' : '등록은 operator 이상만 할 수 있습니다'),
    takedown: write && full && o.tab === 'requests' && status === 'OPEN' ? allowed : blocked(phone ? PHONE_WHY : !full ? '건 요약만 보이는 역할은 집행할 수 없습니다' : '차단할 수 있는 상태가 아닙니다'),
    withdraw: write && full && o.tab === 'requests' && status === 'TAKEN_DOWN' ? allowed : blocked(phone ? PHONE_WHY : '차단한 통보만 철회로 복원할 수 있습니다'),
    extract: write && full && o.tab === 'requests' && status === 'RECEIVED' ? allowed : blocked(phone ? PHONE_WHY : !full ? '건 요약만 보이는 역할은 요청할 수 없습니다' : '접수 상태에서만 추출을 요청할 수 있습니다'),
    approve:
      commander && full && status === 'PENDING_APPROVAL' && !requestedBySelf
        ? allowed
        : blocked(
            requestedBySelf
              ? '요청한 분은 승인할 수 없습니다. 다른 commander가 승인합니다'
              : phone
                ? PHONE_WHY
                : o.role !== 'commander'
                  ? '자료 추출 승인은 commander만 할 수 있습니다'
                  : '승인 대기 상태가 아닙니다',
          ),
    reject:
      commander && full && status === 'PENDING_APPROVAL' && !requestedBySelf
        ? allowed
        : blocked(requestedBySelf ? '요청한 분은 거부할 수 없습니다. 다른 commander가 판단합니다' : '승인 대기 상태에서만 거부할 수 있습니다'),
    submit: write && full && o.tab === 'requests' && status === 'EXTRACTED' ? allowed : blocked(phone ? PHONE_WHY : '제출 파일이 만들어진 뒤에만 제출을 기록할 수 있습니다'),
    determine:
      commander && o.tab === 'incidents' && !decidedAt
        ? allowed
        : blocked(phone ? PHONE_WHY : o.role !== 'commander' ? '보안 사고 해당 판단은 commander만 할 수 있습니다' : decidedAt ? '판단은 한 번만 기록합니다. 고칠 일은 사후 검토에 적습니다' : '판단할 수 있는 상태가 아닙니다'),
    file:
      write && full && o.tab === 'incidents' && typeof decidedAt === 'string' && decidedAt !== ''
        ? allowed
        : blocked(phone ? PHONE_WHY : !decidedAt ? 'commander가 해당 판단을 기록한 뒤에 신고·통지를 기록할 수 있습니다.' : '기록할 수 있는 상태가 아닙니다'),
    close:
      write && o.tab === 'incidents' && status === 'OPEN' && typeof decidedAt === 'string' && decidedAt !== '' && allDutiesDone
        ? allowed
        : blocked(
            phone
              ? PHONE_WHY
              : typeof decidedAt !== 'string' || decidedAt === ''
                ? '해당 판단을 기록하고 남은 신고·통지 의무를 모두 기록하면 닫을 수 있습니다.'
                : '남은 신고·통지 의무를 모두 기록하면 닫을 수 있습니다.',
          ),
    completeReview: o.role === 'commander' && !phone ? allowed : blocked(phone ? PHONE_WHY : '접속기록 정기 점검은 commander만 합니다'),
    resolveFinding:
      o.role === 'commander' && !phone && !(self && !o.demo)
        ? allowed
        : blocked(phone ? PHONE_WHY : self && !o.demo ? '본인 접속기록은 다른 commander가 점검하고 종결합니다.' : '이상 건 종결은 commander만 합니다'),
    selfResolve: o.demo && o.role === 'commander' && !phone && self ? allowed : blocked(self && !o.demo ? '본인 접속기록은 다른 commander가 점검하고 종결합니다.' : '데모 환경의 본인 이상 건에만 쓸 수 있습니다'),
  };
  return out;
}

export interface DutyRow {
  duty: string;
  label: string;
  dueAt: string | null;
  doneAt: string | null;
  remainingMs: number;
  tone: Tone;
}

export function incidentDutyView(incident: Record<string, unknown>, nowMs: number): DutyRow[] {
  const duties = Array.isArray(incident.duties) ? (incident.duties as { duty?: unknown; dueAt?: unknown; doneAt?: unknown }[]) : [];
  return duties.map((d) => {
    const duty = typeof d.duty === 'string' ? d.duty : '';
    const dueAt = typeof d.dueAt === 'string' ? d.dueAt : null;
    const doneAt = typeof d.doneAt === 'string' ? d.doneAt : null;
    const dl = deadlineView(dueAt, nowMs);
    return { duty, label: DUTY_LABELS[duty] ?? duty, dueAt, doneAt, remainingMs: dl.remainingMs, tone: doneAt ? 'ok' : dl.tone };
  });
}

const COPY: Record<string, { title: string; required: string[] }> = {
  A: { title: '[피켓] 개인정보 유출 사실을 알려 드립니다', required: ['유출된 개인정보 항목', '유출 시점과 경위', '회원님이 하실 수 있는 일', '대응 조치와 피해 구제 절차', '피해 신고·문의', '법적 권리와 행사 방법'] },
  A2: { title: '[피켓] 개인정보 유출 가능성을 알려 드립니다', required: ['유출 가능성이 있는 항목', '의심 시점과 경위', '회원님이 하실 수 있는 일', '대응 조치와 피해 구제 절차', '피해 신고·문의'] },
  A3: { title: '[피켓] 개인정보가 유출되지 않은 것으로 확인되었습니다', required: ['확인 일시', '조사 결과 요약', '문의처'] },
  B: { title: '[피켓] 침해사고 발생과 대응 내용을 알려 드립니다', required: ['발생 일시·원인·피해 내용', '대응 현황', '회원님이 하실 수 있는 일', '피해 구제 조치', '피해 구제 문의'] },
};

export function noticeUserCopy(kind: string): { title: string; required: string[] } {
  return COPY[kind] ?? COPY.A;
}

/** 재인증 동작: 추출 요청·승인만 수사기관 자료(AUTHORITY_DATA). 나머지는 서버가 요구하지 않는다 */
export function reauthActOf(action: ComplianceAction): ReauthAct | null {
  return action === 'extract' || action === 'approve' ? 'AUTHORITY_DATA' : null;
}

/** 문제 응답 → 우리 글. 서버 title·detail은 싣지 않는다(frontend §4.1) */
export function complianceProblemMessage(e: { status?: number; type?: string; detail?: string }): string {
  const status = typeof e.status === 'number' ? e.status : 0;
  const type = (e.type ?? '').split('/').pop() ?? '';
  if (status === 403 && type === 'reauth-required') return '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다. 다시 인증해 주세요';
  if (status === 403) return '이 작업을 할 권한이 없습니다';
  if (status === 404) return '찾을 수 없습니다. 목록에서 다시 골라 주세요';
  if (status === 409 && type === 'already-taken-down') return '이미 차단했거나 철회한 통보입니다';
  if (status === 409) return '이미 처리되었거나 지금 상태에서는 할 수 없습니다. 목록을 다시 읽어 주세요';
  if (status === 413) return '파일이 너무 큽니다. PDF 한 파일 20MB까지 받습니다';
  if (status === 415) return 'PDF만 받습니다. 확장자와 첫 바이트가 PDF인지 확인해 주세요';
  if (status === 422 && (type === 'hash-mismatch' || (e.detail ?? '').includes('해시'))) return '내려받은 제출 파일과 해시가 다릅니다. 승인된 파일을 다시 내려받아 주세요';
  if (status === 422) return '입력한 값을 다시 확인해 주세요';
  if (status === 503) return '지금은 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요';
  if (status >= 500) return '일시적인 오류입니다. 잠시 후 다시 시도해 주세요';
  return '요청을 마치지 못했습니다. 잠시 뒤 다시 시도해 주세요';
}
