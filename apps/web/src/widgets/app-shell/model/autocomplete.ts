// 머리 검색창 자동완성의 브라우저 규칙(docs/features/search.md §4.5, d5 §5.3 '자동완성 불러오는 중', openapi getSearchSuggestions, BUILD_ORDER HOT-313).
// - 요청 최소 길이: 한글 음절이 하나라도 있으면 1자부터, 로마자·숫자·낱자만이면 2자부터 [가정](계약 q 설명).
// - 받은 후보 안에서 거르기(refineLocally)·입력 종류·정규화·초성은 사본을 두지 않고 @peaket/search-normalize의 함수를 다시 내보낸다
//   (서버 골든 세트 SR-T12가 같은 함수를 거친다, ADR-0271 결정 11). 첫 JS에 es-hangul을 싣지 않게 `/refine` 경로로 가져온다.
// - 계약 후보 → 셸 후보: 공연은 대표 회차 상세, 아티스트·공연장은 그 필터의 검색 결과. 굵게는 서버가 준 위치만(matches, UTF-16), 없으면 이름 전체.
// 이 파일은 순수 함수만 둔다(node --test가 바로 불러 본다).
import type { SuggestResultItemsItem } from '@peaket/api-client/model';
import { normalizeInput } from '@peaket/search-normalize/refine';
import { dateTimeText, parseTime } from '../../../shared/lib/kst.ts';

export { chosungOf, inputKind, normalizeInput, refineLocally, SUGGEST_LIMIT, type InputKind, type LastAnswer } from '@peaket/search-normalize/refine';

const SYLLABLE = /[가-힣]/;

/** 자동완성 요청에 싣는 값: 정규화한 입력(같은 검색이 같은 요청 주소, SR-T11). 50자를 넘으면 부르지 않는다(undefined) */
export function suggestRequestQuery(q: string): string | undefined {
  const n = normalizeInput(q);
  return n && n.length <= 50 ? n : undefined;
}

/** 요청해도 되는 길이인가(한글 음절이 있으면 1자, 아니면 2자부터 [가정]) */
export function minLengthOk(q: string): boolean {
  const n = normalizeInput(q);
  if (!n) return false;
  return SYLLABLE.test(n) ? true : [...n].length >= 2;
}

/** 셸(ds WebSearchBox)이 그리는 후보 한 줄 */
export interface ShellSuggestion {
  id: string;
  kind: 'production' | 'artist' | 'venue';
  label: string;
  href: string;
  meta?: string;
  posterUrl?: string;
  /** 굵게 보일 [시작, 끝) 목록(서버가 준 위치). 빈 목록이면 이름 전체 */
  highlights: readonly (readonly [number, number])[];
}

/** 계약 후보 하나 → 셸 후보. 갈 곳이 없으면(ID 없음) 빼고 그린다 */
export function toShellSuggestion(it: SuggestResultItemsItem): ShellSuggestion | undefined {
  const highlights = (it.matches ?? []).flatMap((m) =>
    typeof m.start === 'number' && typeof m.length === 'number' && m.length > 0 && m.start >= 0 && m.start + m.length <= it.label.length ? [[m.start, m.start + m.length] as const] : [],
  );
  if (it.kind === 'PRODUCTION') {
    if (!it.eventId) return undefined;
    const open = parseTime(it.nextOpenAt);
    return {
      id: `p-${it.productionId ?? it.eventId}`,
      kind: 'production',
      label: it.label,
      href: `/events/${encodeURIComponent(it.eventId)}`,
      ...(open !== undefined ? { meta: `${dateTimeText(open)} 오픈` } : {}),
      ...(it.posterUrl ? { posterUrl: it.posterUrl } : {}),
      highlights,
    };
  }
  if (it.kind === 'ARTIST') {
    if (!it.artistId) return undefined;
    return { id: `a-${it.artistId}`, kind: 'artist', label: it.label, href: `/search?artistId=${encodeURIComponent(it.artistId)}`, highlights };
  }
  if (!it.placeId) return undefined;
  return { id: `v-${it.placeId}`, kind: 'venue', label: it.label, href: `/search?placeId=${encodeURIComponent(it.placeId)}`, highlights };
}

/** 최근 검색어(첫 화면 JS에 남는 작은 모듈로 옮겼다, docs/frontend.md §5.8) */
export { parseRecent, RECENT_KEY, RECENT_MAX, RECENT_TEXT_MAX } from './recent-searches.ts';
