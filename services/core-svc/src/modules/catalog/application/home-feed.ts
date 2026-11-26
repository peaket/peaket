// 유스케이스: SCR-001 홈 피드를 조립한다(GET /v1/home, docs/features/search.md §2.4, BUILD_ORDER HOT-305).
// search_document가 실패하면 503(Retry-After 1s)이고, home_banner·home_theme 읽기 실패는 빈 배열로 축소한다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, PLATFORM_LOGGER, ProblemError, type Clock, type PlatformLogger } from '@peaket/platform';
import { assembleHomeFeed, type HomeBannerRow, type HomeFeedPayload, type HomeThemeRow } from '../domain/home-feed.js';
import { HOME_FEED_SOURCE, type HomeFeedSource } from '../domain/home-ports.js';

@Injectable()
export class HomeFeed {
  constructor(
    @Inject(HOME_FEED_SOURCE) private readonly source: HomeFeedSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'warn'>,
  ) {}

  async get(): Promise<HomeFeedPayload> {
    const now = new Date(this.clock.now());
    const [docsResult, bannersResult, themesResult] = await Promise.allSettled([
      this.source.documents(now),
      this.source.banners(now),
      this.source.themes(now),
    ]);

    if (docsResult.status === 'rejected') {
      safeWarn(this.logger, { event: 'home_feed_documents_failed', err: errName(docsResult.reason) }, '홈 피드 검색 문서를 읽지 못했다');
      throw new ProblemError({
        type: 'dependency-unavailable',
        status: 503,
        title: '의존 서비스를 잠시 쓸 수 없습니다',
        retryAfterSeconds: 1,
        cause: docsResult.reason,
      });
    }

    let banners: HomeBannerRow[] = [];
    if (bannersResult.status === 'fulfilled') banners = bannersResult.value.map(normalizeBanner);
    else safeWarn(this.logger, { event: 'home_feed_layout_degraded', source: 'banners', err: errName(bannersResult.reason) }, '홈 배너를 읽지 못해 빈 목록으로 내린다');

    let themes: HomeThemeRow[] = [];
    if (themesResult.status === 'fulfilled') themes = themesResult.value.map(normalizeTheme);
    else safeWarn(this.logger, { event: 'home_feed_layout_degraded', source: 'themes', err: errName(themesResult.reason) }, '홈 테마를 읽지 못해 빈 목록으로 내린다');

    return assembleHomeFeed({ documents: docsResult.value, banners, themes, now });
  }
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** 메모리 씨앗·시험 대역은 날짜를 ISO 글자로 줄 수 있다. 원천 경계에서 Date로 맞춘다 */
function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function normalizeBanner(b: HomeBannerRow): HomeBannerRow {
  return { ...b, displayFrom: toDate(b.displayFrom), displayUntil: toDate(b.displayUntil) };
}

function normalizeTheme(t: HomeThemeRow): HomeThemeRow {
  return { ...t, displayFrom: toDate(t.displayFrom), displayUntil: toDate(t.displayUntil) };
}

function safeWarn(logger: Pick<PlatformLogger, 'warn'> | undefined, o: Record<string, unknown>, msg: string): void {
  try {
    logger?.warn(o, msg);
  } catch {
    // 로그 실패는 응답을 바꾸지 않는다
  }
}
