// F-10-2 core-svc의 ImageProcessing 작업 원장 어댑터(계획 docs/review/plans/F-10-2.md §5, ADR-0257 결정 2).
// 요청은 작업을 적고 완료를 기다린다. waitMs는 완료 확인 폴링 간격이고 총 대기 시한은 process({timeoutMs})다.
import type { Clock } from '@peaket/platform';
import { type ProcessOutcome, ImageProcessingUnavailable, type ProcessableImageKind } from '../domain/media-ports.js';
import type { ImageJobKind, ImageJobRecord } from '../domain/image-job.js';

export interface ImageJobProcessingDeps {
  readonly store: {
    enqueue(record: { sourceKey: string; kind: ImageJobKind; derivativeKeys?: string[] }, now: Date): Promise<ImageJobRecord | undefined>;
    find(sourceKey: string): Promise<ImageJobRecord | undefined>;
  };
  readonly clock: Clock;
  /** 완료 확인 폴링 간격(ms). 총 대기 시한이 아니다. */
  readonly waitMs?: number;
}

const DEFAULT_WAIT_MS = 50;

const kindOf = (kind: ProcessableImageKind): ImageJobKind => (kind === 'HOME_BANNER' ? 'HOME_BANNER' : kind === 'REVIEW_PHOTO' ? 'REVIEW_PHOTO' : 'PRODUCTION');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ImageJobProcessing {
  constructor(private readonly d: ImageJobProcessingDeps) {}

  /** 커밋 뒤 옛 파생본 정리를 같은 작업 원장에 맡긴다. */
  async enqueueCleanup(q: { sourceKey: string; kind: 'PRODUCTION' | 'HOME_BANNER' | 'REVIEW_PHOTO'; derivativeKeys: string[] }): Promise<void> {
    await this.d.store.enqueue({ sourceKey: q.sourceKey, kind: 'CLEANUP', derivativeKeys: q.derivativeKeys }, new Date(this.d.clock.now()));
  }

  async process(q: { sourceKey: string; kind: ProcessableImageKind; timeoutMs: number }): Promise<ProcessOutcome> {
    const kind = kindOf(q.kind);
    const now = new Date(this.d.clock.now());
    await this.d.store.enqueue({ sourceKey: q.sourceKey, kind }, now);
    const until = Date.now() + Math.max(1, q.timeoutMs);
    const waitMs = this.d.waitMs ?? DEFAULT_WAIT_MS;
    while (Date.now() < until) {
      const job = await this.d.store.find(q.sourceKey);
      if (!job) throw new ImageProcessingUnavailable('job-missing', true);
      if (job.status === 'DONE') return this.#outcome(job);
      if (job.status === 'DEAD') throw new ImageProcessingUnavailable('dead', true);
      if (job.status === 'RETRYING' && job.rejectReason === 'SCAN_PENDING') return { status: 'SCAN_PENDING', keepSource: true };
      if (job.status === 'RETRYING' || job.rejectReason === 'UNAVAILABLE') throw new ImageProcessingUnavailable('retrying', true);
      await sleep(waitMs);
    }
    throw new ImageProcessingUnavailable('deadline', true);
  }

  #outcome(job: ImageJobRecord): ProcessOutcome {
    if (job.resultStatus === 'ACCEPTED') return { status: 'ACCEPTED', width: job.width ?? 0, height: job.height ?? 0, derivativeKeys: job.derivativeKeys };
    if (job.resultStatus === 'REJECTED') {
      const reason = job.rejectReason;
      if (reason === 'UNSUPPORTED_TYPE' || reason === 'TOO_LARGE' || reason === 'TOO_SMALL' || reason === 'MALWARE') return { status: 'REJECTED', reason };
      return { status: 'REJECTED', reason: 'UNKNOWN' };
    }
    return { status: 'UNKNOWN' };
  }
}
