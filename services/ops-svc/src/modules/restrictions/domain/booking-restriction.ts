// 일반 남용 예매 제한의 도메인(F-06-4, transfer-refund §3.2·§7.2, POL-038 ⑤).
// 사유 코드·끝 시각(1년 상한)·소명 기한·판 번호·사본 모양을 순수 함수로 둔다.
export const RESTRICTION_REASONS = ['ABUSE_CANCEL', 'ABUSE_TRANSFER', 'ABUSE_MULTI_ACCOUNT', 'ABUSE_RESALE'] as const;
export type RestrictionReasonCode = (typeof RESTRICTION_REASONS)[number];
export const isRestrictionReason = (v: string): v is RestrictionReasonCode => (RESTRICTION_REASONS as readonly string[]).includes(v);

export const ONE_YEAR_MS = 365 * 86_400_000;
export const APPEAL_WINDOW_MS = 86_400_000;
export const COPY_RETRY_BASE_MS = 60_000;
export const COPY_RETRY_CAP_MS = 600_000;

export type RestrictionStatus = 'ACTIVE' | 'LIFTED' | 'EXPIRED';

export interface RestrictionRow {
  readonly restrictionId: string;
  readonly approvalId: string | null;
  readonly accountId: string;
  readonly reasonCode: string;
  readonly fraudCaseId: string | null;
  readonly confirmedBy: string | null;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly appealDueAtMs: number;
  readonly status: RestrictionStatus;
  readonly version: number;
  /** queue·purchase 두 집행 사본이 모두 반영됐는가. 화면용 사본은 세지 않는다 */
  readonly deliveryDone: boolean;
  readonly copyNextAtMs: number | null;
  readonly copyAttempts: number;
}

export interface RestrictionCopyInput {
  readonly accountId: string;
  readonly restrictionId: string;
  readonly state: 'ACTIVE' | 'LIFTED';
  readonly endsAtMs?: number;
  readonly version: number;
  readonly reasonCode?: string;
  readonly startsAtMs?: number;
  readonly appealDueAtMs?: number;
}

export const addOneYear = (ms: number): number => {
  const d = new Date(ms);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.getTime();
};

export const copyRetryDelayMs = (attempts: number): number => Math.min(COPY_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), COPY_RETRY_CAP_MS);

/** 같은 계정의 다음 판 번호(앞선 최대 + 1) */
export const nextVersionOf = (rows: readonly RestrictionRow[], accountId: string): number =>
  rows.filter((r) => r.accountId === accountId).reduce((max, r) => Math.max(max, r.version), 0) + 1;

/** 그 시각에 제한이 유효한가(화면용 사본 조회와 같은 판정) */
export const restrictionActiveAt = (r: Pick<RestrictionRow, 'status' | 'endsAtMs'>, nowMs: number): boolean => r.status === 'ACTIVE' && nowMs < r.endsAtMs;
