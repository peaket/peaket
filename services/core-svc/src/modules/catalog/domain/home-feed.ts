// 도메인 층: SCR-001 홈 피드 조립 규칙과 상한(docs/features/search.md §2.4, BUILD_ORDER HOT-305).
import { card, type SearchCard, type SearchDocument } from './search.js';

export const HOME_BANNER_MAX = 10;
export const HOME_UPCOMING_MAX = 10;
export const HOME_ON_SALE_MAX = 9;
export const HOME_THEME_MAX = 5;
export const HOME_THEME_ITEMS_MAX = 20;
export const HOME_PLACES_MAX = 10;
export const HOME_RANKINGS_PATH = '/v1/home/rankings.json';

export interface HomeBannerRow {
  bannerId: string;
  productionId: string;
  imageUrl: string;
  alt: string;
  title?: string | null;
  subtitle?: string | null;
  sortOrder: number;
  displayFrom: Date;
  displayUntil: Date;
}

export interface HomeThemeRow {
  themeId: string;
  name: string;
  productionIds: readonly string[];
  sortOrder: number;
  displayFrom: Date;
  displayUntil: Date;
}

export interface HomeBanner {
  bannerId: string;
  productionId: string;
  eventId?: string;
  title?: string;
  subtitle?: string;
  imageUrl: string;
  alt: string;
  displayUntil: string;
}

export interface HomeTheme {
  themeId: string;
  name: string;
  productions: SearchCard[];
}

export interface HomePlace {
  placeId: string;
  name: string;
  initial: string;
}

export interface HomeFeedPayload {
  banners: HomeBanner[];
  upcoming: SearchCard[];
  onSale: SearchCard[];
  themes: HomeTheme[];
  places: HomePlace[];
  rankingsPath: string;
  generatedAt: string;
}

const koCollator = new Intl.Collator('ko');
const compareId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const inWindow = (from: Date, until: Date, nowMs: number): boolean => from.getTime() <= nowMs && nowMs < until.getTime();
const timeOrMax = (iso: string | null | undefined): number => {
  if (!iso) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
};

/**
 * 공개 검색 문서·배너·테마 행에서 SCR-001 홈 피드 본문을 만든다.
 * - 배너·테마: displayFrom <= now < displayUntil이고 공개 문서에 있는 공연만 싣는다.
 * - 오픈 예정: saleStatus === 'UPCOMING' && nextOpenAt > now, nextOpenAt·productionId 오름차순 10개.
 * - 판매 중: saleStatus === 'ON_SALE'(saleEndsAt은 정렬·표시에만 쓴다), saleEndsAt·productionId 오름차순 9개.
 * - 공연장: 진행 중(UPCOMING·ON_SALE) 공연 수 내림차순 → 한국어 이름 오름차순 → placeId 순 10개.
 */
export function assembleHomeFeed(input: {
  documents: readonly SearchDocument[];
  banners: readonly HomeBannerRow[];
  themes: readonly HomeThemeRow[];
  now: Date;
}): HomeFeedPayload {
  const nowMs = input.now.getTime();
  const docByProduction = new Map<string, SearchDocument>();
  for (const doc of input.documents) {
    if (!docByProduction.has(doc.productionId)) docByProduction.set(doc.productionId, doc);
  }

  const banners: HomeBanner[] = input.banners
    .filter((b) => inWindow(b.displayFrom, b.displayUntil, nowMs) && docByProduction.has(b.productionId))
    .sort((a, b) => a.sortOrder - b.sortOrder || compareId(a.bannerId, b.bannerId))
    .slice(0, HOME_BANNER_MAX)
    .map((b) => {
      const doc = docByProduction.get(b.productionId)!;
      return {
        bannerId: b.bannerId,
        productionId: b.productionId,
        ...(doc.eventId !== undefined ? { eventId: doc.eventId } : {}),
        ...(b.title !== undefined && b.title !== null ? { title: b.title } : {}),
        ...(b.subtitle !== undefined && b.subtitle !== null ? { subtitle: b.subtitle } : {}),
        imageUrl: b.imageUrl,
        alt: b.alt,
        displayUntil: b.displayUntil.toISOString(),
      };
    });

  const uniqueDocs = [...docByProduction.values()];

  const upcoming = uniqueDocs
    .filter((d) => d.saleStatus === 'UPCOMING' && typeof d.nextOpenAt === 'string' && Date.parse(d.nextOpenAt) > nowMs)
    .sort((a, b) => timeOrMax(a.nextOpenAt) - timeOrMax(b.nextOpenAt) || compareId(a.productionId, b.productionId))
    .slice(0, HOME_UPCOMING_MAX)
    .map(card);

  const onSale = uniqueDocs
    .filter((d) => d.saleStatus === 'ON_SALE')
    .sort((a, b) => timeOrMax(a.saleEndsAt) - timeOrMax(b.saleEndsAt) || compareId(a.productionId, b.productionId))
    .slice(0, HOME_ON_SALE_MAX)
    .map(card);

  const themes: HomeTheme[] = [];
  const activeThemes = input.themes
    .filter((t) => inWindow(t.displayFrom, t.displayUntil, nowMs))
    .sort((a, b) => a.sortOrder - b.sortOrder || compareId(a.themeId, b.themeId));
  for (const t of activeThemes) {
    const seen = new Set<string>();
    const productions: SearchCard[] = [];
    for (const pid of t.productionIds) {
      if (seen.has(pid)) continue;
      const doc = docByProduction.get(pid);
      if (!doc) continue;
      seen.add(pid);
      productions.push(card(doc));
      if (productions.length >= HOME_THEME_ITEMS_MAX) break;
    }
    if (productions.length === 0) continue;
    themes.push({ themeId: t.themeId, name: t.name, productions });
    if (themes.length >= HOME_THEME_MAX) break;
  }

  const placeCounts = new Map<string, { placeId: string; name: string; count: number }>();
  for (const doc of uniqueDocs) {
    if (doc.saleStatus !== 'UPCOMING' && doc.saleStatus !== 'ON_SALE') continue;
    if (!doc.placeId || !doc.placeName) continue;
    const prev = placeCounts.get(doc.placeId);
    if (prev) prev.count += 1;
    else placeCounts.set(doc.placeId, { placeId: doc.placeId, name: doc.placeName, count: 1 });
  }
  const places: HomePlace[] = [...placeCounts.values()]
    .sort((a, b) => b.count - a.count || koCollator.compare(a.name, b.name) || compareId(a.placeId, b.placeId))
    .slice(0, HOME_PLACES_MAX)
    .map((p) => ({ placeId: p.placeId, name: p.name, initial: Array.from(p.name.trim())[0] ?? '' }));

  return {
    banners,
    upcoming,
    onSale,
    themes,
    places,
    rankingsPath: HOME_RANKINGS_PATH,
    generatedAt: input.now.toISOString(),
  };
}
