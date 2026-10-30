// 아주 작은 경로 고르기(History API). 정본 스택(docs/frontend.md §2.3 스캐너 행)에 라우터 라이브러리가 없어 앱 안에 둔다.
// - 경로 다섯(/login·/setup·/scan·/sync·/manage)과 /enroll·/error·/preview만 고르면 되므로 주소 문자열을 그대로 비교한다.
// - 화면 사이는 SPA 이동이다(frontend §2.7). 같은 출처의 왼쪽 클릭만 가로채고, 새 탭·수정 키·바깥 주소는 브라우저에 맡긴다.
import type { StateSwitcherProps } from "@peaket/ds/Preview";
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

const NAV_EVENT = "peaket-scanner:navigate";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAV_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAV_EVENT, onChange);
  };
}

const snapshot = () => window.location.pathname + window.location.search;

/** 지금 주소(경로와 검색 문자열). 끝의 '/'는 뗀다 */
export function useLocation(): { pathname: string; search: string } {
  const href = useSyncExternalStore(subscribe, snapshot, () => "/");
  const q = href.indexOf("?");
  const rawPath = q === -1 ? href : href.slice(0, q);
  const pathname = rawPath.length > 1 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  return { pathname, search: q === -1 ? "" : href.slice(q) };
}

export function navigate(href: string, options?: { replace?: boolean }) {
  if (options?.replace) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  window.dispatchEvent(new Event(NAV_EVENT));
}

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
}

export function Link({ href, onClick, target, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (target && target !== "_self") return;
    if (href.startsWith("#")) return;
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  };
  return <a href={href} target={target} onClick={handleClick} {...rest} />;
}

type RenderLink = NonNullable<StateSwitcherProps["renderLink"]>;

/** ds 부품(StateSwitcher·PreviewCatalog·ScannerStatusStrip)에 넘기는 링크 */
export const renderLink: RenderLink = (props) => <Link {...props} />;
