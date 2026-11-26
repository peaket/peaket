// 후기 사진 올리기·정리(F-07-10, POL-042 ⑥, ADR-0066). core는 원본을 디코딩하지 않고 image-worker에 맡긴다.
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { ImageObjectStore, ImageProcessing, ProcessOutcome } from '../../catalog/index.js';
import { agreedFormat } from '../../catalog/index.js';
import {
  REVIEW_IMAGE_CLEANUP_BATCH,
  REVIEW_IMAGE_DERIVATIVE_MAX_BYTES,
  REVIEW_IMAGE_ENVELOPE_BYTES,
  REVIEW_IMAGE_MAX_BYTES,
  REVIEW_IMAGE_UPLOAD_LIMIT_PER_HOUR,
  REVIEW_IMAGE_UNATTACHED_TTL_MS,
  normalizeReviewImageAlt,
  reviewImageDerivativeKeysMatch,
  reviewImageDerivativeNames,
  reviewImagePublicKey,
  reviewImageQuarantineKey,
  reviewImageSpecViolation,
  reviewImageStagingKey,
  reviewImageThumbKey,
  reviewImageThumbnailUrl,
  reviewImageViewKey,
  type ReviewImageRecord,
  type ReviewImageRejectReason,
} from '../domain/review-image.js';
import type { ReviewStore } from '../domain/ports.js';

export interface ReviewUploadFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  bytes(): Promise<Uint8Array>;
}

export interface ReviewImageUploadResult {
  readonly imageId: string;
  readonly status: 'READY';
  readonly thumbnailUrl: string;
}

const HOUR_MS = 60 * 60 * 1000;

export class ReviewImages {
  constructor(
    private readonly d: {
      readonly store: ReviewStore;
      readonly processing: ImageProcessing;
      readonly objects: ImageObjectStore;
      readonly origin: string;
      readonly clock: Clock;
      readonly logger?: { warn(o: object, msg?: string): void };
    },
  ) {}

  async upload(q: { accountId: string; file: ReviewUploadFile }): Promise<ReviewImageUploadResult> {
    const now = this.d.clock.now();
    if (q.file.size > REVIEW_IMAGE_MAX_BYTES) throw rejected('TOO_LARGE');
    const bytes = await q.file.bytes();
    const head = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
    if (agreedFormat(head, q.file.type, q.file.name) === undefined) throw rejected('UNSUPPORTED_TYPE');
    if ((await this.d.store.countImageUploadsSince(q.accountId, now - HOUR_MS)) >= REVIEW_IMAGE_UPLOAD_LIMIT_PER_HOUR) {
      throw new ProblemError({ type: 'review-image-limited', status: 429, title: '후기 사진을 너무 많이 올렸습니다', retryAfterSeconds: 60 });
    }

    const imageId = uuidv7(this.d.clock);
    const sourceKey = reviewImageQuarantineKey(imageId);
    const stagingKeys = reviewImageDerivativeNames().map((n) => reviewImageStagingKey(imageId, n));
    let outcome: ProcessOutcome;
    try {
      await this.d.objects.putQuarantine(sourceKey, bytes);
      outcome = await this.d.processing.process({ sourceKey, kind: 'REVIEW_PHOTO', timeoutMs: 30_000 });
    } catch {
      await this.#cleanup(imageId);
      throw unavailable();
    }
    if (outcome.status === 'REJECTED') {
      await this.#cleanup(imageId);
      throw rejected(outcome.reason === 'UNKNOWN' ? 'UNSUPPORTED_TYPE' : outcome.reason);
    }
    if (outcome.status !== 'ACCEPTED') {
      await this.#cleanup(imageId);
      throw unavailable();
    }
    const spec = reviewImageSpecViolation(outcome.width, outcome.height);
    if (spec !== undefined) {
      await this.#cleanup(imageId);
      throw rejected(spec);
    }
    if (!reviewImageDerivativeKeysMatch(imageId, outcome.derivativeKeys)) {
      await this.#cleanup(imageId);
      this.d.logger?.warn({ event: 'review_image_worker_untrusted', imageId, why: 'derivative_keys' }, 'image-worker가 정한 키가 아니다');
      throw unavailable();
    }
    for (const name of reviewImageDerivativeNames()) {
      const key = reviewImageStagingKey(imageId, name);
      const size = await this.d.objects.stagingSize(key);
      if (size === undefined || size > REVIEW_IMAGE_DERIVATIVE_MAX_BYTES) {
        await this.#cleanup(imageId);
        throw unavailable();
      }
      const derivative = await this.d.objects.readStaging(key);
      if (!derivative || !webp(derivative)) {
        await this.#cleanup(imageId);
        throw unavailable();
      }
      await this.d.objects.putPublic(reviewImagePublicKey(imageId, name), derivative, 'image/webp');
    }
    await this.d.objects.deleteQuarantine(sourceKey);
    for (const key of stagingKeys) await this.d.objects.deleteStaging(key);

    const row: ReviewImageRecord = {
      imageId,
      reviewId: null,
      accountId: q.accountId,
      status: 'READY',
      altText: '',
      width: outcome.width,
      height: outcome.height,
      sort: 0,
      thumbKey: reviewImageThumbKey(imageId),
      viewKey: reviewImageViewKey(imageId),
      createdAtMs: now,
    };
    try {
      await this.d.store.insertReviewImage(row);
    } catch (e) {
      await this.#cleanup(imageId);
      throw e;
    }
    return { imageId, status: 'READY', thumbnailUrl: reviewImageThumbnailUrl(this.d.origin, imageId) };
  }

  /** 붙이지 않은 24시간 지난 READY와 DELETED 행의 공개 객체·행을 지운다. 다시 돌려도 결과가 같다 */
  async cleanupDue(nowMs: number, limit = REVIEW_IMAGE_CLEANUP_BATCH): Promise<number> {
    const rows = await this.d.store.imageRowsDueForCleanup(nowMs, limit);
    for (const row of rows) {
      for (const name of reviewImageDerivativeNames()) {
        try {
          await this.d.objects.deletePublic(reviewImagePublicKey(row.imageId, name));
        } catch {
          // 남은 객체는 다음 정리가 같은 행으로 다시 본다
        }
      }
    }
    await this.d.store.deleteImageRows(rows.map((r) => r.imageId));
    return rows.length;
  }

  async #cleanup(imageId: string): Promise<void> {
    try {
      await this.d.objects.deleteQuarantine(reviewImageQuarantineKey(imageId));
    } catch {}
    for (const n of reviewImageDerivativeNames()) {
      try {
        await this.d.objects.deleteStaging(reviewImageStagingKey(imageId, n));
      } catch {}
      try {
        await this.d.objects.deletePublic(reviewImagePublicKey(imageId, n));
      } catch {}
    }
  }
}

const webp = (b: Uint8Array): boolean => b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP';

const rejected = (reason: ReviewImageRejectReason): ProblemError =>
  new ProblemError({ type: 'review-image-rejected', status: 422, title: '후기 사진을 받을 수 없습니다', extensions: { reason, extensions: { reason } } });

const unavailable = (): ProblemError =>
  new ProblemError({ type: 'review-image-unavailable', status: 503, title: '후기 사진을 잠시 확인할 수 없습니다', retryAfterSeconds: 5 });

export const REVIEW_IMAGE_ROUTE_DEADLINE_MS = 90_000;
export const REVIEW_IMAGE_MAX_BODY_BYTES = REVIEW_IMAGE_MAX_BYTES + REVIEW_IMAGE_ENVELOPE_BYTES;
export const REVIEW_IMAGE_UNATTACHED_TTL = REVIEW_IMAGE_UNATTACHED_TTL_MS;
export const normalizeAlt = normalizeReviewImageAlt;
