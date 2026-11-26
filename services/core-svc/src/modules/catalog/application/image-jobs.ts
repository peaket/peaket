// F-10-2 이미지 작업 워커(계획 docs/review/plans/F-10-2.md E4·§3·§5, HOT-200, ADR-0148 결정 8).
// 작업 원장에서 due 작업을 lease로 집어 image-worker에 맡기고 결과를 적는다. SCAN_PENDING 60초·무응답 5초·10회 DEAD.
// 첫 시도(attempts 0)의 게시는 core-svc 요청 경로가 맡고, 재시도로 늦게 성공한 파생본만 워커가 공개 위치로 옮긴다.
import type { Clock } from '@peaket/platform';
import { type ImageObjectStore, type ImageProcessing, ImageProcessingUnavailable, type ProcessableImageKind } from '../domain/media-ports.js';
import { DERIVATIVE_MAX_BYTES, derivativeFormatOk, derivativeNames, type DerivativeKind, LONG_SIDE_MAX, PIXELS_MAX, specViolation } from '../domain/production-image.js';
import { IMAGE_JOB_MAX_ATTEMPTS, nextImageJobState, type ImageJobKind, type ImageJobRecord } from '../domain/image-job.js';

export interface ImageJobWorkerDeps {
  readonly store: {
    find(sourceKey: string): Promise<ImageJobRecord | undefined>;
    leaseDue(now: Date, limit: number, leaseMs: number): Promise<ImageJobRecord[]>;
    save(record: ImageJobRecord): Promise<void>;
  };
  readonly processing: ImageProcessing;
  readonly objects: ImageObjectStore;
  readonly clock: Clock;
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface ImageJobRunResult {
  claimed: number;
  done: number;
  retrying: number;
  dead: number;
}

const LEASE_MS = 60_000;
const LIMIT = 10;
const CONTENT_TYPES: Record<string, string> = { avif: 'image/avif', webp: 'image/webp' };

const processableKind = (kind: ImageJobKind): ProcessableImageKind => (kind === 'HOME_BANNER' ? 'HOME_BANNER' : kind === 'REVIEW_PHOTO' ? 'REVIEW_PHOTO' : 'POSTER');
const derivativeKind = (kind: ImageJobKind): DerivativeKind => (kind === 'HOME_BANNER' ? 'HOME_BANNER' : kind === 'REVIEW_PHOTO' ? 'REVIEW_PHOTO' : 'POSTER');
const prefixOfJob = (kind: ImageJobKind): 'production' | 'banner' | 'review' => (kind === 'HOME_BANNER' ? 'banner' : kind === 'REVIEW_PHOTO' ? 'review' : 'production');
const kindOfSource = (sourceKey: string): ImageJobKind => (sourceKey.includes('/banner/') ? 'HOME_BANNER' : sourceKey.includes('/review/') ? 'REVIEW_PHOTO' : 'PRODUCTION');
const idOf = (sourceKey: string) => sourceKey.slice(sourceKey.lastIndexOf('/') + 1);
const publicFromStaging = (key: string) => key.replace(/^staging\//, '');

/** 작업 원장 한 바퀴. 시험은 `runOnce(now)`로 시계를 직접 준다. */
export class ImageJobWorker {
  #running = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly d: ImageJobWorkerDeps) {}

  start(intervalMs = 1_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.runOnce().catch((e: unknown) => this.d.log?.({ event: 'image_job_worker_failed', error: e instanceof Error ? e.name : 'unknown' }));
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(now: Date = new Date(this.d.clock.now())): Promise<ImageJobRunResult> {
    if (this.#running) return { claimed: 0, done: 0, retrying: 0, dead: 0 };
    this.#running = true;
    const out: ImageJobRunResult = { claimed: 0, done: 0, retrying: 0, dead: 0 };
    try {
      const due = await this.d.store.leaseDue(now, LIMIT, LEASE_MS);
      out.claimed = due.length;
      for (const job of due) await this.#one(job, now, out);
      return out;
    } finally {
      this.#running = false;
    }
  }

  async #one(job: ImageJobRecord, now: Date, out: ImageJobRunResult): Promise<void> {
    if (job.kind === 'CLEANUP') {
      // 지우기 실패를 DONE·DELETED로 적지 않는다. 다음 바퀴에 다시 지우고, 10회면 DEAD다(IR-07).
      try {
        await this.#cleanup(job, now);
        out.done++;
      } catch {
        await this.#retry(job, now, 'UNAVAILABLE', out);
      }
      return;
    }
    try {
      const outcome = await this.d.processing.process({ sourceKey: job.sourceKey, kind: processableKind(job.kind), timeoutMs: 30_000 });
      if (outcome.status === 'ACCEPTED') {
        // 첫 시도는 요청 경로가 게시한다. 재시도로 늦게 성공하면 여기서 검증·게시하고 원본·준비 위치를 지운다.
        if (job.attempts > 0) {
          await this.#publish(job, outcome);
          await this.#discard(job);
        }
        await this.#save(job, now, { status: 'DONE', attempts: job.attempts + 1, resultStatus: 'ACCEPTED' }, { width: outcome.width, height: outcome.height, derivativeKeys: outcome.derivativeKeys, rejectReason: null });
        out.done++;
        return;
      }
      if (outcome.status === 'REJECTED') {
        // 늦게 악성·형식 불일치로 끝난 원본도 남기지 않는다(IR-02).
        await this.#discard(job);
        await this.#save(job, now, { status: 'DONE', attempts: job.attempts + 1, resultStatus: 'REJECTED' }, { rejectReason: outcome.reason, derivativeKeys: [] });
        out.done++;
        return;
      }
      if (outcome.status === 'SCAN_PENDING') {
        await this.#retry(job, now, 'SCAN_PENDING', out);
        return;
      }
      await this.#retry(job, now, 'UNAVAILABLE', out);
    } catch (e) {
      const reason = e instanceof ImageProcessingUnavailable ? e.detail || 'UNAVAILABLE' : 'UNAVAILABLE';
      await this.#retry(job, now, reason === 'SCAN_PENDING' ? 'SCAN_PENDING' : 'UNAVAILABLE', out);
    }
  }

  async #retry(job: ImageJobRecord, now: Date, reason: 'SCAN_PENDING' | 'UNAVAILABLE', out: ImageJobRunResult): Promise<void> {
    const next = nextImageJobState({ status: job.status, attempts: job.attempts, outcome: reason, now });
    // 10번째 시도까지는 다시 맡기고, 그 시도의 결과가 또 재시도면 DEAD로 둔다(요청은 503).
    const capped = next.status === 'RETRYING' && next.attempts >= IMAGE_JOB_MAX_ATTEMPTS ? { status: 'DEAD' as const, attempts: next.attempts } : next;
    await this.#save(job, now, capped, { rejectReason: reason });
    if (capped.status === 'DEAD') out.dead++;
    else out.retrying++;
  }

  async #save(job: ImageJobRecord, now: Date, next: { status: ImageJobRecord['status']; attempts: number; nextAttemptAt?: Date; resultStatus?: ImageJobRecord['resultStatus'] }, extra: Partial<Pick<ImageJobRecord, 'width' | 'height' | 'derivativeKeys' | 'rejectReason'>>): Promise<void> {
    await this.d.store.save({
      ...job,
      status: next.status,
      attempts: next.attempts,
      nextAttemptAt: next.nextAttemptAt ?? null,
      leaseUntil: null,
      resultStatus: next.resultStatus ?? null,
      width: extra.width ?? job.width,
      height: extra.height ?? job.height,
      derivativeKeys: extra.derivativeKeys ?? job.derivativeKeys,
      rejectReason: extra.rejectReason !== undefined ? extra.rejectReason : job.rejectReason,
      updatedAt: now,
    });
  }

  /**
   * 재시도로 늦게 성공한 결과를 다시 본 뒤 공개한다(IR-01): 키가 이 이미지의 준비 위치 정확한 집합인지,
   * 원본 폭·화소가 범위 안인지, 준비 객체가 5MiB 이하이고 이름의 형식(매직 바이트)과 맞는지 확인한다.
   * 일부만 공개한 뒤 실패하면 이번에 새로 쓴 키를 되돌리고 재시도로 넘긴다(IR-07).
   */
  async #publish(job: ImageJobRecord, outcome: { width: number; height: number; derivativeKeys: readonly string[] }): Promise<void> {
    const id = idOf(job.sourceKey);
    const kind = derivativeKind(job.kind);
    const prefix = prefixOfJob(job.kind);
    const { width, height } = outcome;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new ImageProcessingUnavailable('untrusted-spec', true);
    if (Math.max(width, height) > LONG_SIDE_MAX || width * height > PIXELS_MAX) throw new ImageProcessingUnavailable('untrusted-spec', true);
    // 공연 작업은 포스터(세로형)와 상세(가로형) 중 하나로 성립해야 한다. 어느 쪽도 아니면 공개하지 않는다.
    if (job.kind === 'PRODUCTION' && specViolation('POSTER', width, height) && specViolation('DETAIL', width, height)) throw new ImageProcessingUnavailable('untrusted-spec', true);
    const names = derivativeNames(kind === 'REVIEW_PHOTO' ? Math.max(width, height) : width, kind);
    const want = names.map((n) => `staging/${prefix}/${id}/${n}`);
    if (outcome.derivativeKeys.length !== want.length || new Set(outcome.derivativeKeys).size !== want.length || !want.every((k) => outcome.derivativeKeys.includes(k))) {
      throw new ImageProcessingUnavailable('untrusted-keys', true);
    }
    const published: string[] = [];
    try {
      for (const name of names) {
        const staging = `staging/${prefix}/${id}/${name}`;
        const size = await this.d.objects.stagingSize(staging);
        if (size === undefined || size > DERIVATIVE_MAX_BYTES) throw new ImageProcessingUnavailable('untrusted-size', true);
        const bytes = await this.d.objects.readStaging(staging);
        if (!bytes || bytes.length > DERIVATIVE_MAX_BYTES || !derivativeFormatOk(name, bytes.subarray(0, 64))) throw new ImageProcessingUnavailable('untrusted-bytes', true);
        const key = publicFromStaging(staging);
        // 앞선 시도가 일부를 공개한 뒤 죽었어도 같은 키를 다시 쓰지 않고 넘어간다.
        if (this.d.objects.publicExists && (await this.d.objects.publicExists(key))) continue;
        await this.d.objects.putPublic(key, bytes, CONTENT_TYPES[name.slice(name.lastIndexOf('.') + 1)]!);
        published.push(key);
      }
    } catch (e) {
      for (const key of published) {
        try {
          await this.d.objects.deletePublic(key);
        } catch {
          // 다음 시도가 publicExists로 건너뛴다.
        }
      }
      throw e;
    }
  }

  /** 늦게 끝난 작업의 격리 원본과 준비 위치를 지운다(IR-02). 지우기 실패는 재시도로 넘긴다. */
  async #discard(job: ImageJobRecord): Promise<void> {
    const prefix = prefixOfJob(job.kind);
    const id = idOf(job.sourceKey);
    for (const name of derivativeNames(LONG_SIDE_MAX, derivativeKind(job.kind))) await this.d.objects.deleteStaging(`staging/${prefix}/${id}/${name}`);
    await this.d.objects.deleteQuarantine(`quarantine/${prefix}/${id}`);
  }

  async #cleanup(job: ImageJobRecord, now: Date): Promise<void> {
    // 삭제 실패를 삼키지 않는다: DONE·DELETED로 적으면 객체가 영원히 남는다(IR-07).
    for (const key of job.derivativeKeys) await this.d.objects.deletePublic(key);
    const kind = kindOfSource(job.sourceKey);
    const id = idOf(job.sourceKey);
    const prefix = prefixOfJob(kind);
    for (const name of derivativeNames(LONG_SIDE_MAX, derivativeKind(kind))) await this.d.objects.deleteStaging(`staging/${prefix}/${id}/${name}`);
    await this.d.objects.deleteQuarantine(`quarantine/${prefix}/${id}`);
    await this.d.store.save({ ...job, status: 'DONE', attempts: job.attempts + 1, nextAttemptAt: null, leaseUntil: null, resultStatus: 'DELETED', derivativeKeys: [], rejectReason: null, updatedAt: now });
    this.d.log?.({ event: 'image_job_cleanup', id: job.id, kind, attempts: job.attempts, maxAttempts: IMAGE_JOB_MAX_ATTEMPTS });
  }
}
