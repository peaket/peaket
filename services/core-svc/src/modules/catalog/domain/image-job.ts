// F-10-2 이미지 작업 원장 상태 전이(계획 docs/review/plans/F-10-2.md §3·§5, HOT-200,
// ADR-0148 결정 8, ADR-0257 결정 2). 순수 함수라 DB·시계를 모른다.
export type ImageJobKind = 'PRODUCTION' | 'HOME_BANNER' | 'REVIEW_PHOTO' | 'CLEANUP';
export type ImageJobStatus = 'PENDING' | 'SCANNING' | 'RETRYING' | 'DONE' | 'DEAD';
export type ImageJobOutcome = 'ACCEPTED' | 'REJECTED' | 'SCAN_PENDING' | 'UNAVAILABLE' | 'CLEANUP_DONE';

export interface ImageJobRecord {
  id: string;
  sourceKey: string;
  kind: ImageJobKind;
  status: ImageJobStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  leaseUntil: Date | null;
  resultStatus: 'ACCEPTED' | 'REJECTED' | 'DELETED' | null;
  width: number | null;
  height: number | null;
  derivativeKeys: string[];
  rejectReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NextImageJobState {
  status: ImageJobStatus;
  attempts: number;
  nextAttemptAt?: Date;
  resultStatus?: 'ACCEPTED' | 'REJECTED' | 'DELETED';
}

export const SCAN_PENDING_RETRY_MS = 60_000;
export const UNAVAILABLE_RETRY_MS = 5_000;
export const IMAGE_JOB_MAX_ATTEMPTS = 10;

/** 한 번 집은 작업의 다음 상태. DONE·DEAD는 nextAttemptAt을 두지 않는다(지운다). */
export function nextImageJobState(input: { status: ImageJobStatus; attempts: number; outcome: ImageJobOutcome; now: Date }): NextImageJobState {
  const retry = input.outcome === 'SCAN_PENDING' || input.outcome === 'UNAVAILABLE';
  if (retry && input.attempts >= IMAGE_JOB_MAX_ATTEMPTS) return { status: 'DEAD', attempts: input.attempts };
  const attempts = input.attempts + (retry ? 1 : 0);
  if (input.outcome === 'ACCEPTED') return { status: 'DONE', attempts, resultStatus: 'ACCEPTED' };
  if (input.outcome === 'REJECTED') return { status: 'DONE', attempts, resultStatus: 'REJECTED' };
  if (input.outcome === 'CLEANUP_DONE') return { status: 'DONE', attempts, resultStatus: 'DELETED' };
  return {
    status: 'RETRYING',
    attempts,
    nextAttemptAt: new Date(input.now.getTime() + (input.outcome === 'SCAN_PENDING' ? SCAN_PENDING_RETRY_MS : UNAVAILABLE_RETRY_MS)),
  };
}
