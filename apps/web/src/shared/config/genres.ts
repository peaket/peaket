// 장르 정본 목록(docs/planning/03 §4 '장르', 7개)과 홈 장르 바로가기 10칸(d5 §5.1 ⑦).
export type Genre = 'concert' | 'musical' | 'theater' | 'classic' | 'festival' | 'fanmeeting' | 'etc';

export const GENRES: readonly { key: Genre; label: string; icon: string }[] = [
  { key: 'concert', label: '콘서트', icon: 'concert' },
  { key: 'musical', label: '뮤지컬', icon: 'musical' },
  { key: 'theater', label: '연극', icon: 'theater' },
  { key: 'classic', label: '클래식', icon: 'classic' },
  { key: 'festival', label: '페스티벌', icon: 'festival' },
  { key: 'fanmeeting', label: '팬미팅', icon: 'fanmeeting' },
  { key: 'etc', label: '기타', icon: 'etc' },
];

export const GENRE_LABEL: Record<Genre, string> = Object.fromEntries(GENRES.map((g) => [g.key, g.label])) as Record<Genre, string>;

/** 검색 화면(SCR-003)의 필터 주소. 매개변수 이름은 docs/features/search.md §5.4 표(placeId, status=UPCOMING) */
export const searchHref = {
  genre: (g: Genre) => `/search?genre=${g}`,
  venue: (venueId?: string) => (venueId ? `/search?placeId=${encodeURIComponent(venueId)}` : '/search?filter=venue'),
  upcoming: () => '/search?status=UPCOMING',
  all: () => '/search',
};

/** 홈 장르 바로가기 10칸: 장르 7개 + 굿즈 스토어 · 공연장 · 전체 장르 */
export const HOME_GENRE_TILES: readonly { label: string; icon: string; href: string }[] = [
  ...GENRES.map((g) => ({ label: g.label, icon: g.icon, href: searchHref.genre(g.key) })),
  { label: '굿즈 스토어', icon: 'goods', href: '/shop' },
  { label: '공연장', icon: 'venue', href: searchHref.venue() },
  { label: '전체 장르', icon: 'all', href: searchHref.all() },
];
