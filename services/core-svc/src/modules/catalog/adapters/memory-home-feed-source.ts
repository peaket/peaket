// 어댑터: 메모리 홈 피드 원천(시험·로컬, BUILD_ORDER HOT-305).
import type { HomeBannerRow, HomeThemeRow } from '../domain/home-feed.js';
import type { HomeBannerSeed, HomeFeedSource, HomeThemeSeed } from '../domain/home-ports.js';
import type { SearchDocument } from '../domain/search.js';
import type { MemorySearchIndex } from './memory-search-index.js';

export class MemoryHomeFeedSource implements HomeFeedSource {
  private readonly bannerRows: HomeBannerRow[];
  private readonly themeRows: HomeThemeRow[];

  constructor(
    private readonly index: MemorySearchIndex,
    seed: { banners?: readonly HomeBannerSeed[]; themes?: readonly HomeThemeSeed[] } = {},
  ) {
    this.bannerRows = (seed.banners ?? []).map((b, i) => ({
      bannerId: b.bannerId,
      productionId: b.productionId,
      imageUrl: b.imageUrl,
      alt: b.alt,
      ...(b.title !== undefined ? { title: b.title } : {}),
      ...(b.subtitle !== undefined ? { subtitle: b.subtitle } : {}),
      sortOrder: b.sortOrder ?? i,
      displayFrom: toDate(b.displayFrom),
      displayUntil: toDate(b.displayUntil),
    }));
    this.themeRows = (seed.themes ?? []).map((t, i) => ({
      themeId: t.themeId,
      name: t.name,
      productionIds: [...t.productionIds],
      sortOrder: t.sortOrder ?? i,
      displayFrom: toDate(t.displayFrom),
      displayUntil: toDate(t.displayUntil),
    }));
  }

  async documents(_now: Date): Promise<SearchDocument[]> {
    return this.index.documents();
  }

  async banners(_now: Date): Promise<HomeBannerRow[]> {
    return this.bannerRows;
  }

  async themes(_now: Date): Promise<HomeThemeRow[]> {
    return this.themeRows;
  }
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}
