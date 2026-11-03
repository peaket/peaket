// 보드를 옮긴 화면이 함께 쓰는 것: ?state= 고르기, 배치(휴대폰·태블릿·데스크톱), 화면 제목, 겹침 닫기.
// ?state=가 없으면 그 배치 보드의 기본 상태다(휴대폰 보드는 기본 상태가 다를 수 있다. 예: SCR-030 휴대폰은 '두 번째 승인(민호)').
// 겹침(대화상자·시트)을 닫으면 기본 상태로 돌아간다(퍼블리싱에서는 상태가 주소에 있어서다).
// 배치마다 보드의 상태 열거값이 다르다(예: 휴대폰 보드에만 있는 상태). 그 배치 보드에 없는 상태는 gaps로 가장 가까운 상태로 바꿔 그리고,
// 상태 고르기 패널에는 그 배치 보드의 상태(boardStates)만 보인다. 빈 본문이 나오는 조합을 남기지 않으려는 것이다.
import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import type { ConsoleLayout } from '@peaket/ds/ConsoleShell';
import { previewHref, resolvePreviewState } from '@peaket/ds/Preview';
import { useLayout } from './layout';
import { usePreviewKeep } from './preview';
import { useDocumentTitle } from './title';

/** 배치 보드에 없는 상태 → 그 배치에서 바꿔 그릴 가장 가까운 상태(값이 없는 키는 그 배치의 기본 상태) */
export type BoardGaps<S extends string> = Partial<Record<ConsoleLayout, Partial<Record<S, S | null>>>>;

export function useBoardPage<S extends string>(
  title: string,
  states: readonly S[],
  fallback: S | Partial<Record<ConsoleLayout, S>> & { desktop: S },
  gaps?: BoardGaps<S>,
) {
  const layout = useLayout();
  const def: S = typeof fallback === 'string' ? fallback : (fallback[layout] ?? fallback.desktop);
  const [params] = useSearchParams();
  const requested = resolvePreviewState(params, states, def);
  const gap = gaps?.[layout];
  /** 그리는 상태: 이 배치 보드에 없는 상태면 가장 가까운 상태 */
  const state: S = gap && requested in gap ? (gap[requested] ?? def) : requested;
  /** 이 배치 보드가 그리는 상태(상태 고르기 패널에 보인다) */
  const boardStates: readonly S[] = gap ? states.filter((s) => !(s in gap)) : states;
  useDocumentTitle(title);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const keep = usePreviewKeep();
  const keepKey = JSON.stringify(keep);
  const close = useCallback(
    () => navigate(previewHref(pathname, undefined, JSON.parse(keepKey) as Record<string, string | undefined>)),
    [navigate, pathname, keepKey],
  );
  /** 같은 화면의 다른 상태로 가는 주소(보드 안 탭·버튼이 상태를 바꿀 때) */
  const hrefFor = useCallback(
    (s: S) => previewHref(pathname, s, JSON.parse(keepKey) as Record<string, string | undefined>),
    [pathname, keepKey],
  );
  /** 보드 안 탭·재생 버튼이 다른 상태로 옮길 때 */
  const go = useCallback((s: string) => navigate(hrefFor(s as S)), [navigate, hrefFor]);
  return { state, requested, boardStates, layout, close, hrefFor, go, defaultState: def };
}
