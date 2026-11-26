// 후기 사진 올리기·정리(F-07-10, POL-042 ⑥, ADR-0066). core는 원본을 디코딩하지 않고 image-worker에 맡긴다.
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import type { ImageObjectStore, ImageProcessing, ProcessOutcome } from '../../catalog/index.js';
import { agreedFormat } from '../../catalog/index.js';
import {
  REVIEW_IMAGE_CLEANUP_BATCH,
  REVIEW_IMAGE_CLEANUP_MAX_BATCHES,
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
    // 값싼 형식 검사를 통과해 image-worker를 부르는 시도부터 센다(거절·실패 포함). 세고 넣는 일은 저장소가 한 트랜잭션으로 한다
    if (!(await this.d.store.beginImageUpload(q.accountId, now, now - HOUR_MS, REVIEW_IMAGE_UPLOAD_LIMIT_PER_HOUR))) {
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
    return (await cleanupDueReviewImages(this.d.store, this.d.objects, nowMs, { batch: limit })).removed;
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

/**
 * 정리 때가 된 사진 행의 공개 파생본을 지우고, 두 파생본을 모두 지운 행만 행에서 지운다.
 * 한 객체라도 실패한 행은 남겨 다음 정기 실행에서 다시 지운다(구현 리뷰 IR-03). 묶음이 가득 차면 빈 묶음까지 이어서
 * 하루 상한(기본 10,000행) 안에서 따라잡는다(구현 리뷰 IR-08). 다시 돌려도 결과가 같다.
 */
export async function cleanupDueReviewImages(
  store: Pick<ReviewStore, 'imageRowsDueForCleanup' | 'deleteImageRows'>,
  objects: Pick<ImageObjectStore, 'deletePublic'>,
  nowMs: number,
  o: { batch?: number; maxBatches?: number; signal?: AbortSignal } = {},
): Promise<{ removed: number; failed: number }> {
  const batch = o.batch ?? REVIEW_IMAGE_CLEANUP_BATCH;
  const maxBatches = o.maxBatches ?? REVIEW_IMAGE_CLEANUP_MAX_BATCHES;
  let removed = 0;
  let failed = 0;
  for (let round = 0; round < maxBatches; round += 1) {
    if (o.signal?.aborted) break;
    const rows = await store.imageRowsDueForCleanup(nowMs, batch);
    if (rows.length === 0) break;
    const clean: string[] = [];
    for (const row of rows) {
      let ok = true;
      for (const name of reviewImageDerivativeNames()) {
        try {
          await objects.deletePublic(reviewImagePublicKey(row.imageId, name));
        } catch {
          ok = false;
        }
      }
      if (ok) clean.push(row.imageId);
    }
    if (clean.length > 0) await store.deleteImageRows(clean);
    removed += clean.length;
    failed += rows.length - clean.length;
    // 실패한 행이 있으면 같은 행을 다시 잡아 무한히 돌지 않고 다음 정기 실행에 맡긴다
    if (clean.length < rows.length) break;
    if (rows.length < batch) break;
  }
  return { removed, failed };
}

const webp = (b: Uint8Array): boolean => b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP';

const rejected = (reason: ReviewImageRejectReason): ProblemError =>
  new ProblemError({ type: 'review-image-rejected', status: 422, title: '후기 사진을 받을 수 없습니다', extensions: { extensions: { reason } } });

const unavailable = (): ProblemError =>
  new ProblemError({ type: 'review-image-unavailable', status: 503, title: '후기 사진을 잠시 확인할 수 없습니다', retryAfterSeconds: 5 });

export const REVIEW_IMAGE_ROUTE_DEADLINE_MS = 90_000;
export const REVIEW_IMAGE_MAX_BODY_BYTES = REVIEW_IMAGE_MAX_BYTES + REVIEW_IMAGE_ENVELOPE_BYTES;
export const REVIEW_IMAGE_UNATTACHED_TTL = REVIEW_IMAGE_UNATTACHED_TTL_MS;
export const normalizeAlt = normalizeReviewImageAlt;
