// CDN 무효화 어댑터(ADR-0257 결정 3, ADR-0271 결정 8). 실제 CDN(CloudFront 태그·경로 무효화) 어댑터는 배포 단계다. 지금은 기록 한 줄(개발)과 메모리(시험)다.
// 경로 무효화는 무효화 요청 ID를 돌려준다(운영은 CloudFront CreateInvalidation의 Invalidation.Id). 개발·메모리 어댑터는 부를 때마다 겹치지 않는 가짜 ID다.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import type { CdnInvalidation, ImageProcessing, SeatmapParser } from '../domain/media-ports.js';
import { ImageProcessingUnavailable, SeatmapWorkerUnavailable } from '../domain/media-ports.js';

@Injectable()
export class LogCdnInvalidation implements CdnInvalidation {
  constructor(@Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info'>) {}
  async invalidate(tags: string[]): Promise<void> {
    this.logger?.info({ event: 'cdn_invalidate', tags }, 'CDN 태그를 무효화한다(개발: 기록만)');
  }
  async invalidatePaths(paths: string[]): Promise<{ requestId: string }> {
    const requestId = `dev-${randomUUID()}`;
    this.logger?.info({ event: 'cdn_invalidate_paths', paths, requestId }, 'CDN 경로를 무효화한다(개발: 기록만)');
    return { requestId };
  }
}

/** 시험용: 부른 태그를 차례대로 모은다 */
export class MemoryCdnInvalidation implements CdnInvalidation {
  readonly calls: string[][] = [];
  async invalidate(tags: string[]): Promise<void> {
    this.calls.push([...tags]);
  }
  /** 부른 경로를 차례대로 모은다 */
  readonly pathCalls: string[][] = [];
  async invalidatePaths(paths: string[]): Promise<{ requestId: string }> {
    this.pathCalls.push([...paths]);
    return { requestId: `mem-${randomUUID()}` };
  }
}

/** 메모리 저장소 모드에서 처리 작업을 잇지 않았을 때: 늘 쓸 수 없다(503, 조용히 통과시키지 않는다) */
export const unavailableImageProcessing: ImageProcessing = {
  process: () => Promise.reject(new ImageProcessingUnavailable('잇지 않았다')),
};
export const unavailableSeatmapParser: SeatmapParser = {
  parse: () => Promise.reject(new SeatmapWorkerUnavailable('UNAVAILABLE')),
};
