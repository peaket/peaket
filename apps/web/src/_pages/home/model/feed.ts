// SCR-001 홈 피드를 화면 값으로 바꾼다(d5 §5.1, openapi HomeFeed·ProductionCard·RankingFile, ADR-0199, BUILD_ORDER HOT-300).
// 계약의 칸은 모두 선택이라, 화면에 꼭 필요한 칸(대표 회차·공연명)이 없는 카드는 빼고 그린다. 날짜·시각은 한국 시각으로 쓴다.
// 이 파일은 순수 함수만 둔다(node --test가 바로 불러 본다).
import type { HomeFeed, ProductionCard, RankingFile } from '@peaket/api-client/model';

export type CardStatus = 'upcoming' | 'on_sale' | 'sold_out' | 'ended';
export type Genre = NonNullable<ProductionCard['genre']>;

/** 카드 하나에 필요한 값(서버 → 클라이언트로 넘길 수 있게 평평하게) */
export interface HomeCard {
  id: string;
  eventId: string;
  title: string;
  href: string;
  genre?: Genre;
  posterUrl?: string;
  posterAlt: string;
  venue: string;
  periodText: string;
  /** 다음 오픈 일시('11/20(금) 20:00'), 오픈할 회차가 없으면 빈 글자 */
  openText: string;
  /** 오픈 알림을 신청할 회차(다음 오픈 회차) */
  nextOpenEventId?: string;
  status: CardStatus;
  /** 대표 회차의 판매 정보 배지 하나(정렬 방식·선예매 등) */
  badge?: { text: string; tone: 'primary' | 'plain' };
  minPrice?: number;
  /** 지금 판매 중 카드의 남은 판매 기간('12일 남음') */
  daysLeftText?: string;
}

export interface BannerSlide {
  id: string;
  href: string;
  imageUrl?: string;
  alt: string;
  title?: string;
  subtitle?: string;
}

export interface HomeTheme {
  id: string;
  name: string;
  cards: HomeCard[];
}

export interface HomePlace {
  id: string;
  name: string;
  initial: string;
  href: string;
}

export interface HomeData {
  banners: BannerSlide[];
  upcoming: HomeCard[];
  onSale: HomeCard[];
  themes: HomeTheme[];
  places: HomePlace[];
  rankingsPath: string;
}

export const RANKINGS_PATH = '/v1/home/rankings.json';

/** 원본에 닿지 못했을 때(빌드에 원본이 없을 때)의 빈 피드: 섹션이 모두 숨는다(SCR-001 '섹션 비어 있음') */
export const EMPTY_HOME: HomeData = { banners: [], upcoming: [], onSale: [], themes: [], places: [], rankingsPath: RANKINGS_PATH };

const KST = 9 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

/** 한국 시각의 날짜 부분 */
function kst(d: Date): { m: number; d: number; wd: string; hh: string; mm: string } {
  const k = new Date(d.getTime() + KST);
  return {
    m: k.getUTCMonth() + 1,
    d: k.getUTCDate(),
    wd: WEEKDAY[k.getUTCDay()]!,
    hh: String(k.getUTCHours()).padStart(2, '0'),
    mm: String(k.getUTCMinutes()).padStart(2, '0'),
  };
}

/** '11/20(금) 20:00' */
export function openText(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const k = kst(t);
  return `${k.m}/${k.d}(${k.wd}) ${k.hh}:${k.mm}`;
}

/** 공연 기간 '12/24' 또는 '12/24~12/26'(계약의 날짜는 이미 한국 날짜다) */
export function periodText(start?: string, end?: string): string {
  const md = (s: string) => {
    const [, m, d] = s.split('-');
    return m && d ? `${Number(m)}/${Number(d)}` : '';
  };
  if (!start) return end ? md(end) : '';
  if (!end || end === start) return md(start);
  return `${md(start)}~${md(end)}`;
}

/** 남은 판매 기간(판매 종료까지, 한국 날짜 차이): 판매 종료가 오늘이면 '오늘 마감', 아니면 'N일 남음'. 지났으면 없음 */
export function daysLeftText(saleEndsAt: string | undefined, now: Date): string | undefined {
  if (!saleEndsAt) return undefined;
  const end = new Date(saleEndsAt);
  if (Number.isNaN(end.getTime()) || end.getTime() <= now.getTime()) return undefined;
  const days = Math.round((Date.parse(`${kstDate(end)}T00:00:00Z`) - Date.parse(`${kstDate(now)}T00:00:00Z`)) / DAY);
  return days <= 0 ? '오늘 마감' : `${days}일 남음`;
}

const STATUS: Record<NonNullable<ProductionCard['saleStatus']>, CardStatus> = { UPCOMING: 'upcoming', ON_SALE: 'on_sale', SOLD_OUT: 'sold_out', ENDED: 'ended' };

/** 배지 문구(코드 → 화면 문구, 문구는 화면이 정한다): 정렬 방식은 사전 셔플·선착순만 보이고 기본(하이브리드)은 보이지 않는다 [가정] */
const BADGE: Partial<Record<NonNullable<ProductionCard['badges']>[number], { text: string; tone: 'primary' | 'plain' }>> = {
  PRESALE: { text: '선예매', tone: 'primary' },
  PREQUEUE_SHUFFLE: { text: '사전 셔플', tone: 'plain' },
  FIFO: { text: '선착순', tone: 'plain' },
  AUTO_SEAT: { text: '자동 배정', tone: 'plain' },
};

export function toCard(c: ProductionCard, now: Date): HomeCard | undefined {
  if (!c.eventId || !c.title) return undefined;
  const badge = (c.badges ?? []).map((b) => BADGE[b]).find(Boolean);
  return {
    id: c.productionId ?? c.eventId,
    eventId: c.eventId,
    title: c.title,
    href: `/events/${encodeURIComponent(c.eventId)}`,
    ...(c.genre ? { genre: c.genre } : {}),
    ...(c.posterUrl ? { posterUrl: c.posterUrl } : {}),
    posterAlt: c.posterAlt || `${c.title} 포스터`,
    venue: c.placeName ?? '',
    periodText: periodText(c.periodStart, c.periodEnd),
    openText: openText(c.nextOpenAt),
    ...(c.nextOpenEventId ? { nextOpenEventId: c.nextOpenEventId } : {}),
    status: STATUS[c.saleStatus ?? 'ON_SALE'],
    ...(badge ? { badge } : {}),
    ...(typeof c.minPrice === 'number' ? { minPrice: c.minPrice } : {}),
    ...(c.saleStatus === 'ON_SALE' ? { daysLeftText: daysLeftText(c.saleEndsAt, now) } : {}),
  };
}

const cards = (list: ProductionCard[] | undefined, now: Date): HomeCard[] => (list ?? []).flatMap((c) => toCard(c, now) ?? []);

/** 공연장 원형 이니셜: 계약 값이 없으면 이름의 첫 글자 */
const initialOf = (name: string, initial?: string) => initial || Array.from(name.trim())[0] || '?';

export function toHomeData(feed: HomeFeed, now: Date): HomeData {
  const banners = (feed.banners ?? []).flatMap((b): BannerSlide[] =>
    b.eventId && b.alt
      ? [
          {
            id: b.bannerId ?? b.eventId,
            href: `/events/${encodeURIComponent(b.eventId)}`,
            ...(b.imageUrl ? { imageUrl: b.imageUrl } : {}),
            alt: b.alt,
            ...(b.title ? { title: b.title } : {}),
            ...(b.subtitle ? { subtitle: b.subtitle } : {}),
          },
        ]
      : [],
  );
  const themes = (feed.themes ?? []).flatMap((t): HomeTheme[] => {
    const list = cards(t.productions, now);
    return t.name && list.length > 0 ? [{ id: t.themeId ?? t.name, name: t.name, cards: list }] : [];
  });
  const places = (feed.places ?? []).flatMap((p): HomePlace[] =>
    p.placeId && p.name ? [{ id: p.placeId, name: p.name, initial: initialOf(p.name, p.initial), href: `/search?placeId=${encodeURIComponent(p.placeId)}` }] : [],
  );
  // 랭킹 파일 경로는 같은 출처의 정해진 경로만 받는다(피드 값이 다른 곳을 가리켜도 그곳에서 받지 않는다)
  return { banners, upcoming: cards(feed.upcoming, now), onSale: cards(feed.onSale, now), themes, places, rankingsPath: RANKINGS_PATH };
}

/** 랭킹 한 칸 */
export interface RankCard extends HomeCard {
  rank: number;
}

export interface Rankings {
  /** 집계한 판매일(KST 'YYYY-MM-DD') */
  basisDate: string;
  overall: RankCard[];
  byGenre: Partial<Record<Genre, RankCard[]>>;
}

const rankCards = (list: (ProductionCard & { rank?: number })[] | undefined, now: Date): RankCard[] =>
  (list ?? [])
    .flatMap((c) => {
      const card = toCard(c, now);
      return card && typeof c.rank === 'number' ? [{ ...card, rank: c.rank }] : [];
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 10);

export function toRankings(f: RankingFile, now: Date): Rankings | undefined {
  if (!f.basisDate) return undefined;
  const byGenre: Rankings['byGenre'] = {};
  for (const g of f.genres ?? []) if (g.genre) byGenre[g.genre] = rankCards(g.items, now);
  return { basisDate: f.basisDate, overall: rankCards(f.overall, now), byGenre };
}

/** 한국 날짜 'YYYY-MM-DD' */
export function kstDate(now: Date): string {
  return new Date(now.getTime() + KST).toISOString().slice(0, 10);
}

/** 받아야 할 판매일보다 2일 [가정] 밀린 파일(게시 뒤 2일 넘게 묵은 파일)이면 섹션을 숨긴다(d5 §5.1, analytics 홈 랭킹 절, POL-043) */
export const RANKING_HIDE_AFTER_DAYS = 2;

/** 랭킹 파일 게시 시각(한국 시각 10:00 [가정]). 그 전에는 그제 판매분 파일이 정상이다 */
export const RANKING_PUBLISH_HOUR_KST = 10;

/**
 * 랭킹 기준 문구: 지금 받아야 할 판매일(10시 전에는 그제, 뒤에는 어제)의 파일이면 늘 쓰는 기준 문구, 그보다 앞이면 '10/12 판매 기준',
 * 2일 [가정] 넘게 밀렸으면 숨김(undefined). 기준 문구의 날짜는 늘 집계한 판매일이다(d5 §5.1 '랭킹 갱신 실패')
 */
export function rankingBasis(basisDate: string, now: Date): { stale: boolean; text: string } | undefined {
  const today = Date.parse(`${kstDate(now)}T00:00:00Z`);
  const basis = Date.parse(`${basisDate}T00:00:00Z`);
  if (Number.isNaN(basis)) return undefined;
  const age = Math.round((today - basis) / DAY);
  const expected = new Date(now.getTime() + KST).getUTCHours() < RANKING_PUBLISH_HOUR_KST ? 2 : 1;
  if (age <= expected) return { stale: false, text: '어제 판매 매수 기준, 매일 오전 10시 갱신' };
  if (age - expected >= RANKING_HIDE_AFTER_DAYS) return undefined;
  const [, m, d] = basisDate.split('-');
  return { stale: true, text: `${Number(m)}/${Number(d)} 판매 기준` };
}

/** 찜한 공연 카드의 둘째 줄 */
export function likeSubText(c: HomeCard): string {
  if (c.status === 'upcoming') return c.openText ? `${c.openText} 오픈${c.badge ? ` · ${c.badge.text}` : ''}` : c.venue;
  return [c.periodText, c.venue].filter(Boolean).join(' · ');
}

/** 공연 상태 배지 */
export function statusBadge(c: HomeCard): { text: string; cls: string } {
  switch (c.status) {
    case 'upcoming':
      return { text: '오픈 예정', cls: 'badge badge-primary' };
    case 'sold_out':
      return { text: '매진', cls: 'badge badge-danger' };
    case 'ended':
      return { text: '판매 종료', cls: 'badge' };
    default:
      return { text: '판매 중', cls: 'badge badge-success' };
  }
}
