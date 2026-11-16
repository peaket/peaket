// 머리 검색창의 최근 검색어 규칙(docs/frontend.md §3.12 `peaket.recentSearches`). 자동완성 모듈과 떼어 첫 화면 JS에 남긴다(자동완성은 늦게 싣는다, §5.8).
// 이 파일은 순수 함수만 둔다(node --test가 바로 불러 본다).

/** 최근 검색어 저장 이름과 상한(docs/frontend.md §3.12 `peaket.recentSearches`, 10개 [가정]) */
export const RECENT_KEY = 'peaket.recentSearches';
export const RECENT_MAX = 10;
/** 최근 검색어 한 개의 글자 수 상한(검색어 50자, 계약 q) */
export const RECENT_TEXT_MAX = 50;

/** 저장소 값 → 최근 검색어(모양이 틀리면 빈 목록) */
export function parseRecent(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= RECENT_TEXT_MAX).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
