// SCR-044 회차 취소·연기 요청의 실제 값: 폼 검사·KST→ISO·상태 이름·오류 매핑(d5 §6.12, transfer-refund §5).
// 순수 함수만 둔다. API 호출·화면 상태는 부르는 쪽(LiveCancellationRequest)이 맡는다.
// 파트너 응답에는 미리보기(dryRun)·결제사별 몫·판정자·내부 판정 사유가 없고, 화면도 그리지 않는다.

import type { CreatePartnerEventCancellationBody, EventCancellationKind, PartnerEventCancellationStatus } from '@/shared/api/partner-live';

export type PartnerFaultOpinion = 'ORGANIZER' | 'FORCE_MAJEURE' | 'CONTENT_CHANGE';

/** 화면의 귀책 의견 선택(없음은 본문에 싣지 않는다) */
export type FaultChoice = PartnerFaultOpinion | 'NONE';

export interface RequestForm {
  kind: EventCancellationKind;
  /** 공연장 시각(KST) 벽시계. 예 '2026-10-31T18:00' */
  newStartsAtLocal: string;
  reason: string;
  evidenceRef: string;
  faultOpinion?: FaultChoice | PartnerFaultOpinion | '의견 없음' | '주최 측 귀책' | '불가항력' | '공연 내용 변경';
}

export type RequestField = 'round' | 'newStartsAt' | 'reason' | 'evidenceRef';

export type ValidateResult = { ok: true; body: CreatePartnerEventCancellationBody } | { ok: false; field: RequestField; message: string };

/** 화면의 한국어 귀책 의견도 받아 API 열거값으로 바꾼다(모르는 값은 싣지 않는다) */
function faultOf(v: RequestForm['faultOpinion']): PartnerFaultOpinion | undefined {
  if (v === 'ORGANIZER' || v === '주최 측 귀책') return 'ORGANIZER';
  if (v === 'FORCE_MAJEURE' || v === '불가항력') return 'FORCE_MAJEURE';
  if (v === 'CONTENT_CHANGE' || v === '공연 내용 변경') return 'CONTENT_CHANGE';
  return undefined;
}

const KST_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

/**
 * `YYYY-MM-DDTHH:mm`을 KST(+09:00)로 읽어 ISO 순간으로 바꾼다. 모양이 틀리거나 없는 날짜(2월 30일 등)면 null.
 * 예: `2026-10-31T18:00` → `2026-10-31T09:00:00.000Z`
 */
export function kstLocalToIso(v: string): string | null {
  const m = KST_LOCAL.exec(v.trim());
  if (!m) return null;
  const [, ys, ms, ds, hs, mins] = m;
  const y = Number(ys);
  const month = Number(ms);
  const day = Number(ds);
  const hour = Number(hs);
  const minute = Number(mins);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const utcMs = Date.UTC(y, month - 1, day, hour - 9, minute);
  const check = new Date(utcMs + 9 * 3_600_000);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return null;
  return new Date(utcMs).toISOString();
}

const lengthOf = (v: string): number => [...v].length;

/**
 * 폼을 서버 본문으로 바꾼다. 취소에 `newStartsAt`을 싣지 않고, 연기의 바뀐 일시는 지금 공연 시작보다 늦어야 한다.
 * 사유 1~1,000자, 증빙 참조 1~200자 [가정](openapi createPartnerEventCancellation).
 */
export function validateRequest(f: RequestForm, currentStartsAtMs: number): ValidateResult {
  if (f.kind !== 'CANCEL' && f.kind !== 'POSTPONE') return { ok: false, field: 'round', message: '회차와 요청 종류를 골라 주세요' };
  const reason = f.reason.trim();
  if (lengthOf(reason) < 1 || lengthOf(reason) > 1000) return { ok: false, field: 'reason', message: '사유를 1~1,000자로 적어 주세요' };
  const evidence = f.evidenceRef.trim();
  if (evidence && lengthOf(evidence) > 200) return { ok: false, field: 'evidenceRef', message: '증빙 참조는 200자까지 적을 수 있습니다' };
  const faultOpinion = faultOf(f.faultOpinion);
  if (f.kind === 'CANCEL') {
    return { ok: true, body: { kind: 'CANCEL', reason, ...(evidence ? { evidenceRef: evidence } : {}), ...(faultOpinion ? { faultOpinion } : {}) } };
  }
  const iso = kstLocalToIso(f.newStartsAtLocal);
  if (!iso) return { ok: false, field: 'newStartsAt', message: '바뀐 일시를 공연장 시각(KST)으로 적어 주세요' };
  if (!(Date.parse(iso) > currentStartsAtMs)) return { ok: false, field: 'newStartsAt', message: '바뀐 일시는 지금 공연 시작보다 늦어야 합니다' };
  return {
    ok: true,
    body: { kind: 'POSTPONE', newStartsAt: iso, reason, ...(evidence ? { evidenceRef: evidence } : {}), ...(faultOpinion ? { faultOpinion } : {}) },
  };
}

/** '10/31(토) 18:00 KST' 같은 표시. 값이 틀리면 빈 글자 */
export function kstText(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(t))
    .replace(/\s+/g, ' ')
    .concat(' KST');
}

export interface StatusProgress {
  percent: number;
  total: number;
  done: number;
  failed: number;
}

export interface StatusView {
  label: string;
  tone: 'primary' | 'success' | 'warning' | 'danger';
  progress: StatusProgress | null;
  dueText: string | null;
}

const intAtLeast0 = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** 진행률은 합계만 본다. `failed`를 끝난 것으로 세지 않고 percent는 done/total(내림)이다 */
function progressOf(v: PartnerEventCancellationStatus['refundProgress']): StatusProgress | null {
  if (!v) return null;
  const total = intAtLeast0(v.total);
  const done = intAtLeast0(v.done);
  const failed = intAtLeast0(v.failed);
  if (total === null || done === null || failed === null) return null;
  return { percent: total === 0 ? 0 : Math.floor((done * 100) / total), total, done, failed };
}

/** 파트너 상태 아홉을 d5 §6.12 이름으로 가른다. 모르는 상태는 '알 수 없음'이고 색만으로 말하지 않는다 */
export function statusView(v: PartnerEventCancellationStatus): StatusView {
  const progress = progressOf(v.refundProgress);
  const dueText = v.status === 'REQUESTED' ? `1영업일${v.judgementDueAt ? ` · ${kstText(v.judgementDueAt)}` : ''}` : null;
  switch (v.status) {
    case 'REQUESTED':
      return { label: '판정 대기', tone: 'primary', progress, dueText };
    case 'JUDGED':
      return { label: '재판정 대기', tone: 'primary', progress, dueText };
    case 'PENDING_APPROVAL':
      return { label: '확정 대기(2인 승인)', tone: 'primary', progress, dueText };
    case 'APPROVED':
      return { label: '확정', tone: 'success', progress, dueText };
    case 'RUNNING':
      return { label: `확정 · 환불 진행 중${progress ? ` ${progress.percent}%` : ''}`, tone: 'success', progress, dueText };
    case 'PAUSED':
      return {
        label: v.pausedBy === 'AUTOMATIC' ? '일시정지(자동)' : v.pausedBy === 'OPERATOR' ? '일시정지(운영자)' : '일시정지',
        tone: 'warning',
        progress,
        dueText,
      };
    case 'REFUND_WINDOW':
      return { label: '연기 확정 · 환급 신청 기간', tone: 'warning', progress, dueText };
    case 'COMPLETED':
      return { label: '완료', tone: 'success', progress, dueText };
    case 'REJECTED':
      return { label: '반려', tone: 'danger', progress, dueText };
    default:
      return { label: '알 수 없음', tone: 'warning', progress: null, dueText: null };
  }
}

/** 화면이 가르는 요청 오류. 서버 title·detail은 보이지 않고 정본 문구만 고른다(d5 §6.12·§9.2) */
export type RequestErrorKind = 'active' | 'ended' | 'not-found' | 'date-invalid' | 'member' | 'reauth' | 'conflict' | 'other';

export interface RequestError {
  kind: RequestErrorKind;
  text: string;
  /** event-cancellation-active가 알려 준 기존 요청 ID */
  requestId?: string;
}

export interface ProblemLike {
  readonly status?: unknown;
  readonly type?: unknown;
  readonly extensions?: unknown;
}

function typeOf(v: unknown): string {
  return typeof v === 'string' ? (v.split('/').pop() ?? '') : '';
}

function requestIdOf(extensions: unknown, body: unknown): string | undefined {
  for (const source of [extensions, body]) {
    if (typeof source !== 'object' || source === null) continue;
    const v = (source as Record<string, unknown>).requestId;
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/** 409 `event-cancellation-active`(기존 요청 ID 동반)·`event-ended`, 404, 422, 403 실무자·재인증을 가른다 */
export function errorOf(e: ProblemLike | null | undefined): RequestError {
  const status = typeof e?.status === 'number' ? e.status : 0;
  const type = typeOf(e?.type);
  if (status === 409 && type === 'event-cancellation-active') {
    const requestId = requestIdOf(e?.extensions, e);
    return { kind: 'active', text: '이미 요청한 회차입니다', ...(requestId ? { requestId } : {}) };
  }
  if (status === 409 && type === 'event-ended') return { kind: 'ended', text: '종료된 회차는 요청할 수 없습니다' };
  if (status === 404) return { kind: 'not-found', text: '찾을 수 없습니다' };
  if (status === 422 && type === 'postponement-date-invalid') return { kind: 'date-invalid', text: '바뀐 일시는 지금 공연 시작보다 늦어야 합니다' };
  if (status === 403 && (type === 'partner-admin-required' || type === 'partner_member')) return { kind: 'member', text: '회차 취소·연기 요청은 파트너 관리자만 할 수 있습니다' };
  if (status === 403 && type === 'reauth-required') return { kind: 'reauth', text: '다시 인증해야 합니다. 파트너 관리자로 다시 로그인한 뒤 시도해 주세요' };
  if (status === 409) return { kind: 'conflict', text: '지금 상태에서는 요청할 수 없습니다. 새로 고친 뒤 다시 시도해 주세요' };
  return { kind: 'other', text: '요청을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요' };
}
