// 머리 검색창 자동완성 창의 모양 고르기(d5 §5.3 상태 표: 최근 검색어·후보·후보 없음·불러오는 중·실패는 창 없음). 순수 함수라 node --test가 본다.
export type SearchPopupMode = "closed" | "recent" | "suggest" | "none" | "loading";

/** 비동기 출처의 마지막 답: 어느 검색어의 것인지와 상태(off는 출처가 '창을 띄우지 않음'을 준 것, 요청 최소 길이 미만 등) */
export interface RemoteAnswer {
  q: string;
  status: "loading" | "ready" | "error" | "off";
  count: number;
}

/**
 * preview: 상태 미리보기로 정한 모양(있으면 그대로). async: 비동기 출처를 쓰는가. syncCount: 동기 후보 수.
 * 비동기면 지금 검색어의 답이 아직 없거나 불러오는 중이면 '불러오는 중', 실패·off면 창 없음(Enter는 결과 화면으로), 답이 오면 후보·후보 없음.
 */
export function searchPopupMode(o: { preview: SearchPopupMode | null; q: string; recentCount: number; async: boolean; remote: RemoteAnswer | null; syncCount: number }): SearchPopupMode {
  if (o.preview) return o.preview;
  if (!o.q) return o.recentCount > 0 ? "recent" : "closed";
  if (!o.async) return o.syncCount > 0 ? "suggest" : "none";
  if (!o.remote || o.remote.q !== o.q || o.remote.status === "loading") return "loading";
  if (o.remote.status === "ready") return o.remote.count > 0 ? "suggest" : "none";
  return "closed";
}
