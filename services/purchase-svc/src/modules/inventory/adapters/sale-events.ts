// SeatExpiries.saleEvents의 값 거르기(메모리·Redis 구현이 함께 쓴다, 추천 적용 2026-11-04 L8·C3). 회차 목록 s:ctl:events에서 회차 ID 모양(KEY_PART)이 아닌 값을 거른다
// (해시 태그를 깨는 값이 임대·만료 키에 들어가지 않게). 거르면 경고를 남기되 파드마다 60초에 한 줄까지다: 1초 반복이 읽을 때마다 한 줄씩 쌓이지 않게 한다.
// 거른 값은 로그에 싣지 않는다(건수만. ASVS 16.2.5). 거를 값이 없으면 경고도 경고 문도 쓰지 않는다.
import type { PlatformLogger } from '@peaket/platform';
import { SALE_EVENTS_WARN_INTERVAL_MS } from '../domain/expiry.js';
import { KEY_PART } from '../domain/hold.js';
import { LogGate, type WallClock } from '../domain/log-gate.js';

/** 거른 값 경고의 문(파드마다 60초에 한 줄, 시각은 주입 Clock) */
export function saleEventsWarnGate(clock: WallClock): LogGate {
  return new LogGate(clock, SALE_EVENTS_WARN_INTERVAL_MS);
}

/**
 * 회차 ID 모양(KEY_PART)인 값만 돌려준다(차례 그대로). 거른 값이 있고 문이 열리면 logger.warn({ dropped: 거른 수 }) 한 줄이다
 * @param all s:ctl:events의 값(글로 바꾼 것)
 */
export function keepEventIds(all: readonly string[], gate: LogGate, logger: PlatformLogger | undefined): string[] {
  const ok = all.filter((x) => KEY_PART.test(x));
  if (ok.length < all.length && gate.allow()) logger?.warn({ dropped: all.length - ok.length }, '회차 목록 s:ctl:events에 회차 ID 모양이 아닌 값이 있어 걸렀다');
  return ok;
}
