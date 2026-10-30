// 스캐너 배치 고르기. 디자인 캔버스는 배치 셋을 따로 그렸다: p 휴대폰 세로(360) · l 휴대폰 가로(780×360) · t 관리형 태블릿 세로(md 768).
// 세 배치는 같은 상태 이름을 쓰지만 본문의 짜임(한 열·두 칸 격자·가운데 600 열)이 달라, CSS 중단점 대신 화면 폭·방향을 읽어 배치를 고른다.
// - 가로: 방향이 가로이고 높이가 600px 이하(휴대폰 가로). 태블릿: 폭 md(768) 이상. 나머지는 휴대폰 세로. 데스크톱 배치는 없다(d5 §3.4).
// - 개발 중 확인용으로 `?layout=p|t|l`을 주면 그 배치로 고정한다(퍼블리싱 상태 고르기와 함께 데이터 연결 단계에서 걷어 낸다).
import { useSyncExternalStore } from "react";

export type ScannerLayout = "p" | "t" | "l";

const LANDSCAPE = "(orientation: landscape) and (max-height: 600px)";
const TABLET = "(min-width: 768px)";

function subscribe(onChange: () => void) {
  const queries = [window.matchMedia(LANDSCAPE), window.matchMedia(TABLET)];
  for (const q of queries) q.addEventListener("change", onChange);
  return () => {
    for (const q of queries) q.removeEventListener("change", onChange);
  };
}

function snapshot(): ScannerLayout {
  if (window.matchMedia(LANDSCAPE).matches) return "l";
  if (window.matchMedia(TABLET).matches) return "t";
  return "p";
}

export function forcedLayout(search: string): ScannerLayout | undefined {
  const v = new URLSearchParams(search).get("layout");
  return v === "p" || v === "t" || v === "l" ? v : undefined;
}

export function useScannerLayout(search: string): ScannerLayout {
  const media = useSyncExternalStore(subscribe, snapshot, (): ScannerLayout => "p");
  return forcedLayout(search) ?? media;
}
