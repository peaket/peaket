// 온세일 윈도우(명령 12의 실행 조건, ADR-0349 결정 2, docs/features/control-tower.md §3 12행 '온세일 윈도우(T-10분~T+60분) 밖에서만').
// 판매 시작 T로 [T − 10분, T + 60분)이면 창 안이다: T − 10분 − 1ms는 창 밖(받음), T − 10분 정각은 창 안(거절), T + 60분 정각은 창 밖(받음).
// 판매 승인 전(core 404, 판매 시작 없음)은 창 밖으로 본다. 판매 설정을 읽지 못하면 이 함수까지 오지 않는다(503 onsale-window-unavailable).

/** 창 시작: 판매 시작 10분 전 */
export const ONSALE_WINDOW_BEFORE_MS = 10 * 60_000;
/** 창 끝: 판매 시작 60분 뒤(이 시각은 창 밖이다) */
export const ONSALE_WINDOW_AFTER_MS = 60 * 60_000;
/** 판매 설정 읽기 한도 5초(ADR-0349 결정 2). 넘으면 503 onsale-window-unavailable */
export const ONSALE_WINDOW_READ_TIMEOUT_MS = 5_000;

/** 지금이 판매 시작 saleStartMs의 온세일 윈도우 안인가. saleStartMs가 없으면(판매 승인 전) 창 밖이다 */
export function inOnsaleWindow(saleStartMs: number | undefined, nowMs: number): boolean {
  if (saleStartMs === undefined) return false;
  return nowMs >= saleStartMs - ONSALE_WINDOW_BEFORE_MS && nowMs < saleStartMs + ONSALE_WINDOW_AFTER_MS;
}
