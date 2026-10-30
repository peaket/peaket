// 홈 피드 목업(d5 §5.1 '시연 흉내 방법': 공연 카드로 섹션을 채우고 배너 3장·테마는 목업 값). 섹션 순서는 보드 그대로다.
// 데이터 연결 단계에서 홈 피드(서버, 엣지 캐시)·랭킹 파일(같은 출처 정적 JSON)로 바뀐다(docs/frontend.md §2.5).
import { listPerformances } from '@/entities/performance';
import { getProduction, productionHref, type PosterArt, type Production } from '@/entities/production';
import { getVenue, VENUES } from '@/entities/venue';
import type { Genre } from '@/shared/config/genres';

export interface BannerSlide {
  id: string;
  href: string;
  art: PosterArt;
  kicker: string;
  title: string;
  sub: string;
  /** 대체 텍스트(핵심 문구는 이미지 안 글자로 넣지 않고 HTML 글자로, d5 §5.1) */
  alt: string;
}

export const BANNERS: readonly BannerSlide[] = [
  {
    id: 'bn-lumen',
    href: '/events/evt-lumen-1025',
    art: 'lumen',
    kicker: 'CONCERT 2026',
    title: 'LUMEN',
    sub: 'SEOUL · 피켓 아레나 · 10.25–10.26',
    alt: 'LUMEN 콘서트 2026 서울, 10/25(일)~10/26(월) 피켓 아레나',
  },
  {
    id: 'bn-fest',
    href: '/events/evt-fest-1107',
    art: 'fest',
    kicker: 'OUTDOOR FESTIVAL',
    title: '가을 야외 페스티벌',
    sub: '피켓 아레나 · 11.7',
    alt: '가을 야외 페스티벌, 11/7(토) 피켓 아레나',
  },
  {
    id: 'bn-fanmeet',
    href: '/events/evt-fanmeet-1114',
    art: 'fanmeet',
    kicker: 'FAN MEETING',
    title: '팬미팅',
    sub: '10.28 20:00 OPEN · 피켓 아레나',
    alt: '팬미팅, 10/28(수) 20:00 오픈, 피켓 아레나',
  },
];

/** 카드 하나에 필요한 값(서버 → 클라이언트로 넘길 수 있게 평평하게) */
export interface HomeCard {
  id: string;
  title: string;
  href: string;
  genre: Genre;
  art: PosterArt;
  kicker?: string;
  posterTitle: string;
  posterShort: string;
  venue: string;
  periodText: string;
  openText: string;
  status: Production['status'];
  upcomingBadge?: Production['upcomingBadge'];
  minPrice: number;
  daysLeftText?: string;
  roundCount: number;
  sub?: string;
}

export function toCard(id: string): HomeCard {
  const p = getProduction(id);
  if (!p) throw new Error(`목업 공연 없음: ${id}`);
  return {
    id: p.id,
    title: p.title,
    href: productionHref(p),
    genre: p.genre,
    art: p.poster.art,
    kicker: p.poster.kicker,
    posterTitle: p.poster.title,
    posterShort: p.poster.short,
    venue: getVenue(p.venueId)?.name ?? '',
    periodText: p.periodText,
    openText: p.openText,
    status: p.status,
    upcomingBadge: p.upcomingBadge,
    minPrice: p.minPrice,
    daysLeftText: p.daysLeftText,
    roundCount: listPerformances(p.id).length,
    sub: p.poster.sub,
  };
}

/** ① 오픈 예정(오픈이 가까운 순) */
export const UPCOMING = ['prd-fanmeet', 'prd-starlight-gala', 'prd-jazz-night', 'prd-winter-orch', 'prd-play-window'].map(toCard);
/** ⑧ 장르별 랭킹(어제 판매 매수 순, 판매 승인된 공연만, 매진 포함) */
export const RANKING = ['prd-musical', 'prd-fest', 'prd-classic-garden', 'prd-jazz-city', 'prd-comedy', 'prd-lumen'].map(toCard);
/** ⑨ 지금 판매 중(판매 종료가 가까운 순) */
export const ON_SALE = ['prd-lumen', 'prd-fest', 'prd-classic-garden'].map(toCard);
/** ⑩ 테마 추천(운영자가 SCR-068 [홈 구성]에서 만든 테마) */
export const THEMES: readonly { id: string; name: string; cards: HomeCard[] }[] = [
  {
    id: 'th-weekend',
    name: '이번 주말, 같이 갈 공연',
    cards: ['prd-lumen', 'prd-fanmeet', 'prd-fest', 'prd-musical', 'prd-classic-garden', 'prd-jazz-night'].map(toCard),
  },
  {
    id: 'th-autumn-night',
    name: '가을밤에 듣는 음악',
    cards: ['prd-fest', 'prd-lumen', 'prd-jazz-city', 'prd-winter-orch', 'prd-jazz-night', 'prd-starlight-gala'].map(toCard),
  },
];
/** ⑪ 공연장 */
export const HOME_VENUES = VENUES.map((v) => ({ id: v.id, name: v.name, initial: v.initial, href: `/search?venue=${encodeURIComponent(v.id)}` }));

/** 찜한 공연 카드의 둘째 줄 */
export function likeSubText(c: HomeCard): string {
  if (c.status === 'upcoming') return `${c.openText} 오픈${c.upcomingBadge ? ` · ${c.upcomingBadge.text}` : ''}`;
  if (c.status === 'sold_out') return `회차 ${c.roundCount}개 · ${c.venue}`;
  return `${c.periodText} · ${c.venue}`;
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
