'use client';
// 머리 검색창의 자동완성 출처와 최근 검색어(SCR-003 ⑤·④, d5 §5.3, docs/features/search.md §4.5, BUILD_ORDER HOT-313).
// - 자동완성: `GET /v1/search/suggestions`(CDN 60초)를 정규화한 값으로 부른다(같은 검색이 같은 주소, SR-T11). 요청 최소 길이 미만이면 창을 띄우지 않는다.
//   요청하지 않고 답할 수 있으면(최소 길이 미만·받은 후보 안에서 거르기) ds가 기다리지 않고 바로 쓴다(peek, 뼈대가 깜빡이지 않게). 받은 후보가 8개보다 적으면 더 긴 입력은
//   요청 없이 그 안에서 거른다(model/autocomplete). 디바운스·이전 요청 취소·불러오는 중·실패 상태는 ds WebSearchBox가 한다.
// - 최근 검색어: localStorage `peaket.recentSearches`(10개 [가정], 이 기기에만, 비로그인도, 로그아웃 때 지우지 않는다, docs/frontend.md §3.12).
// api-client는 늦게 가져온다(첫 화면 JS 예산, §5.8).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebSearchSuggestion } from '@peaket/ds/WebShell';
import { derivativeUrl } from '@/shared/lib/image-loader';
import { minLengthOk, normalizeInput, parseRecent, RECENT_KEY, RECENT_MAX, RECENT_TEXT_MAX, refineLocally, suggestRequestQuery, toShellSuggestion, type LastAnswer, type ShellSuggestion } from './model/autocomplete';

function toWeb(s: ShellSuggestion): WebSearchSuggestion {
  return {
    id: s.id,
    kind: s.kind,
    label: s.label,
    href: s.href,
    ...(s.meta ? { meta: s.meta } : {}),
    highlights: s.highlights,
    ...(s.posterUrl
      ? {
          thumbnail: (
            // eslint-disable-next-line @next/next/no-img-element -- 파생본을 CDN에서 바로 받는다(장식, 이름은 옆 글자)
            <img src={derivativeUrl(s.posterUrl, 320, 'webp')} alt="" aria-hidden="true" width={30} height={40} loading="lazy" decoding="async" style={{ width: 30, height: 40, objectFit: 'cover', borderRadius: 4, flex: 'none' }} />
          ),
        }
      : {}),
  };
}

/** 받은 후보를 기억하는 시간(CDN 60초와 같게 [가정]). 지나면 그 안에서 거르지 않고 다시 부른다 */
const LAST_TTL_MS = 60_000;
/** 자동완성 한 번의 시간 상한 [가정]. 일반 읽기의 10초·재시도 대신 짧게 끊어 '자동완성 실패'로 창을 닫는다 */
const SUGGEST_TIMEOUT_MS = 3_000;

/** 자동완성 출처(ds WebShell loadSearchSuggestions·peekSearchSuggestions) */
export function useSuggestionSource(): {
  load: (query: string, signal: AbortSignal) => Promise<readonly WebSearchSuggestion[] | null>;
  peek: (query: string) => readonly WebSearchSuggestion[] | null | undefined;
} {
  const last = useRef<(LastAnswer<ShellSuggestion> & { at: number }) | undefined>(undefined);
  /** 기다리지 않고 바로 답할 수 있으면 그 답: 요청 최소 길이 미만이면 null(창 없음), 받은 후보 안에서 거르면 그 후보, 아니면 undefined(요청) */
  const peek = useCallback((query: string) => {
    if (!minLengthOk(query) || !suggestRequestQuery(query)) return null;
    const fresh = last.current && Date.now() - last.current.at <= LAST_TTL_MS ? last.current : undefined;
    const local = refineLocally(fresh, query, (s) => s.label);
    return local ? local.map(toWeb) : undefined;
  }, []);
  const load = useCallback(
    async (query: string, signal: AbortSignal) => {
      const quick = peek(query);
      if (quick !== undefined) return quick;
      const q = suggestRequestQuery(query)!;
      const [{ getSearchSuggestions }, api] = await Promise.all([import('@peaket/api-client/endpoints/catalog'), import('@/shared/api')]);
      api.ensureBrowserApi();
      // 화면의 취소 신호와 짧은 시간 상한을 함께(AbortSignal.any 대신 직접 묶는다)
      const ctrl = new AbortController();
      const stop = () => ctrl.abort();
      signal.addEventListener('abort', stop);
      const timer = setTimeout(stop, SUGGEST_TIMEOUT_MS);
      try {
        const r = await getSearchSuggestions({ q }, { signal: ctrl.signal });
        const raw = r.data.items ?? [];
        const items = raw.flatMap((it) => toShellSuggestion(it) ?? []);
        last.current = { query: normalizeInput(query), items, rawCount: raw.length, at: Date.now() };
        return items.map(toWeb);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      }
    },
    [peek],
  );
  return { load, peek };
}

/** 최근 검색어(이 기기). 처음 그리기는 빈 목록이고 붙은 뒤 저장소에서 읽는다(서버 그림과 어긋나지 않게) */
export function useRecentSearches(): { recent: string[]; save: (list: string[]) => void } {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    try {
      setRecent(parseRecent(window.localStorage.getItem(RECENT_KEY)));
    } catch {
      // 저장소를 못 쓰면 이 화면에서만 쓴다
    }
  }, []);
  const save = useCallback((list: string[]) => {
    const next = list.filter((t) => t.length <= RECENT_TEXT_MAX).slice(0, RECENT_MAX);
    setRecent(next);
    try {
      if (next.length === 0) window.localStorage.removeItem(RECENT_KEY);
      else window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // 저장하지 못해도 이 화면에서는 쓴다
    }
  }, []);
  return { recent, save };
}
