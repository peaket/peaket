// 퍼블리싱 상태 고르기(add-screen-publishing design.md 결정 7). 데이터 연결 단계에서 걷어 낸다(ADR-0170).
// - 상태 이름은 디자인 캔버스 보드의 state 열거값(한국어)이다. 보드에 없고 d5 상태 표에만 있는 상태는 뒤에 더했다.
// - 스캐너는 라이트 고정이라 `?theme=dark`를 읽지 않는다(d1 §4). ds StateSwitcher의 '다크로 보기' 링크는 눌러도 그대로 라이트다.
import { resolvePreviewState, StateSwitcher } from "@peaket/ds/Preview";
import { forcedLayout, useScannerLayout, type ScannerLayout } from "./layout";
import { renderLink, useLocation } from "./router";

export function usePreviewState<S extends string>(
  states: readonly S[],
  fallback: S,
): { state: S; layout: ScannerLayout; pathname: string; search: string } {
  const { pathname, search } = useLocation();
  const state = resolvePreviewState(search, states, fallback);
  const layout = useScannerLayout(search);
  return { state, layout, pathname, search };
}

/** 개발 서버에서만 보이는 상태 고르기 패널 */
export function PreviewSwitcher({ states, current }: { states: readonly string[]; current: string }) {
  const { pathname, search } = useLocation();
  if (!import.meta.env.DEV) return null;
  return (
    <StateSwitcher
      path={pathname}
      states={states}
      current={current}
      keep={{ layout: forcedLayout(search) }}
      renderLink={renderLink}
      allowDark={false}
    />
  );
}
