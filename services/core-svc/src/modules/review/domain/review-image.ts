// 후기 사진의 순수 규칙(F-07-10, POL-042 ⑥, ADR-0066, docs/data.md §2 review_image).
// core-svc는 원본을 디코딩하지 않는다. image-worker가 검사·다시 인코딩하고, 여기서는 종류별 기준·키·설명만 판정한다.
import { normalizeText, ReviewProblem } from './review.js';

export const REVIEW_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const REVIEW_IMAGE_ENVELOPE_BYTES = 64 * 1024;
export const REVIEW_IMAGE_MIN_SHORT_SIDE = 320;
export const REVIEW_IMAGE_LONG_SIDE_MAX = 20_000;
export const REVIEW_IMAGE_PIXELS_MAX = 40_000_000;
export const REVIEW_IMAGE_ALT_MAX = 100;
export const REVIEW_IMAGE_UPLOAD_LIMIT_PER_HOUR = 30;
export const REVIEW_IMAGE_UNATTACHED_TTL_MS = 24 * 60 * 60 * 1000;
export const REVIEW_IMAGE_DERIVATIVE_MAX_BYTES = 5 * 1024 * 1024;
export const REVIEW_IMAGE_CLEANUP_BATCH = 100;
/** 하루 정리 한 번에 도는 묶음 상한. 시간당 30장(하루 720장)을 한 번에 따라잡는다 */
export const REVIEW_IMAGE_CLEANUP_MAX_BATCHES = 100;
export const REVIEW_IMAGE_UPLOAD_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;
export const FAN_MULTIPART_BULKHEAD = { name: 'fan-multipart', limit: 8, retryAfterSeconds: 10 } as const;

export type ReviewImageStatus = 'UPLOADED' | 'SCANNING' | 'READY' | 'REJECTED' | 'DELETED';
export type ReviewImageRejectReason = 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'TOO_SMALL' | 'MALWARE';

export interface ReviewImageRecord {
  readonly imageId: string;
  readonly reviewId: string | null;
  readonly accountId: string;
  readonly status: ReviewImageStatus;
  readonly rejectReason?: ReviewImageRejectReason;
  readonly altText: string;
  readonly width: number;
  readonly height: number;
  readonly sort: number;
  readonly thumbKey: string;
  readonly viewKey: string;
  readonly createdAtMs: number;
  readonly attachedAtMs?: number;
  readonly deletedAtMs?: number;
}

export interface ReviewImageAttach {
  readonly imageId: string;
  readonly alt?: string;
}

export interface ReviewImageView {
  readonly imageId: string;
  readonly thumbnailUrl: string;
  readonly url: string;
  readonly alt?: string;
  readonly width: number;
  readonly height: number;
}

export const reviewImageDerivativeNames = (): readonly string[] => ['240.webp', '1280.webp'];
export const reviewImageQuarantineKey = (imageId: string) => `quarantine/review/${imageId}`;
export const reviewImageStagingKey = (imageId: string, name: string) => `staging/review/${imageId}/${name}`;
export const reviewImagePublicKey = (imageId: string, name: string) => `review/${imageId}/${name}`;
export const reviewImageThumbKey = (imageId: string) => reviewImagePublicKey(imageId, '240.webp');
export const reviewImageViewKey = (imageId: string) => reviewImagePublicKey(imageId, '1280.webp');
export const reviewImageBaseUrl = (origin: string, imageId: string) => `${origin.replace(/\/+$/, '')}/review/${imageId}`;
export const reviewImageThumbnailUrl = (origin: string, imageId: string) => `${reviewImageBaseUrl(origin, imageId)}/240.webp`;
export const reviewImageViewUrl = (origin: string, imageId: string) => `${reviewImageBaseUrl(origin, imageId)}/1280.webp`;

/** 돌아온 파생본 키가 정확히 그 이미지의 준비 위치 두 개인가(모자람·남음·겹침·접두사 밖은 아니다) */
export function reviewImageDerivativeKeysMatch(imageId: string, keys: readonly string[]): boolean {
  const want = reviewImageDerivativeNames().map((n) => reviewImageStagingKey(imageId, n));
  return keys.length === want.length && new Set(keys).size === keys.length && want.every((k) => keys.includes(k));
}

/** 처리 작업이 돌려준 폭·높이를 다시 본다(짧은 변 320, 긴 변 20,000, 4,000만 화소) */
export function reviewImageSpecViolation(width: number, height: number): 'TOO_SMALL' | 'TOO_LARGE' | undefined {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return 'TOO_LARGE';
  if (Math.min(width, height) < REVIEW_IMAGE_MIN_SHORT_SIDE) return 'TOO_SMALL';
  if (Math.max(width, height) > REVIEW_IMAGE_LONG_SIDE_MAX || width * height > REVIEW_IMAGE_PIXELS_MAX) return 'TOO_LARGE';
  return undefined;
}

/**
 * 사진 설명: NFC 정규화 뒤 제어·양방향 제어 문자를 지우고 코드 포인트 100자 이하(빈 값 허용).
 * DB CHECK(char_length)와 같은 단위로 센다(구현 리뷰 IR-06). 결합 이모지가 서버를 통과해 DB에서 500이 되지 않게 한다.
 */
export function normalizeReviewImageAlt(raw: string | undefined): string {
  if (raw === undefined) return '';
  const text = normalizeText(raw).trim();
  const n = [...text].length;
  if (n > REVIEW_IMAGE_ALT_MAX) throw new ReviewProblem('review-image-invalid', 422, `사진 설명은 ${REVIEW_IMAGE_ALT_MAX}자까지 쓸 수 있습니다`);
  return text;
}

/** 붙일 수 있는 사진인가: 같은 계정이 올린 READY이고, 아직 붙이지 않았거나 이 후기에 붙은 것 */
export function reviewImageAttachable(row: ReviewImageRecord | undefined, accountId: string, reviewId: string | null): row is ReviewImageRecord {
  return row !== undefined && row.accountId === accountId && row.status === 'READY' && (row.reviewId === null || row.reviewId === reviewId);
}

/** 화면에 보일 사진 묶음. READY만, 후기 순서대로 */
export function reviewImageView(row: ReviewImageRecord, origin: string): ReviewImageView {
  return {
    imageId: row.imageId,
    thumbnailUrl: reviewImageThumbnailUrl(origin, row.imageId),
    url: reviewImageViewUrl(origin, row.imageId),
    ...(row.altText ? { alt: row.altText } : {}),
    width: row.width,
    height: row.height,
  };
}
