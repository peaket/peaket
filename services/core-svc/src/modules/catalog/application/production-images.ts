// 유스케이스: 공연 이미지 올리기·고치기·지우기(openapi createPartnerProductionImage·updatePartnerProductionImage·deletePartnerProductionImage,
// ADR-0257 결정 1~3, docs/data.md production_image·§5 마지막 줄, BUILD_ORDER HOT-190).
// 파드마다 동시 처리는 받는 층의 칸막이(429, 본문을 읽기 전)가 묶는다. 올리기 차례(먼저 걸린 것으로 답한다): 소속(404) → X-Requested-With(400, 받는 층) → 파일 10MB(413) → multipart 칸(400)·대체 텍스트(422 ALT_INVALID)
// → 파일 앞부분과 Content-Type·확장자(415) → 상세 10장(409) → 격리 원본 쓰기 → 남은 시간(504) → 처리(image-worker, min(30초, 남은 시간 − 2초)) → 결과 다시 검사
// → 파생본 게시 → 공연 행 잠금 안에서 장수·순서 다시 보고 행 넣기(포스터는 옛 행을 지운다) → 커밋 뒤 원본·준비 위치·옛 포스터 파생본 지우기와 무효화.
// 어떤 거절이든 원본을 지우고 행을 남기지 않는다(catalog-review 5.1.1). 원본·파생본 키는 서버가 만든 이미지 ID로만 만든다(5.3.2).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, deadlineExceeded, PLATFORM_LOGGER, type PlatformLogger, requestContext, RequestValidationError, uuidv7 } from '@peaket/platform';
import {
  CDN_INVALIDATION,
  type CdnInvalidation,
  IMAGE_OBJECT_STORE,
  IMAGE_ORIGIN,
  IMAGE_PROCESSING,
  type ImageObjectStore,
  type ImageProcessing,
  ImageProcessingUnavailable,
  PARTNER_PRODUCTION_MEDIA,
  type PartnerProductionMedia,
  type ProcessOutcome,
} from '../domain/media-ports.js';
import {
  agreedFormat,
  altValid,
  DETAIL_MAX,
  DERIVATIVE_MAX_BYTES,
  derivativeFormatOk,
  derivativeKeysMatch,
  derivativeNames,
  derivativeUrls,
  IMAGE_MAX_BYTES,
  imageBaseUrl,
  type ImageKind,
  type ProductionImageRow,
  publicKey,
  quarantineKey,
  reorderDetails,
  type SpecReason,
  specViolation,
  processingBudget,
  PROCESSING_DEADLINE_MS,
  stagingKey,
} from '../domain/production-image.js';
import type { Caller } from './import-seatmap.js';
import {
  imageLimitExceeded,
  imageProcessingUnavailable,
  imageSpecInvalid,
  imageTooLarge,
  imageTypeUnsupported,
  notFound,
  posterNotDeletable,
  preconditionFailed,
  preconditionRequired,
} from './problems.js';
import { strictFields, type UploadForm } from './upload-form.js';

/** 계약 ProductionImage */
export interface ProductionImageView {
  imageId: string;
  kind: ImageKind;
  alt: string;
  order: number;
  width: number;
  height: number;
  version: number;
  url: string;
  derivatives: Record<string, string>;
}

/** 처리 작업이 답하지 않았을 때·결과가 바뀌었을 때의 Retry-After(초) [가정] */
const RETRY_UNAVAILABLE_S = 30;
/** 악성 코드 검사 결과가 아직 없을 때의 Retry-After(초) [가정] */
const RETRY_SCAN_PENDING_S = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTENT_TYPES: Record<string, string> = { avif: 'image/avif', webp: 'image/webp' };

/** 강한 ETag "N"의 판. 다른 꼴이면 undefined(412) */
const versionOf = (etag: string): number | undefined => {
  const m = /^"([1-9]\d{0,8})"$/.exec(etag.trim());
  return m ? Number(m[1]) : undefined;
};
export const etagOf = (version: number) => `"${version}"`;

const REJECT_REASON: Record<string, (kind: ImageKind) => SpecReason | 'TYPE'> = {
  UNSUPPORTED_TYPE: () => 'TYPE',
  TOO_LARGE: () => 'PIXEL_LIMIT',
  TOO_SMALL: (kind) => (kind === 'POSTER' ? 'POSTER_SPEC' : 'DETAIL_SPEC'),
  MALWARE: () => 'MALWARE',
};

@Injectable()
export class ProductionImages {
  constructor(
    @Inject(PARTNER_PRODUCTION_MEDIA) private readonly media: PartnerProductionMedia,
    @Inject(IMAGE_PROCESSING) private readonly processing: ImageProcessing,
    @Inject(IMAGE_OBJECT_STORE) private readonly store: ImageObjectStore,
    @Inject(CDN_INVALIDATION) private readonly cdn: CdnInvalidation,
    @Inject(IMAGE_ORIGIN) private readonly origin: string,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
  ) {}

  view(r: ProductionImageRow): ProductionImageView {
    return { imageId: r.id, kind: r.kind, alt: r.alt, order: r.order, width: r.width, height: r.height, version: r.version, url: imageBaseUrl(this.origin, r.id), derivatives: derivativeUrls(this.origin, r.id) };
  }

  /** 그 테넌트의 공연이 아니면 없는 공연과 같은 404이고 실패한 인가 시도로 남긴다(catalog-review 16.3.2). 받는 층이 다른 검사보다 먼저 부른다 */
  async authorize(productionId: string, who: Caller, action: 'upload' | 'update' | 'delete'): Promise<void> {
    if (await this.media.owns(productionId, who.tenantId)) return;
    this.#denied(productionId, who, action);
    throw notFound();
  }

  async upload(q: { productionId: string; who: Caller; form: UploadForm }): Promise<ProductionImageView> {
    const base = { productionId: q.productionId, accountId: q.who.accountId };
    if (q.form.files.some((f) => f.size > IMAGE_MAX_BYTES)) {
      this.#rejected({ ...base, status: 413 });
      throw imageTooLarge();
    }
    // alt 칸이 아예 없으면 칸 구조 오류(400), 길이·글자만 422 ALT_INVALID다(ADR-0257 결정 2)
    const { file, values } = strictFields(q.form, ['kind', 'alt'], ['order']);
    const kind = values.get('kind');
    if (kind !== 'POSTER' && kind !== 'DETAIL') throw new RequestValidationError('kind');
    const rawOrder = values.get('order');
    if (rawOrder !== undefined && !/^[0-9]$/.test(rawOrder)) throw new RequestValidationError('order');
    const alt = values.get('alt')!;
    if (!altValid(alt)) {
      this.#rejected({ ...base, imageKind: kind, status: 422, reason: 'ALT_INVALID' });
      throw imageSpecInvalid('ALT_INVALID');
    }
    const bytes = await file.bytes();
    if (!agreedFormat(bytes.subarray(0, 16), file.type, file.name)) {
      // 형식 위장(확장자·Content-Type·파일 앞부분 불일치)은 보안 사건이다(catalog-review 16.3.3). 파일 이름은 싣지 않는다
      this.#warn({ kind: 'security', event: 'image_type_mismatch', ...base, imageKind: kind }, '형식이 맞지 않는 이미지를 거절했다');
      this.#rejected({ ...base, imageKind: kind, status: 415 });
      throw imageTypeUnsupported();
    }
    if (kind === 'DETAIL' && (await this.media.detailCount(q.productionId, q.who.tenantId)) >= DETAIL_MAX) {
      this.#rejected({ ...base, imageKind: kind, status: 409 });
      throw imageLimitExceeded();
    }
    // 동시 처리 수는 받는 층의 칸막이(파트너 multipart, 파드마다 4)가 본문을 읽기 전에 묶는다
    return this.#process({ ...q, kind, alt, order: rawOrder === undefined ? undefined : Number(rawOrder), bytes });
  }

  async #process(q: { productionId: string; who: Caller; kind: ImageKind; alt: string; order: number | undefined; bytes: Uint8Array }): Promise<ProductionImageView> {
    const imageId = uuidv7(this.clock);
    const at = { productionId: q.productionId, accountId: q.who.accountId, imageKind: q.kind, imageId };
    const source = quarantineKey(imageId);
    const staged = derivativeNames().map((n) => stagingKey(imageId, n));
    const discard = (published: string[] = []) => this.#cleanup(at, { quarantine: [source], staging: staged, public: published });
    let outcome: ProcessOutcome;
    try {
      await this.store.putQuarantine(source, q.bytes);
      // 맡기기 직전에 남은 시간을 본다: 처리 데드라인 = min(30초, 남은 시간 − 2초), 10초보다 작으면 맡기지 않는다(504)
      const budget = processingBudget(requestContext()?.deadline.remainingMs() ?? PROCESSING_DEADLINE_MS * 2);
      if (budget === undefined) {
        await discard();
        this.#rejected({ ...at, status: 504 });
        throw deadlineExceeded();
      }
      outcome = await this.processing.process({ sourceKey: source, kind: q.kind, timeoutMs: budget });
    } catch (e) {
      if (e instanceof Error && e.name === 'ProblemError') throw e;
      await discard();
      // 격리 원본 쓰기 실패도 처리 작업을 쓸 수 없는 것과 같은 503이다(fail-closed)
      this.#rejected({ ...at, status: 503, reason: e instanceof ImageProcessingUnavailable ? 'unavailable' : 'store' });
      throw imageProcessingUnavailable(RETRY_UNAVAILABLE_S);
    }
    if (outcome.status === 'SCAN_PENDING') {
      await discard();
      this.#rejected({ ...at, status: 503, reason: 'scan_pending' });
      throw imageProcessingUnavailable(RETRY_SCAN_PENDING_S);
    }
    if (outcome.status === 'UNKNOWN' || (outcome.status === 'REJECTED' && outcome.reason === 'UNKNOWN')) {
      await discard();
      this.#warn({ kind: 'security', event: 'image_worker_result_untrusted', ...at, why: 'unknown_status' }, 'image-worker가 정하지 않은 결과를 돌려줬다');
      throw imageProcessingUnavailable(RETRY_UNAVAILABLE_S);
    }
    if (outcome.status === 'REJECTED') {
      await discard();
      const reason = REJECT_REASON[outcome.reason]!(q.kind);
      if (reason === 'MALWARE') this.#warn({ kind: 'security', event: 'image_malware', ...at }, '악성 코드 검사에 걸린 이미지를 거절했다');
      this.#rejected({ ...at, status: reason === 'TYPE' ? 415 : 422, reason });
      throw reason === 'TYPE' ? imageTypeUnsupported() : imageSpecInvalid(reason);
    }
    const spec = specViolation(q.kind, outcome.width, outcome.height);
    if (spec) {
      await discard();
      this.#rejected({ ...at, status: 422, reason: spec });
      throw imageSpecInvalid(spec);
    }
    if (!derivativeKeysMatch(imageId, outcome.derivativeKeys)) {
      // 키가 모자라거나 남거나 접두사 밖이다: 작업 결과가 바뀐 것으로 보고 게시하지 않는다(접두사 밖 객체는 건드리지 않는다)
      await discard();
      this.#warn({ kind: 'security', event: 'image_worker_result_untrusted', ...at, why: 'derivative_keys', keyCount: outcome.derivativeKeys.length }, 'image-worker의 파생본 키가 정한 여덟 개가 아니다');
      throw imageProcessingUnavailable(RETRY_UNAVAILABLE_S);
    }
    const published: string[] = [];
    // 준비 위치의 파생본을 다시 본다: 크기를 먼저 보고(5MiB를 넘으면 읽지 않는다) 읽은 뒤 파일 앞부분이 이름의 형식과 맞는지 본다
    let why: string | undefined;
    try {
      for (const name of derivativeNames()) {
        const key = stagingKey(imageId, name);
        const size = await this.store.stagingSize(key);
        if (size === undefined) why = 'derivative_missing';
        else if (size > DERIVATIVE_MAX_BYTES) why = 'derivative_too_large';
        if (why) break;
        const data = await this.store.readStaging(key);
        if (data === undefined || data.length > DERIVATIVE_MAX_BYTES) why = 'derivative_missing';
        else if (!derivativeFormatOk(name, data.subarray(0, 64))) why = 'derivative_type';
        if (why || !data) break;
        const pub = publicKey(imageId, name);
        await this.store.putPublic(pub, data, CONTENT_TYPES[name.split('.')[1]!]!);
        published.push(pub);
      }
    } catch {
      why = 'publish_failed';
    }
    if (why) {
      await discard(published);
      if (why !== 'publish_failed') this.#warn({ kind: 'security', event: 'image_worker_result_untrusted', ...at, why }, '준비 위치의 파생본을 믿을 수 없어 게시하지 않았다');
      else this.#rejected({ ...at, status: 503, reason: why });
      throw imageProcessingUnavailable(RETRY_UNAVAILABLE_S);
    }
    const now = new Date(this.clock.now());
    const row: ProductionImageRow = { id: imageId, productionId: q.productionId, promoterId: q.who.tenantId, kind: q.kind, alt: q.alt, order: 0, width: outcome.width, height: outcome.height, version: 1, createdAt: now, updatedAt: now };
    let saved: { row: ProductionImageRow; replaced?: string } | 'limit' | 'not-found';
    try {
      saved = await this.media.withLockedProduction(q.productionId, q.who.tenantId, async (tx) => {
        const images = await tx.images();
        if (q.kind === 'POSTER') {
          const old = images.find((i) => i.kind === 'POSTER');
          if (old) await tx.remove(old.id);
          await tx.insert(row);
          return old ? { row, replaced: old.id } : { row };
        }
        const details = images.filter((i) => i.kind === 'DETAIL');
        if (details.length >= DETAIL_MAX) return 'limit' as const;
        const next = reorderDetails([...details, { id: imageId, order: Number.MAX_SAFE_INTEGER }], imageId, q.order ?? details.length);
        await this.#applyOrders(tx, details, next, now);
        const placed = { ...row, order: next.find((d) => d.id === imageId)!.order };
        await tx.insert(placed);
        return { row: placed };
      });
    } catch (e) {
      await discard(published);
      throw e;
    }
    if (saved === 'not-found' || saved === 'limit') {
      await discard(published);
      this.#rejected({ ...at, status: saved === 'limit' ? 409 : 404 });
      throw saved === 'limit' ? imageLimitExceeded() : notFound();
    }
    // 커밋 뒤: 원본·준비 위치·옛 포스터 파생본 지우기와 무효화는 뒤에서 한다(응답을 기다리게 하지 않는다. 실패는 기록으로 남긴다)
    const replaced = saved.replaced;
    this.#background(async () => {
      await this.#cleanup(at, { quarantine: [source], staging: staged, public: replaced ? derivativeNames().map((n) => publicKey(replaced, n)) : [] });
      await this.#invalidate(q.productionId);
    });
    this.#info({ event: 'production_image_uploaded', ...at, order: saved.row.order, width: saved.row.width, height: saved.row.height, ...(saved.replaced ? { replaced: saved.replaced } : {}) }, '공연 이미지를 올렸다');
    return this.view(saved.row);
  }

  async update(q: { productionId: string; imageId: string; who: Caller; ifMatch: string | undefined; alt?: string; order?: number }): Promise<ProductionImageView> {
    if (q.ifMatch === undefined) throw preconditionRequired();
    const version = versionOf(q.ifMatch);
    if (q.alt !== undefined && !altValid(q.alt)) throw new RequestValidationError('alt');
    if (!UUID.test(q.imageId)) {
      this.#imageDenied(q, 'update');
      throw notFound();
    }
    const now = new Date(this.clock.now());
    const r = await this.media.withLockedProduction(q.productionId, q.who.tenantId, async (tx) => {
      const images = await tx.images();
      const target = images.find((i) => i.id === q.imageId);
      if (!target) return 'gone' as const;
      if (version === undefined || target.version !== version) return 'stale' as const;
      if (target.kind === 'POSTER' && q.order !== undefined && q.order !== 0) return 'poster-order' as const;
      const nextAlt = q.alt ?? target.alt;
      let nextOrder = target.order;
      if (target.kind === 'DETAIL' && q.order !== undefined && q.order !== target.order) {
        const details = images.filter((i) => i.kind === 'DETAIL');
        const next = reorderDetails(details, target.id, q.order);
        await this.#applyOrders(
          tx,
          details.filter((d) => d.id !== target.id),
          next.filter((d) => d.id !== target.id),
          now,
        );
        nextOrder = next.find((d) => d.id === target.id)!.order;
      }
      if (nextAlt === target.alt && nextOrder === target.order) return target;
      const updated = { ...target, alt: nextAlt, order: nextOrder, version: target.version + 1, updatedAt: now };
      await tx.update(target.id, { alt: nextAlt, order: nextOrder, version: updated.version, updatedAt: now });
      return updated;
    });
    if (r === 'not-found') {
      this.#denied(q.productionId, q.who, 'update');
      throw notFound();
    }
    if (r === 'gone') {
      this.#imageDenied(q, 'update');
      throw notFound();
    }
    if (r === 'stale') throw preconditionFailed();
    if (r === 'poster-order') throw new RequestValidationError('포스터의 순서는 0이다');
    this.#background(() => this.#invalidate(q.productionId));
    this.#info({ event: 'production_image_updated', productionId: q.productionId, accountId: q.who.accountId, imageId: r.id, order: r.order, version: r.version }, '공연 이미지를 고쳤다');
    return this.view(r);
  }

  async remove(q: { productionId: string; imageId: string; who: Caller }): Promise<void> {
    if (!UUID.test(q.imageId)) {
      this.#imageDenied(q, 'delete');
      throw notFound();
    }
    const now = new Date(this.clock.now());
    const r = await this.media.withLockedProduction(q.productionId, q.who.tenantId, async (tx) => {
      const images = await tx.images();
      const target = images.find((i) => i.id === q.imageId);
      if (!target) return 'gone' as const;
      if (target.kind === 'POSTER') return 'poster' as const;
      await tx.remove(target.id);
      const rest = images.filter((i) => i.kind === 'DETAIL' && i.id !== target.id);
      await this.#applyOrders(tx, rest, reorderDetails(rest), now);
      return 'removed' as const;
    });
    if (r === 'not-found') {
      this.#denied(q.productionId, q.who, 'delete');
      throw notFound();
    }
    if (r === 'gone') {
      this.#imageDenied(q, 'delete');
      throw notFound();
    }
    if (r === 'poster') throw posterNotDeletable();
    // 커밋 뒤: 공개 파생본 여덟 개를 지우고 공연 태그를 무효화한다(뒤에서 한다)
    const at = { productionId: q.productionId, accountId: q.who.accountId, imageId: q.imageId };
    this.#background(async () => {
      await this.#cleanup(at, { quarantine: [], staging: [], public: derivativeNames().map((n) => publicKey(q.imageId, n)) });
      await this.#invalidate(q.productionId);
    });
    this.#info({ event: 'production_image_deleted', productionId: q.productionId, accountId: q.who.accountId, imageId: q.imageId }, '공연 이미지를 지웠다');
  }

  /** 순서가 바뀐 상세 이미지만 고친다(판을 올린다: 순서도 표현의 일부다) */
  async #applyOrders(tx: { update: (id: string, p: { order: number; version: number; updatedAt: Date }) => Promise<void> }, before: readonly ProductionImageRow[], after: readonly { id: string; order: number }[], now: Date): Promise<void> {
    for (const a of after) {
      const b = before.find((x) => x.id === a.id);
      if (b && b.order !== a.order) await tx.update(b.id, { order: a.order, version: b.version + 1, updatedAt: now });
    }
  }

  /**
   * 격리 원본·준비 위치·공개 위치 객체를 지운다. 지우지 못한 것은 위치마다 production_image_leftover 한 줄로 남긴다
   * (공개 객체라 개인정보가 없다. 정리는 HOT-200의 작업 원장, ADR-0257 결정 2·3)
   */
  async #cleanup(at: Record<string, unknown>, keys: { quarantine: string[]; staging: string[]; public: string[] }): Promise<void> {
    const del = { quarantine: (k: string) => this.store.deleteQuarantine(k), staging: (k: string) => this.store.deleteStaging(k), public: (k: string) => this.store.deletePublic(k) };
    for (const where of ['quarantine', 'staging', 'public'] as const) {
      let left = 0;
      for (const k of keys[where]) if (!(await this.#quietly(() => del[where](k)))) left++;
      if (left > 0) this.#warn({ event: 'production_image_leftover', ...at, where, count: left }, '지우지 못한 이미지 객체가 남았다');
    }
  }

  /** 응답을 기다리게 하지 않는 일(커밋 뒤 정리·무효화). 실패는 안에서 기록한다 */
  #background(fn: () => Promise<void>): void {
    void fn().catch((err: unknown) => this.#warn({ event: 'production_image_background_failed', err: err instanceof Error ? err.name : 'unknown' }, '커밋 뒤 정리가 실패했다'));
  }

  async #invalidate(productionId: string): Promise<void> {
    if (!(await this.#quietly(() => this.cdn.invalidate([`production:${productionId}`])))) this.#warn({ event: 'cdn_invalidation_failed', productionId }, '공연 태그 무효화에 실패했다');
  }

  /** 실패를 삼키고 성공 여부만 돌려준다(정리 일은 응답을 바꾸지 않는다) */
  async #quietly(fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  }

  /** 남의 공연·이 공연에 없는 이미지 ID로 고치기·지우기를 불렀다(404, 보안 사건, catalog-review 16.3.2) */
  #imageDenied(q: { productionId: string; imageId: string; who: Caller }, action: 'update' | 'delete'): void {
    this.#warn({ kind: 'security', event: 'production_image_denied', action, productionId: q.productionId, imageId: q.imageId.slice(0, 64), tenantId: q.who.tenantId, accountId: q.who.accountId }, '이 공연에 없는 이미지를 고치거나 지우려 했다');
  }

  #denied(productionId: string, who: Caller, action: string): void {
    this.#warn({ kind: 'security', event: 'partner_production_denied', route: 'production_image', action, productionId, tenantId: who.tenantId, accountId: who.accountId }, '소속이 아닌 공연의 이미지 요청을 막았다');
  }

  #rejected(line: Record<string, unknown>): void {
    this.#info({ event: 'production_image_rejected', ...line }, '공연 이미지를 받지 않았다');
  }

  #info(line: Record<string, unknown>, msg: string): void {
    try {
      this.logger?.info(line, msg);
    } catch {
      // 기록 실패는 응답을 바꾸지 않는다
    }
  }

  #warn(line: Record<string, unknown>, msg: string): void {
    try {
      this.logger?.warn(line, msg);
    } catch {
      // 기록 실패는 응답을 바꾸지 않는다
    }
  }
}
