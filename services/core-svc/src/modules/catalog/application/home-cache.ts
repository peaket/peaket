// 유스케이스: 홈 피드에 영향을 주는 변경 뒤 CDN('home')과 웹 Next.js 캐시('home')를 함께 비운다(HOT-305).
// 어느 한쪽이 실패해도 다른 쪽 무효화는 실행하고 호출 유스케이스는 성공으로 남긴다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { CDN_INVALIDATION, type CdnInvalidation } from '../domain/media-ports.js';
import { NEXT_CACHE_INVALIDATOR, type HomeCacheInvalidationReason, type NextCacheInvalidator } from '../domain/next-cache-ports.js';

@Injectable()
export class HomeCacheInvalidator {
  constructor(
    @Optional() @Inject(CDN_INVALIDATION) private readonly cdn?: Pick<CdnInvalidation, 'invalidate'>,
    @Optional() @Inject(NEXT_CACHE_INVALIDATOR) private readonly nextCache?: NextCacheInvalidator,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
  ) {}

  async invalidate(reason: HomeCacheInvalidationReason): Promise<void> {
    try {
      await this.cdn?.invalidate(['home']);
    } catch (err) {
      safeWarn(this.logger, { event: 'home_cache_invalidate_failed', target: 'cdn', reason, err: errName(err) }, '홈 피드 CDN 태그 무효화에 실패했다');
    }
    try {
      await this.nextCache?.revalidate('home');
    } catch (err) {
      safeWarn(this.logger, { event: 'home_cache_invalidate_failed', target: 'next', reason, err: errName(err) }, '홈 피드 웹 캐시 무효화에 실패했다');
    }
  }
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

function safeWarn(logger: Pick<PlatformLogger, 'warn'> | undefined, o: Record<string, unknown>, msg: string): void {
  try {
    logger?.warn(o, msg);
  } catch {
    // 로그 실패는 처리를 바꾸지 않는다
  }
}
