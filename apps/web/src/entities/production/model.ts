// 공연(production) 목업. d5 §10.3의 E-1~E-4(LUMEN 콘서트 2026 서울 · 가을 야외 페스티벌 · 소극장 뮤지컬 · 팬미팅)에
// 홈 화면(SCR-001)을 채울 지어낸 공연을 더했다. 장르 여럿, 오픈 예정·판매 중·매진을 섞었다. 금액은 원 단위 정수, 시각은 KST 표기.
// 표시 글(…Text)은 캔버스 보드의 글 그대로다. ISO 시각은 참고용이다(데이터 연결 단계에서 서버 값으로 바뀐다).
import type { Genre } from '@/shared/config/genres';

/** 정렬 방식(POL-004): 하이브리드 · 선착순 · 사전 셔플 */
export type SortMode = 'HYBRID' | 'FIFO' | 'PREQUEUE_SHUFFLE';
/** 좌석 방식: 직접 선택 · 자동 배정 */
export type SeatMode = 'PICK' | 'AUTO';
/** 공연 판매 상태(홈·검색 카드 배지) */
export type ProductionStatus = 'upcoming' | 'on_sale' | 'sold_out' | 'ended';
/** 캔버스 키트 포스터 그림(.poster-lumen 등). 실제 서비스에서는 파트너가 올린 이미지 */
export type PosterArt = 'lumen' | 'fest' | 'musical' | 'fanmeet' | 'gala' | 'jazz';

export interface SeatTier {
  /** 'R석' */
  grade: string;
  price: number;
  /** 판매 중일 때 이 등급이 매진인지 */
  soldOut?: boolean;
}

export interface Production {
  id: string;
  title: string;
  genre: Genre;
  artistId?: string;
  venueId: string;
  sellerId: string;
  poster: {
    art: PosterArt;
    /** 포스터 위 작은 글(예: 'CONCERT 2026') */
    kicker?: string;
    /** 포스터 큰 글 */
    title: string;
    /** 포스터 아래 글(예: 'SEOUL · 피켓 아레나') */
    sub?: string;
    /** 작은 포스터(poster-sm)에 쓰는 짧은 글 */
    short: string;
  };
  /** '120분' */
  durationText: string;
  /** '만 7세 이상' */
  ageText: string;
  sortMode: SortMode;
  seatMode: SeatMode;
  status: ProductionStatus;
  /** 공연 기간 '10/25(일)~10/26(월)' */
  periodText: string;
  /** 오픈 일시 '10/14(수) 20:00' */
  openText: string;
  openAt: string;
  /** 로비 여는 시각 '19:50'(선착순 공연은 없음) */
  lobbyText?: string;
  /** 오픈 예정 카드 배지(사전 셔플 · 선예매 · 좌석 직접 선택 · 자동 배정) */
  upcomingBadge?: { text: string; tone?: 'primary' | 'neutral' };
  tiers: SeatTier[];
  /** '₩110,000부터'의 최저가 */
  minPrice: number;
  /** 1인 매수 한도 */
  perPerson: number;
  reentry: boolean;
  /** 판매 중 공연의 남은 판매 기간 '12일 남음'(마지막 회차의 판매 종료까지, POL-043) */
  daysLeftText?: string;
  rating?: { average: number; count: number };
  /** 회차 id(performance) 순서대로 */
  performanceIds: string[];
}

export const PRODUCTIONS: readonly Production[] = [
  {
    id: 'prd-lumen',
    title: 'LUMEN 콘서트 2026 서울',
    genre: 'concert',
    artistId: 'art-lumen',
    venueId: 'ven-peaket-arena',
    sellerId: 'sel-stella',
    poster: { art: 'lumen', kicker: 'CONCERT 2026', title: 'LUMEN', sub: 'SEOUL · 피켓 아레나', short: 'LUMEN' },
    durationText: '120분',
    ageText: '만 7세 이상',
    sortMode: 'HYBRID',
    seatMode: 'PICK',
    status: 'on_sale',
    periodText: '10/25(일)~10/26(월)',
    openText: '10/14(수) 20:00',
    openAt: '2026-10-14T20:00:00+09:00',
    lobbyText: '19:50',
    tiers: [
      { grade: 'R석', price: 154000 },
      { grade: 'S석', price: 132000, soldOut: true },
      { grade: 'A석', price: 110000 },
    ],
    minPrice: 110000,
    perPerson: 4,
    reentry: false,
    daysLeftText: '12일 남음',
    rating: { average: 4.6, count: 128 },
    performanceIds: ['evt-lumen-1025', 'evt-lumen-1026'],
  },
  {
    id: 'prd-fest',
    title: '가을 야외 페스티벌',
    genre: 'festival',
    artistId: 'art-haneul-band',
    venueId: 'ven-peaket-arena',
    sellerId: 'sel-stella',
    poster: { art: 'fest', kicker: 'OUTDOOR', title: '가을 야외 페스티벌', sub: '2026 AUTUMN', short: 'FEST' },
    durationText: '360분',
    ageText: '전체 관람가',
    sortMode: 'FIFO',
    seatMode: 'AUTO',
    status: 'on_sale',
    periodText: '11/7(토)',
    openText: '10/16(금) 20:00',
    openAt: '2026-10-16T20:00:00+09:00',
    tiers: [
      { grade: '스탠딩', price: 99000 },
      { grade: '잔디석', price: 88000 },
    ],
    minPrice: 88000,
    perPerson: 2,
    reentry: true,
    daysLeftText: '24일 남음',
    rating: { average: 4.4, count: 52 },
    performanceIds: ['evt-fest-1107'],
  },
  {
    id: 'prd-musical',
    title: '소극장 뮤지컬',
    genre: 'musical',
    venueId: 'ven-peaket-arena',
    sellerId: 'sel-stella',
    poster: { art: 'musical', kicker: 'MUSICAL', title: '소극장 뮤지컬', sub: '3회차', short: '뮤지컬' },
    durationText: '150분',
    ageText: '만 13세 이상',
    sortMode: 'HYBRID',
    seatMode: 'PICK',
    status: 'sold_out',
    periodText: '11/1(일)~11/3(화)',
    openText: '10/12(월) 20:00',
    openAt: '2026-10-12T20:00:00+09:00',
    lobbyText: '19:50',
    tiers: [{ grade: '전석', price: 66000, soldOut: true }],
    minPrice: 66000,
    perPerson: 4,
    reentry: false,
    rating: { average: 4.8, count: 211 },
    performanceIds: ['evt-musical-1101', 'evt-musical-1102', 'evt-musical-1103'],
  },
  {
    id: 'prd-fanmeet',
    title: '팬미팅',
    genre: 'fanmeeting',
    artistId: 'art-lumen',
    venueId: 'ven-peaket-arena',
    sellerId: 'sel-stella',
    poster: { art: 'fanmeet', kicker: 'FAN MEETING', title: '팬미팅', sub: '2026', short: 'FAN' },
    durationText: '100분',
    ageText: '전체 관람가',
    sortMode: 'PREQUEUE_SHUFFLE',
    seatMode: 'PICK',
    status: 'upcoming',
    periodText: '11/14(토)',
    openText: '10/28(수) 20:00',
    openAt: '2026-10-28T20:00:00+09:00',
    lobbyText: '19:50',
    upcomingBadge: { text: '사전 셔플', tone: 'primary' },
    tiers: [
      { grade: 'R석', price: 99000 },
      { grade: 'S석', price: 88000 },
    ],
    minPrice: 88000,
    perPerson: 2,
    reentry: false,
    performanceIds: ['evt-fanmeet-1114'],
  },
  {
    id: 'prd-starlight-gala',
    title: '별빛 갈라 콘서트',
    genre: 'classic',
    artistId: 'art-starlight-orch',
    venueId: 'ven-starlight-hall',
    sellerId: 'sel-starlight',
    poster: { art: 'gala', kicker: 'GALA', title: '별빛 갈라 콘서트', sub: 'STARLIGHT HALL', short: '갈라' },
    durationText: '110분',
    ageText: '만 7세 이상',
    sortMode: 'HYBRID',
    seatMode: 'PICK',
    status: 'upcoming',
    periodText: '11/21(토)~11/22(일)',
    openText: '11/2(월) 20:00',
    openAt: '2026-11-02T20:00:00+09:00',
    lobbyText: '19:50',
    upcomingBadge: { text: '선예매', tone: 'primary' },
    tiers: [
      { grade: 'R석', price: 120000 },
      { grade: 'S석', price: 90000 },
    ],
    minPrice: 90000,
    perPerson: 4,
    reentry: false,
    performanceIds: ['evt-gala-1121', 'evt-gala-1122'],
  },
  {
    id: 'prd-jazz-night',
    title: '한밤의 재즈 나잇',
    genre: 'concert',
    artistId: 'art-river-trio',
    venueId: 'ven-hangang-jazz',
    sellerId: 'sel-starlight',
    poster: { art: 'jazz', kicker: 'JAZZ', title: '한밤의 재즈 나잇', sub: 'HANGANG', short: 'JAZZ' },
    durationText: '90분',
    ageText: '만 15세 이상',
    sortMode: 'HYBRID',
    seatMode: 'PICK',
    status: 'upcoming',
    periodText: '11/27(금)',
    openText: '11/4(수) 19:00',
    openAt: '2026-11-04T19:00:00+09:00',
    lobbyText: '18:50',
    upcomingBadge: { text: '좌석 직접 선택', tone: 'neutral' },
    tiers: [{ grade: '전석', price: 55000 }],
    minPrice: 55000,
    perPerson: 2,
    reentry: false,
    performanceIds: ['evt-jazz-1127'],
  },
  {
    id: 'prd-winter-orch',
    title: '겨울 오케스트라',
    genre: 'classic',
    artistId: 'art-starlight-orch',
    venueId: 'ven-starlight-hall',
    sellerId: 'sel-starlight',
    poster: { art: 'gala', kicker: 'ORCHESTRA', title: '겨울 오케스트라', sub: 'WINTER 2026', short: '오케스트라' },
    durationText: '120분',
    ageText: '만 7세 이상',
    sortMode: 'FIFO',
    seatMode: 'AUTO',
    status: 'upcoming',
    periodText: '12/5(토)',
    openText: '11/6(금) 20:00',
    openAt: '2026-11-06T20:00:00+09:00',
    upcomingBadge: { text: '자동 배정', tone: 'neutral' },
    tiers: [
      { grade: 'R석', price: 110000 },
      { grade: 'S석', price: 80000 },
    ],
    minPrice: 80000,
    perPerson: 4,
    reentry: false,
    performanceIds: ['evt-orch-1205'],
  },
  {
    id: 'prd-play-window',
    title: '연극 〈창문〉',
    genre: 'theater',
    venueId: 'ven-seoul-small',
    sellerId: 'sel-starlight',
    poster: { art: 'jazz', kicker: 'PLAY', title: '창문', sub: '서울 소극장', short: '창문' },
    durationText: '100분',
    ageText: '만 13세 이상',
    sortMode: 'PREQUEUE_SHUFFLE',
    seatMode: 'PICK',
    status: 'upcoming',
    periodText: '12/1(화)~12/20(일)',
    openText: '11/9(월) 14:00',
    openAt: '2026-11-09T14:00:00+09:00',
    lobbyText: '13:50',
    upcomingBadge: { text: '사전 셔플', tone: 'primary' },
    tiers: [{ grade: '전석', price: 45000 }],
    minPrice: 45000,
    perPerson: 2,
    reentry: false,
    performanceIds: ['evt-window-1201'],
  },
  {
    id: 'prd-classic-garden',
    title: '가을 클래식 정원',
    genre: 'classic',
    artistId: 'art-starlight-orch',
    venueId: 'ven-starlight-hall',
    sellerId: 'sel-starlight',
    poster: { art: 'gala', kicker: 'CLASSIC', title: '가을 클래식 정원', sub: 'GARDEN SERIES', short: '클래식' },
    durationText: '100분',
    ageText: '만 7세 이상',
    sortMode: 'HYBRID',
    seatMode: 'PICK',
    status: 'on_sale',
    periodText: '11/1(일)~11/3(화)',
    openText: '10/10(토) 14:00',
    openAt: '2026-10-10T14:00:00+09:00',
    lobbyText: '13:50',
    tiers: [
      { grade: 'R석', price: 77000 },
      { grade: 'S석', price: 55000 },
    ],
    minPrice: 55000,
    perPerson: 4,
    reentry: false,
    daysLeftText: '27일 남음',
    rating: { average: 4.5, count: 37 },
    performanceIds: ['evt-garden-1101'],
  },
  {
    id: 'prd-jazz-city',
    title: '재즈 인 더 시티',
    genre: 'concert',
    artistId: 'art-river-trio',
    venueId: 'ven-hangang-jazz',
    sellerId: 'sel-starlight',
    poster: { art: 'jazz', kicker: 'JAZZ', title: '재즈 인 더 시티', sub: 'CITY NIGHT', short: 'CITY' },
    durationText: '90분',
    ageText: '만 15세 이상',
    sortMode: 'HYBRID',
    seatMode: 'PICK',
    status: 'sold_out',
    periodText: '10/31(토)',
    openText: '10/8(목) 20:00',
    openAt: '2026-10-08T20:00:00+09:00',
    lobbyText: '19:50',
    tiers: [{ grade: '전석', price: 60000, soldOut: true }],
    minPrice: 60000,
    perPerson: 2,
    reentry: false,
    rating: { average: 4.7, count: 64 },
    performanceIds: ['evt-city-1031'],
  },
  {
    id: 'prd-comedy',
    title: '웃음 한가득 코미디 쇼',
    genre: 'etc',
    venueId: 'ven-sea-theater',
    sellerId: 'sel-starlight',
    poster: { art: 'gala', kicker: 'COMEDY', title: '웃음 한가득', sub: 'COMEDY SHOW', short: '코미디' },
    durationText: '90분',
    ageText: '만 12세 이상',
    sortMode: 'HYBRID',
    seatMode: 'AUTO',
    status: 'on_sale',
    periodText: '11/13(금)~11/15(일)',
    openText: '10/9(금) 20:00',
    openAt: '2026-10-09T20:00:00+09:00',
    lobbyText: '19:50',
    tiers: [{ grade: '전석', price: 44000 }],
    minPrice: 44000,
    perPerson: 4,
    reentry: false,
    daysLeftText: '30일 남음',
    performanceIds: ['evt-comedy-1113'],
  },
];

export function getProduction(id: string): Production | undefined {
  return PRODUCTIONS.find((p) => p.id === id);
}

/** 정렬 방식 배지 글 */
export const SORT_MODE_LABEL: Record<SortMode, string> = { HYBRID: '하이브리드', FIFO: '선착순', PREQUEUE_SHUFFLE: '사전 셔플' };
/** 좌석 방식 배지 글 */
export const SEAT_MODE_LABEL: Record<SeatMode, string> = { PICK: '좌석 직접 선택', AUTO: '자동 배정' };

/** 원화 표기 '₩110,000'(d2 §4) */
export function formatWon(value: number): string {
  return `₩${new Intl.NumberFormat('ko-KR').format(value)}`;
}

/** 공연 첫 회차의 상세 주소(공연 상세는 회차 주소, d5 §5.2) */
export function productionHref(p: Production): string {
  return `/events/${p.performanceIds[0] ?? p.id}`;
}
