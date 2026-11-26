// F-10-2 이미지 작업 워커(계획 docs/review/plans/F-10-2.md E4·§3·§5, HOT-200, ADR-0148 결정 8).
// 작업 원장에서 due 작업을 lease로 집어 image-worker에 맡기고 결과를 적는다. SCAN_PENDING 60초·무응답 5초·10회 DEAD.
// 첫 시도(attempts 0)의 게시는 core-svc 요청 경로가 맡고, 재시도로 늦게 성공한 파생본만 워커가 공개 위치로 옮긴다.
import type { Clock } from '@peaket/platform';
import { type ImageObjectStore, type ImageProcessing, ImageProcessingUnavailable, type ProcessableImageKind } from '../domain/media-ports.js';
import { derivativeNames, type DerivativeKind } from '../domain/production-image.js';
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
      await this.#cleanup(job, now);
      out.done++;
      return;
    }
    try {
      const outcome = await this.d.processing.process({ sourceKey: job.sourceKey, kind: processableKind(job.kind), timeoutMs: 30_000 });
      if (outcome.status === 'ACCEPTED') {
        // 첫 시도는 요청 경로가 게시한다. 재시도로 늦게 성공하면 여기서 준비 위치를 공개 위치로 옮긴다.
        if (job.attempts > 0) await this.#publish(outcome.derivativeKeys);
        await this.#save(job, now, { status: 'DONE', attempts: job.attempts + 1, resultStatus: 'ACCEPTED' }, { width: outcome.width, height: outcome.height, derivativeKeys: outcome.derivativeKeys, rejectReason: null });
        out.done++;
        return;
      }
      if (outcome.status === 'REJECTED') {
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

  async #publish(keys: readonly string[]): Promise<void> {
    for (const staging of keys) {
      const bytes = await this.d.objects.readStaging(staging);
      if (!bytes) continue;
      const ext = staging.slice(staging.lastIndexOf('.') + 1);
      await this.d.objects.putPublic(publicFromStaging(staging), bytes, CONTENT_TYPES[ext]!);
    }
  }

  async #cleanup(job: ImageJobRecord, now: Date): Promise<void> {
    for (const key of job.derivativeKeys) {
      try {
        await this.d.objects.deletePublic(key);
      } catch {
        // 이미 없으면 그만이다
      }
    }
    const kind = kindOfSource(job.sourceKey);
    const id = idOf(job.sourceKey);
    const prefix = kind === 'HOME_BANNER' ? 'banner' : kind === 'REVIEW_PHOTO' ? 'review' : 'production';
    for (const name of derivativeNames(20_000, derivativeKind(kind))) {
      try {
        await this.d.objects.deleteStaging(`staging/${prefix}/${id}/${name}`);
      } catch {
        // 이미 없으면 그만이다
      }
    }
    try {
      await this.d.objects.deleteQuarantine(`quarantine/${prefix}/${id}`);
    } catch {
      // 이미 없으면 그만이다
    }
    await this.d.store.save({ ...job, status: 'DONE', attempts: job.attempts + 1, nextAttemptAt: null, leaseUntil: null, resultStatus: 'DELETED', derivativeKeys: [], rejectReason: null, updatedAt: now });
    this.d.log?.({ event: 'image_job_cleanup', id: job.id, kind, attempts: job.attempts, maxAttempts: IMAGE_JOB_MAX_ATTEMPTS });
  }
}
