// 스캐너 경로표(docs/design/d5 §2 인벤토리, docs/frontend.md §2.5). 셸은 화면마다 @peaket/ds/ScannerShell을 쓴다.
// - 경로가 바뀌면 새 화면의 h1로 초점을 옮기고 맨 위로 올린다(frontend §2.7). 상태만 바뀔 때(?state=)는 그대로 둔다.
// - '/'는 앱 실행과 같아 로그인(SCR-036)으로 보낸다(d5 §8.1 '들어옴: 앱 실행', 추천안).
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { LoginScreen } from "../screens/LoginScreen";
import { ManageScreen } from "../screens/ManageScreen";
import { PreviewScreen } from "../screens/PreviewScreen";
import { ScanScreen } from "../screens/ScanScreen";
import { SetupScreen } from "../screens/SetupScreen";
import { SyncScreen } from "../screens/SyncScreen";
import { SystemScreen } from "../screens/SystemScreen";
import { navigate, useLocation } from "./router";

function route(pathname: string): { title: string; node: ReactNode } {
  switch (pathname) {
    case "/":
    case "/login":
      return { title: "현장 스태프 로그인", node: <LoginScreen /> };
    case "/enroll":
      return { title: "기기 등록", node: <LoginScreen enroll /> };
    case "/setup":
      return { title: "근무 준비", node: <SetupScreen /> };
    case "/scan":
      return { title: "티켓 스캔 및 판정", node: <ScanScreen /> };
    case "/sync":
      return { title: "동기화 상태", node: <SyncScreen /> };
    case "/manage":
      return { title: "현장 관리", node: <ManageScreen /> };
    case "/error":
      return { title: "시스템 안내", node: <SystemScreen /> };
    case "/preview":
      // 개발 서버에서만 연다. 운영 빌드에서는 없는 주소(404)다
      if (import.meta.env.DEV) return { title: "화면 목록", node: <PreviewScreen /> };
      return { title: "주소를 찾을 수 없습니다", node: <SystemScreen notFound /> };
    default:
      return { title: "주소를 찾을 수 없습니다", node: <SystemScreen notFound /> };
  }
}

export function App() {
  const { pathname } = useLocation();
  const { title, node } = route(pathname);
  const first = useRef(true);

  useLayoutEffect(() => {
    if (pathname === "/") navigate("/login" + window.location.search, { replace: true });
  }, [pathname]);

  useEffect(() => {
    document.title = `${title} · PEAKET 스캐너`;
  }, [title]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    const h1 = document.querySelector<HTMLElement>("main h1");
    if (h1) {
      h1.setAttribute("tabindex", "-1");
      h1.focus();
    }
  }, [pathname]);

  return node;
}
