// 도메인 층: SCR-001 홈 피드 읽기 포트(docs/features/search.md §2.4, BUILD_ORDER HOT-305). 어댑터가 구현한다.
import type { HomeBannerRow, HomeThemeRow } from './home-feed.js';
import type { SearchDocument } from './search.js';

export const HOME_FEED_SOURCE = Symbol('HOME_FEED_SOURCE');

export interface HomeLayoutSource {
  banners(now: Date): Promise<HomeBannerRow[]>;
  themes(now: Date): Promise<HomeThemeRow[]>;
}

export interface HomeFeedSource extends HomeLayoutSource {
  documents(now: Date): Promise<SearchDocument[]>;
}

export interface HomeBannerSeed {
  bannerId: string;
  productionId: string;
  eventId?: string;
  title?: string | null;
  subtitle?: string | null;
  imageUrl: string;
  alt: string;
  displayFrom: Date | string;
  displayUntil: Date | string;
  sortOrder?: number;
}

export interface HomeThemeSeed {
  themeId: string;
  name: string;
  productionIds: readonly string[];
  displayFrom: Date | string;
  displayUntil: Date | string;
  sortOrder?: number;
}

export interface HomeMemoryWiring {
  source?: HomeFeedSource;
  banners?: readonly HomeBannerSeed[];
  themes?: readonly HomeThemeSeed[];
}
