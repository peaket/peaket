// SCR-003 검색 결과의 주소 ↔ 검색 조건 ↔ 계약 매개변수와 응답 → 화면 값(d5 §5.3, docs/features/search.md §5·§6, openapi listSearchResults,
// BUILD_ORDER HOT-312). 화면은 캐시되는 정적 셸이라 서버가 주소를 읽지 않고, 브라우저가 이 함수들로 주소를 읽어 검색 API를 부른다(search.md §7.3).
// 필터는 계약대로 하나씩 고른다. 주소의 장르는 영문 키(`genre=concert`, 홈·셸 링크가 쓴다)이고 계약은 정본 이름(한글)이다.
// 이 파일은 순수 함수만 둔다(node --test가 바로 불러 본다).
import type { ListSearchResultsParams, ProductionCard, SearchResultPage } from '@peaket/api-client/model';
import { GENRES, GENRE_LABEL, type Genre } from '../../../shared/config/genres.ts';
import { dateTimeText, parseTime } from '../../../shared/lib/kst.ts';

export type SortKey = 'relevance' | 'opening' | 'popular';
export type StatusFilter = 'upcoming' | 'on_sale' | 'sold_out' | 'ended';
export type CardStatus = StatusFilter;

export const SORT_OPTIONS: readonly { value: SortKey; label: string }[] = [
  { value: 'relevance', label: '정확도' },
  { value: 'opening', label: '오픈 임박' },
  { value: 'popular', label: '인기' },
];

export const STATUS_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'upcoming', label: '오픈 예정' },
  { value: 'on_sale', label: '판매 중' },
  { value: 'sold_out', label: '매진' },
  { value: 'ended', label: '끝난 공연' },
];

export interface SearchFilters {
  genre?: Genre;
  status?: StatusFilter;
  placeId?: string;
  artistId?: string;
  /** 공연 기간이 겹치는 범위(KST 날짜 'YYYY-MM-DD') */
  dateFrom?: string;
  dateTo?: string;
  includePast: boolean;
}

export interface SearchQuery {
  q: string;
  filters: SearchFilters;
  /** 고른 정렬(없으면 검색어가 있을 때 정확도, 없을 때 오픈 임박) */
  sort?: SortKey;
  page: number;
  /** 한/영 변환을 하지 않는다('{입력}(으)로 찾기') */
  noConvert: boolean;
}

export const NO_FILTERS: SearchFilters = { includePast: false };
export const PAGE_SIZE = 20;
/** page × 20 상한 [가정](docs/features/search.md §5.4) */
export const MAX_PAGE = 50;
const Q_MAX = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;

const SORT_API: Record<SortKey, NonNullable<ListSearchResultsParams['sort']>> = { relevance: 'RELEVANCE', opening: 'OPEN_SOON', popular: 'POPULAR' };
const STATUS_API: Record<StatusFilter, NonNullable<ListSearchResultsParams['status']>> = { upcoming: 'UPCOMING', on_sale: 'ON_SALE', sold_out: 'SOLD_OUT', ended: 'ENDED' };
const CARD_STATUS: Record<NonNullable<ProductionCard['saleStatus']>, CardStatus> = { UPCOMING: 'upcoming', ON_SALE: 'on_sale', SOLD_OUT: 'sold_out', ENDED: 'ended' };

/** 정해진 쪽 수 안의 정수 쪽 번호(틀리면 1) */
function pageOf(v: string | null): number {
  const n = Number(v ?? '1');
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_PAGE) : 1;
}

/** 주소 → 검색 조건. 셸·홈이 쓰던 옛 이름(`venue`)과 대문자 상태(`UPCOMING`)도 받는다. 모르는 값은 버린다 */
export function readQuery(sp: URLSearchParams): SearchQuery {
  const genreKey = sp.get('genre');
  const genre = GENRES.find((g) => g.key === genreKey)?.key;
  const statusRaw = (sp.get('status') ?? '').toLowerCase();
  const status = STATUS_OPTIONS.find((s) => s.value === statusRaw)?.value;
  const placeId = sp.get('placeId') ?? sp.get('venue') ?? undefined;
  const artistId = sp.get('artistId') ?? undefined;
  const dateFrom = sp.get('dateFrom') ?? undefined;
  const dateTo = sp.get('dateTo') ?? undefined;
  const sortRaw = sp.get('sort');
  const sort = SORT_OPTIONS.find((o) => o.value === sortRaw)?.value;
  return {
    // NFKC·공백 정리만 한다(소문자 등 캐시 키 정규화는 서버·CDN 몫, HOT-280). 화면에 보이는 검색어를 바꾸지 않는다
    q: (sp.get('q') ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, Q_MAX),
    filters: {
      ...(genre ? { genre } : {}),
      ...(status ? { status } : {}),
      ...(placeId && ID.test(placeId) ? { placeId } : {}),
      ...(artistId && ID.test(artistId) ? { artistId } : {}),
      ...(dateFrom && DATE.test(dateFrom) ? { dateFrom } : {}),
      ...(dateTo && DATE.test(dateTo) ? { dateTo } : {}),
      includePast: sp.get('includePast') === 'true',
    },
    ...(sort ? { sort } : {}),
    page: pageOf(sp.get('page')),
    noConvert: sp.get('noConvert') === 'true',
  };
}

/** 지금 쓰는 정렬(고르지 않았으면 검색어가 있을 때 정확도, 없을 때 오픈 임박, search.md §5.3) */
export function effectiveSort(query: Pick<SearchQuery, 'q' | 'sort'>): SortKey {
  return query.sort ?? (query.q ? 'relevance' : 'opening');
}

export function hasFilters(f: SearchFilters): boolean {
  return Boolean(f.genre || f.status || f.placeId || f.artistId || f.dateFrom || f.dateTo || f.includePast);
}

/** 검색 조건 → 계약 매개변수(값이 있는 것만, 캐시 키가 갈리지 않게 limit는 20) */
export function toApiParams(query: SearchQuery): ListSearchResultsParams {
  const f = query.filters;
  return {
    ...(query.q ? { q: query.q } : {}),
    ...(f.genre ? { genre: GENRE_LABEL[f.genre] as NonNullable<ListSearchResultsParams['genre']> } : {}),
    ...(f.status ? { status: STATUS_API[f.status] } : {}),
    ...(f.placeId ? { placeId: f.placeId } : {}),
    ...(f.artistId ? { artistId: f.artistId } : {}),
    ...(f.dateFrom ? { dateFrom: f.dateFrom } : {}),
    ...(f.dateTo ? { dateTo: f.dateTo } : {}),
    ...(f.includePast ? { includePast: true } : {}),
    ...(query.noConvert ? { noConvert: true } : {}),
    // 기본 정렬과 같으면 싣지 않는다(같은 검색이 CDN 캐시에서 두 칸으로 갈리지 않게)
    ...(query.sort && query.sort !== effectiveSort({ q: query.q }) ? { sort: SORT_API[query.sort] } : {}),
    page: query.page,
    limit: 20,
  };
}

/** 같은 검색에서 값 하나만 바꾼 주소. 필터·검색어·정렬을 바꾸면 1쪽으로 돌아가고 한/영 변환 끄기는 풀린다 */
export function searchUrl(query: SearchQuery, patch: Partial<{ q: string; filters: SearchFilters; sort: SortKey; page: number; noConvert: boolean }> = {}): string {
  const q = patch.q ?? query.q;
  const f = patch.filters ?? query.filters;
  const sort = patch.sort ?? query.sort;
  const resetPage = patch.q !== undefined || patch.filters !== undefined || patch.sort !== undefined;
  const page = patch.page ?? (resetPage ? 1 : query.page);
  const noConvert = patch.noConvert ?? (resetPage ? false : query.noConvert);
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (f.genre) p.set('genre', f.genre);
  if (f.status) p.set('status', f.status);
  if (f.placeId) p.set('placeId', f.placeId);
  if (f.artistId) p.set('artistId', f.artistId);
  if (f.dateFrom) p.set('dateFrom', f.dateFrom);
  if (f.dateTo) p.set('dateTo', f.dateTo);
  if (f.includePast) p.set('includePast', 'true');
  if (sort && sort !== effectiveSort({ q })) p.set('sort', sort);
  if (noConvert) p.set('noConvert', 'true');
  if (page > 1) p.set('page', String(page));
  const s = p.toString();
  return s ? `/search?${s}` : '/search';
}

/** 결과 카드(CMP-072 ProductionCard result). 공연 하나가 한 줄, 누르면 대표 회차 상세 */
export interface ResultCard {
  id: string;
  href: string;
  title: string;
  period: string;
  venue: string;
  /** 작은 카드(오픈 예정 인기 공연)의 보조 글 '11/20(금) 20:00 오픈' */
  openMeta: string;
  status: CardStatus;
  posterUrl?: string;
  posterAlt: string;
}

/** 공연 기간 '12/24~12/26'(계약의 날짜는 이미 한국 날짜다) */
function periodText(start?: string, end?: string): string {
  const md = (s: string) => {
    const [, m, d] = s.split('-');
    return m && d ? `${Number(m)}/${Number(d)}` : '';
  };
  if (!start) return end ? md(end) : '';
  if (!end || end === start) return md(start);
  return `${md(start)}~${md(end)}`;
}

/** 계약 카드 → 결과 카드. 대표 회차·공연명이 없으면 그리지 않는다 */
export function toResultCard(c: ProductionCard): ResultCard | undefined {
  if (!c.eventId || !c.title || !c.productionId) return undefined;
  const open = parseTime(c.nextOpenAt);
  return {
    id: c.productionId,
    href: `/events/${encodeURIComponent(c.eventId)}`,
    title: c.title,
    period: periodText(c.periodStart, c.periodEnd),
    venue: c.placeName ?? '',
    openMeta: open !== undefined ? `${dateTimeText(open)} 오픈` : '',
    status: CARD_STATUS[c.saleStatus ?? 'ON_SALE'] ?? 'on_sale',
    ...(c.posterUrl ? { posterUrl: c.posterUrl } : {}),
    posterAlt: c.posterAlt || `${c.title} 포스터`,
  };
}

const cards = (list: ProductionCard[] | undefined) => (list ?? []).flatMap((c) => toResultCard(c) ?? []);

export interface ResultView {
  total: number;
  totalCapped: boolean;
  page: number;
  pages: number;
  cards: ResultCard[];
  /** 한/영 변환으로 찾았을 때 { 바꾼 값, 원래 입력 } */
  converted?: { to: string; from: string };
  /** 비슷한 이름 제안('혹시 …을 찾으셨나요?') */
  didYouMean?: string;
  /** 필터를 풀면 나오는 수 */
  relaxedTotal?: number;
  /** 관련 공연(아티스트·공연장으로 맞았을 때, 0건이면 오픈 예정 인기 공연) */
  related?: { title: string; kind: 'ARTIST' | 'PLACE' | 'UPCOMING_POPULAR'; cards: ResultCard[] };
  placeName?: string;
  artistName?: string;
}

/** 검색 응답 → 화면 값 */
export function toResultView(r: SearchResultPage): ResultView {
  const list = cards(r.items);
  const related = r.related?.items?.length ? cards(r.related.items) : [];
  const basis = r.related?.basis;
  const relatedTitle =
    basis?.kind === 'ARTIST' && basis.name ? `${basis.name}의 다른 공연` : basis?.kind === 'PLACE' && basis.name ? `${basis.name}의 오픈 예정 공연` : '오픈 예정 인기 공연';
  return {
    total: r.total ?? list.length,
    totalCapped: r.totalCapped ?? false,
    page: r.page ?? 1,
    pages: r.totalPages ?? 0,
    cards: list,
    ...(r.query?.converted?.from && r.query.converted.to ? { converted: { from: r.query.converted.from, to: r.query.converted.to } } : {}),
    ...(r.didYouMean ? { didYouMean: r.didYouMean } : {}),
    ...(typeof r.relaxedTotal === 'number' && r.relaxedTotal > 0 ? { relaxedTotal: r.relaxedTotal } : {}),
    ...(related.length > 0 && basis?.kind ? { related: { title: relatedTitle, kind: basis.kind, cards: related } } : {}),
    ...(r.filterNames?.placeName ? { placeName: r.filterNames.placeName } : {}),
    ...(r.filterNames?.artistName ? { artistName: r.filterNames.artistName } : {}),
  };
}

/** 1 2 3 … n (보드: 1쪽이면 1 2 3 … 7) */
export function pageNumbers(page: number, pages: number): (number | null)[] {
  if (pages <= 5) return Array.from({ length: pages }, (_, i) => i + 1);
  const set = new Set([1, pages, page - 1, page, page + 1, ...(page <= 2 ? [2, 3] : []), ...(page >= pages - 1 ? [pages - 2, pages - 1] : [])]);
  const list = [...set].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  list.forEach((n, i) => {
    if (i > 0 && n - list[i - 1]! > 1) out.push(null);
    out.push(n);
  });
  return out;
}

/** 받침 있는 말 뒤 '을'·'으로', 없는 말 뒤 '를'·'로'(ㄹ 받침은 '로'). 한글이 아닌 끝 글자는 받침 없음으로 본다 */
export function josa(word: string, kind: '을' | '으로'): string {
  const last = word.charCodeAt(word.length - 1);
  const isHangul = last >= 0xac00 && last <= 0xd7a3;
  const jong = isHangul ? (last - 0xac00) % 28 : 0;
  if (kind === '을') return jong ? '을' : '를';
  return jong && jong !== 8 ? '으로' : '로';
}

/** 장르 필터 표시 이름 */
export function genreLabel(g: Genre): string {
  return GENRE_LABEL[g];
}
