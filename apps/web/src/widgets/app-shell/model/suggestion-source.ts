// 머리 검색창 자동완성의 순수 출처(docs/frontend.md §5.8 '머리 검색창 자동완성은 늦게 싣는다', 계획 BAT-165 '### 18').
// 자동완성 모듈(model/autocomplete, @peaket/search-normalize 거르기 포함)은 첫 화면 JS에 넣지 않고 포커스·첫 입력 때(warm) 가져온다.
// - peek: 모듈이 오기 전에는 답을 정하지 않는다(undefined → ds가 load로 넘긴다). 모듈이 온 뒤에는 요청 최소 길이 미만이면 null(창 없음),
//   받은 후보 안에서 거를 수 있으면 그 후보(요청 없음), 아니면 undefined.
// - load: 모듈을 받은 뒤 지금 규칙대로 답한다. 모듈을 못 받으면 null(창 없음)이고 던지지 않는다(catalog-review 16.5.2와 같은 결).
// - selected: 셸이 가려는 주소가 마지막으로 보인 후보면 자동완성 선택 사건(종류, 보인 목록의 1부터 위치)을 세고 바로 보낸다.
// 이 파일은 순수 함수만 둔다(node --test가 바로 불러 본다). 화면 조각(포스터 그림)은 부르는 쪽이 thumbnail로 넘긴다.
import type { SuggestResultItemsItem } from '@peaket/api-client/model';
import type { WebSearchSuggestion } from '@peaket/ds/WebShell';
import type { LastAnswer, ShellSuggestion } from './autocomplete.ts';
import type { SearchQuality } from './search-quality.ts';

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

/** 받은 후보를 기억하는 시간(CDN 60초와 같게 [가정]). 지나면 그 안에서 거르지 않고 다시 부른다 */
export const LAST_TTL_MS = 60_000;

const QUALITY_KIND = { production: 'PRODUCTION', artist: 'ARTIST', venue: 'PLACE' } as const;

export function createSuggestionSource(o: {
  importAutocomplete(): Promise<AutocompleteModule>;
  fetchSuggestions(q: string, signal: AbortSignal): Promise<readonly SuggestResultItemsItem[] | null>;
  now(): number;
  quality?(fn: (q: SearchQuality) => void): void;
  /** 후보의 포스터 그림(화면 조각). 없으면 그림 없이 그린다 */
  thumbnail?(posterUrl: string): WebSearchSuggestion['thumbnail'];
}): SuggestionSource {
  let mod: AutocompleteModule | undefined;
  let loading: Promise<AutocompleteModule | undefined> | undefined;
  let last: (LastAnswer<ShellSuggestion> & { at: number }) | undefined;
  /** 마지막으로 보인 후보(보인 차례 그대로) */
  let shown: readonly ShellSuggestion[] = [];

  const toWeb = (s: ShellSuggestion): WebSearchSuggestion => {
    const thumb = s.posterUrl && o.thumbnail ? o.thumbnail(s.posterUrl) : undefined;
    return {
      id: s.id,
      kind: s.kind,
      label: s.label,
      href: s.href,
      ...(s.meta ? { meta: s.meta } : {}),
      highlights: s.highlights,
      ...(thumb !== undefined ? { thumbnail: thumb } : {}),
    };
  };

  const warm = (): Promise<AutocompleteModule | undefined> => {
    loading ??= o.importAutocomplete().then(
      (m) => (mod = m),
      () => {
        // 다음 포커스·입력 때 다시 가져온다
        loading = undefined;
        return undefined;
      },
    );
    return loading;
  };

  const peek = (query: string): readonly WebSearchSuggestion[] | null | undefined => {
    const m = mod;
    if (!m) return undefined;
    if (!m.minLengthOk(query) || !m.suggestRequestQuery(query)) return null;
    const fresh = last && o.now() - last.at <= LAST_TTL_MS ? last : undefined;
    const local = m.refineLocally(fresh, query, (s) => s.label);
    if (!local) return undefined;
    shown = local;
    return local.map(toWeb);
  };

  return {
    warm: () => void warm(),
    peek,
    async load(query, signal) {
      const m = mod ?? (await warm());
      if (!m) return null;
      const quick = peek(query);
      if (quick !== undefined) return quick;
      const q = m.suggestRequestQuery(query);
      if (!q) return null;
      const raw = await o.fetchSuggestions(q, signal);
      if (raw === null) return null;
      const items = raw.flatMap((it) => m.toShellSuggestion(it) ?? []);
      last = { query: m.normalizeInput(query), items, rawCount: raw.length, at: o.now() };
      shown = items;
      // 검색 품질 사건: 자동완성 창을 보였다(검색어는 싣지 않는다)
      if (items.length > 0) o.quality?.((s) => s.suggestShown());
      return items.map(toWeb);
    },
    selected(href) {
      const i = shown.findIndex((s) => s.href === href);
      if (i < 0) return;
      const s = shown[i]!;
      shown = [];
      // 고르면 곧 화면을 옮기므로 모은 수를 바로 보낸다(떠날 때 보내기가 이동에 묻히지 않게, ADR-0271 결정 16·20)
      o.quality?.((qy) => {
        qy.suggestSelected(QUALITY_KIND[s.kind], i + 1);
        void qy.flush();
      });
    },
  };
}
