// 최초 방문 쿠키에서 위험 판정에 넘길 발급 시각을 구한다(docs/features/bot-defense.md §4.8, ADR-0249 결정 2).
// 쿠키 값은 저장하지 않고 로그에도 싣지 않는다. 맞지 않으면 쿠키가 없는 것으로 보며 판정은 막지 않는다.
import type { FirstVisitCookies, FirstVisitSignals } from '../domain/ports.js';
import { FIRST_VISIT_FUTURE_MS, FIRST_VISIT_MAX_AGE_MS } from '../domain/queue.js';

/**
 * 판정에 넘길 발급 시각(밀리초). 키가 없으면 그 기능을 끈 것이라 disabled로 세고 undefined다.
 * 맞는 쿠키라도 지금보다 앞선 시각(5초 [가정] 넘게)이나 수명을 넘긴 값(1년 + 1일 [가정])이면 없는 것으로 본다
 */
export function firstVisitAtMs(cookies: FirstVisitCookies | undefined, value: string | undefined, now: number, signals: FirstVisitSignals): number | undefined {
  if (!cookies) {
    signals.cookie('disabled');
    return undefined;
  }
  if (value === undefined) {
    signals.cookie('absent');
    return undefined;
  }
  const claims = cookies.read(value);
  if (!claims) {
    signals.cookie('invalid');
    return undefined;
  }
  if (claims.issuedAtMs - now > FIRST_VISIT_FUTURE_MS || now - claims.issuedAtMs > FIRST_VISIT_MAX_AGE_MS) {
    signals.cookie('stale');
    return undefined;
  }
  signals.cookie('ok');
  return claims.issuedAtMs;
}
