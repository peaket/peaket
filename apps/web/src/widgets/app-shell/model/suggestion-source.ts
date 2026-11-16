// 머리 검색창 자동완성의 순수 출처(docs/frontend.md §5.8 '머리 검색창 자동완성은 늦게 싣는다', 계획 BAT-165 '### 18').
// 자동완성 모듈(model/autocomplete, @peaket/search-normalize 포함)은 첫 화면 JS에 넣지 않고 포커스·첫 입력 때(warm) 가져온다.
// BAT-165 시험 담당이 둔 빈 뼈대다. 구현 담당이 search-source.tsx의 훅에서 이 출처를 떼어 채운다.
import type { SuggestResultItemsItem } from '@peaket/api-client/model';
import type { WebSearchSuggestion } from '@peaket/ds/WebShell';

export type AutocompleteModule = typeof import('./autocomplete.ts');

export interface SuggestionSource {
  /** 자동완성 모듈을 가져오기 시작한다(여러 번 불러도 한 번) */
  warm(): void;
  /** 기다리지 않고 답할 수 있으면 그 답(null 창 없음), 아니면 undefined(load로 넘긴다). 모듈이 오기 전에는 늘 undefined */
  peek(query: string): readonly WebSearchSuggestion[] | null | undefined;
  /** 모듈을 받은 뒤 지금 규칙대로 답한다. 모듈을 못 받거나 실패하면 null(창 없음)이고 던지지 않는다 */
  load(query: string, signal: AbortSignal): Promise<readonly WebSearchSuggestion[] | null>;
  /** 셸이 이 주소로 가려 할 때(자동완성 선택 사건) */
  selected(href: string): void;
}

export function createSuggestionSource(_o: {
  importAutocomplete(): Promise<AutocompleteModule>;
  fetchSuggestions(q: string, signal: AbortSignal): Promise<readonly SuggestResultItemsItem[] | null>;
  now(): number;
  quality?(fn: (q: import('./search-quality').SearchQuality) => void): void;
}): SuggestionSource {
  throw new Error('아직 없음');
}
