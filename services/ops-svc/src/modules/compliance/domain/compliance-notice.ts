// 법정 통보 한 건의 순수 규칙(F-07-11, LCH-160, POL-024, control-tower §9).
// 접수 기한(24시간·고시 10시간), 사유·요약 정규화, 상태·역할별 보이는 칸을 정한다. 저장소·HTTP와 분리한다.
export const COMPLIANCE_REQUESTERS = ['AGENCY', 'POLICE'] as const;
export const COMPLIANCE_DEADLINES = ['H24', 'H10'] as const;
export const COMPLIANCE_STATUSES = ['OPEN', 'TAKEN_DOWN', 'WITHDRAWN'] as const;
export const COMPLIANCE_ACTIONS = ['TAKEDOWN', 'WITHDRAWAL'] as const;
export const COMPLIANCE_REASON_MAX = 2_000;
export const COMPLIANCE_SUMMARY_MAX = 2_000;
export const COMPLIANCE_AGENCY_MAX = 100;

export type ComplianceRequester = (typeof COMPLIANCE_REQUESTERS)[number];
export type ComplianceDeadline = (typeof COMPLIANCE_DEADLINES)[number];
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];
export type ComplianceAction = (typeof COMPLIANCE_ACTIONS)[number];

export interface ComplianceNoticeRecord {
  readonly noticeId: string;
  /** 등록한 관리 계정 ID. (requestedBy, idempotencyKey)가 멱등 범위다 */
  readonly requestedBy: string;
  readonly idempotencyKey: string;
  /** 같은 키의 다른 본문을 가려내는 SHA-256(hex). 공개하지 않는다 */
  readonly requestHash: string;
  readonly requester: ComplianceRequester;
  readonly agencyName: string;
  readonly receivedAtMs: number;
  readonly deadline: ComplianceDeadline;
  readonly dueAtMs: number;
  readonly reviewIds: readonly string[];
  readonly summary: string;
  readonly status: ComplianceStatus;
  readonly takenDownAtMs?: number;
  readonly withdrawnAtMs?: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ComplianceActionRecord {
  readonly actionId: string;
  readonly noticeId: string;
  readonly action: ComplianceAction;
  readonly idempotencyKey: string;
  /** 메서드·경로·본문 SHA-256(hex) */
  readonly requestHash: string;
  readonly reason: string;
  /** 관리 계정 가명 참조(ADR-0149). 계정 ID를 그대로 남기지 않는다 */
  readonly actorRef: string;
  readonly createdAtMs: number;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** NFC 뒤 제어·양방향 제어 문자를 지운다(ASVS 1.3.3) */
export function normalizeNoticeText(raw: string): string {
  return raw.normalize('NFC').replace(CONTROL, '');
}

export function dueAtOf(receivedAtMs: number, deadline: ComplianceDeadline): number {
  return receivedAtMs + (deadline === 'H10' ? 10 : 24) * 60 * 60 * 1000;
}

/** 요약·사유의 길이 상한. grapheme이 아니라 코드 포인트 수로 세지 않고 정본의 글자 수(Intl.Segmenter)로 센다 */
const SEGMENTER = new Intl.Segmenter('ko', { granularity: 'grapheme' });
export function graphemes(text: string): number {
  let n = 0;
  for (const _ of SEGMENTER.segment(text)) n += 1;
  return n;
}

export function normalizeSummary(raw: string | undefined): string {
  const text = normalizeNoticeText(raw ?? '');
  if (graphemes(text) > COMPLIANCE_SUMMARY_MAX) throw new Error('summary-too-long');
  return text;
}

export function normalizeReason(raw: string): string {
  const text = normalizeNoticeText(raw);
  if (graphemes(text) < 1 || graphemes(text) > COMPLIANCE_REASON_MAX) throw new Error('reason-invalid');
  return text;
}

export function isFullView(role: string | undefined): boolean {
  return role === 'operator' || role === 'commander';
}

export function isReadView(role: string | undefined): boolean {
  return role === 'operator' || role === 'commander' || role === 'cs_agent' || role === 'cs_lead';
}
