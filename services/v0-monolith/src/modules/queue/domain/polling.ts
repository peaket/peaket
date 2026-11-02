// 대기 상태 조회의 예상 대기와 거리별 폴링 간격(docs/features/queue-admission.md §4·§13, ADR-0110).
// 브라우저 폴러(docs/frontend.md §5.1 nextDelayMs)의 기본 간격과 같은 식이다. 지터·실패·숨긴 탭 보정은 클라이언트 몫이다.

/** 예상 대기 60초 이하 구간의 폴링 간격(ADR-0110) */
export const POLL_NEAR_MS = 500;
/** 예상 대기 60초 초과 300초 이하 */
export const POLL_MID_MS = 5_000;
/** 예상 대기 300초 초과 */
export const POLL_FAR_MS = 20_000;

/** 속도 0으로 나누지 않게 쓰는 아래 한계(frontend §5.1과 같은 값) */
const MIN_RATE = 0.001;
const NEAR_SECONDS = 60;
const MID_SECONDS = 300;

/**
 * 예상 대기(초) = 앞 인원 ÷ 차례 진행 속도의 올림(POL-007). 앞 인원이 0이면 0, 속도가 0 이하이면 알 수 없어 null이다.
 * @param ahead 앞 인원(0 이상 정수)
 * @param servingRate 차례 진행 속도(1초에 부른 사람 수)
 */
export function etaSeconds(ahead: number, servingRate: number): number | null {
  if (ahead <= 0) return 0;
  if (!(servingRate > 0)) return null;
  return Math.ceil(ahead / servingRate);
}

/**
 * 거리별 폴링 간격(밀리초). 예상 대기 = 앞 인원 ÷ max(속도, 0.001)초가 60 이하면 500, 300 이하면 5,000, 그 밖은 20,000이다.
 */
export function pollIntervalMs(ahead: number, servingRate: number): number {
  const rate = Number.isFinite(servingRate) ? Math.max(servingRate, MIN_RATE) : MIN_RATE;
  const eta = Math.max(ahead, 0) / rate;
  if (eta <= NEAR_SECONDS) return POLL_NEAR_MS;
  if (eta <= MID_SECONDS) return POLL_MID_MS;
  return POLL_FAR_MS;
}
