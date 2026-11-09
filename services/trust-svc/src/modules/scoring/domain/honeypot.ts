// 허니팟 기록 조건(docs/features/bot-defense.md §7, docs/features/queue-admission.md §7 '기록 조건', ADR-0065 결정 9).
// 같은 출처에서 사람이 일으킨 요청만 적중으로 센다. 다른 사이트가 부르게 한 요청과 브라우저·라우터의 미리 가져오기는 세지 않는다.

/** pid 하나가 24시간에 판정 기록을 낼 수 있는 회차 수 [가정](값을 바꿔 부르는 사람이 기록을 늘리지 못하게 한다, ADR-0249 결정 3) */
export const HONEYPOT_EVENTS_PER_PID = 20;

export interface HoneypotHeaders {
  fetchSite: string | undefined;
  purpose: string | undefined;
  routerPrefetch: string | undefined;
}

/** 머리 셋만 본다. 머리 값은 대소문자를 가리지 않는다 */
export function countsAsHoneypotHit(h: HoneypotHeaders): boolean {
  if (h.fetchSite?.trim().toLowerCase() !== 'same-origin') return false;
  if (h.purpose?.toLowerCase().includes('prefetch')) return false;
  return h.routerPrefetch === undefined;
}
