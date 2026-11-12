// 경로 목표와 결제사 장애 배정(docs/verification.md §3.10). k6와 Node 시험이 같은 파일을 읽는다(Node 모듈을 가져오지 않는다).
import { ROUTE_PATTERN } from './model.mjs';

/**
 * 경로 목표(§3.10 '경로 목표 점검'): 경로 → [{ le: 목표 시간(ms), allowed: 허용 비율 }].
 * p99 목표는 0.01, p99.9는 0.001, p95는 0.05다. 같은 경로의 목표는 le 오름차순이다
 */
export const ROUTE_TARGETS = Object.freeze({
  entry: Object.freeze([Object.freeze({ le: 200, allowed: 0.01 })]),
  status: Object.freeze([Object.freeze({ le: 200, allowed: 0.01 })]),
  admission: Object.freeze([Object.freeze({ le: 200, allowed: 0.01 })]),
  hold: Object.freeze([Object.freeze({ le: 50, allowed: 0.01 }), Object.freeze({ le: 150, allowed: 0.001 })]),
  payment: Object.freeze([Object.freeze({ le: 3000, allowed: 0.01 })]),
  scan: Object.freeze([Object.freeze({ le: 150, allowed: 0.05 })]),
});

/** 오류율 목표(§3.10): 경로 → 허용 비율(대기열 경로 0.1% 미만, Q-T2) */
export const ERROR_TARGETS = Object.freeze({ entry: 0.001, status: 0.001, admission: 0.001 });

/**
 * K7 결제 확정의 드레인(ms). 본구간이 끝나면 새 결제를 시작하지 않고, 진행 중인 결제가 끝날 때까지
 * 최대 이 시간만큼 기다린다. 드레인 중 끝난 결제는 실제 시간으로 판정하고, 이 시간이 지나도 끝나지 않은
 * 결제는 위반으로 센다(실제 미확정을 숨기지 않는다).
 */
export const PAYMENT_DRAIN_MS = 20_000;

/**
 * K7 결제 상태 조회의 최소 폴링 시간(ms). 이 시간 전에 비끝 답으로 끝내면 3초 목표를 재기 전에
 * 포기한 것이다. 빠른 비끝 답(기다림 표가 참·멈춤 등)은 짧게 쉬었다 다시 묻는다.
 */
export const PAYMENT_STATUS_POLL_MIN_MS = 3_000;
/** 빠른 비끝 답 사이의 짧은 쉼(ms). 3초 동안 최대 30번 묻는다 */
export const PAYMENT_STATUS_POLL_INTERVAL_MS = 100;
/** 상태 조회 최대 호출 수(안전 상한. 3초 최소 폴링과 20초 전체 상한이 먼저 선다) */
export const PAYMENT_STATUS_POLL_MAX_CALLS = 100;
/** 상태 조회 전체 상한(ms). 20초 드레인과 맞춘다 */
export const PAYMENT_STATUS_POLL_MAX_MS = PAYMENT_DRAIN_MS;

/**
 * K7 결제 상태 조회를 한 번 더 할지 정한다.
 * - 끝 상태면 멈춘다.
 * - 접수 시작 후 `PAYMENT_STATUS_POLL_MIN_MS` 전이면 빠른 비끝 답이라도 `PAYMENT_STATUS_POLL_INTERVAL_MS`만큼
 *   쉬었다 다시 묻는다(3초 전에 포기하지 않는다).
 * - `PAYMENT_STATUS_POLL_MIN_MS`가 지났거나 전체 상한(`PAYMENT_STATUS_POLL_MAX_MS`)·호출 상한에 닿으면 멈춘다.
 *  3초가 지나도 비끝이면 그때 위반으로 센다.
 * @param {{ startedMs: number, nowMs: number, calls: number, terminal: boolean }} o
 * @returns {{ poll: boolean, sleepMs: number, reason: 'terminal'|'min'|'max'|'calls'|'until-min' }}
 */
export function paymentStatusPollNext({ startedMs, nowMs, calls, terminal }) {
  if (terminal) return { poll: false, sleepMs: 0, reason: 'terminal' };
  const elapsed = nowMs - startedMs;
  if (elapsed >= PAYMENT_STATUS_POLL_MAX_MS) return { poll: false, sleepMs: 0, reason: 'max' };
  if (calls >= PAYMENT_STATUS_POLL_MAX_CALLS) return { poll: false, sleepMs: 0, reason: 'calls' };
  if (elapsed >= PAYMENT_STATUS_POLL_MIN_MS) return { poll: false, sleepMs: 0, reason: 'min' };
  return { poll: true, sleepMs: Math.min(PAYMENT_STATUS_POLL_INTERVAL_MS, PAYMENT_STATUS_POLL_MIN_MS - elapsed), reason: 'until-min' };
}

/**
 * 끝 상태가 아닌데 3초 전에 끝낸 결제인가(시나리오 조기 종료). 이 값이 참이면 3초 목표를 재기 전에
 * 포기한 것이므로 측정 방법 문제다.
 * @param {{ tookMs: number, terminal: boolean }} o
 */
export function paymentPendingBefore3s({ tookMs, terminal }) {
  return !terminal && tookMs < PAYMENT_STATUS_POLL_MIN_MS;
}

/**
 * 본구간이 끝난 뒤 진행 중이던 결제가 드레인 중에 끝났는가.
 * 본구간 전에 시작했고(`startedMs < mainEndMs`) 본구간 뒤에 끝났으면(`finishedMs > mainEndMs`) 참이다.
 * @param {{ startedMs: number, finishedMs: number, mainEndMs: number }} o
 */
export function paymentDrainFinished({ startedMs, finishedMs, mainEndMs }) {
  return mainEndMs > 0 && startedMs < mainEndMs && finishedMs > mainEndMs;
}

/**
 * 드레인 중 새 결제를 시작하려는가(그러면 안 된다). 본구간 끝과 같거나 뒤에 시작하면 참이다.
 * @param {{ startedMs: number, mainEndMs: number }} o
 */
export function paymentDrainNewStart({ startedMs, mainEndMs }) {
  return mainEndMs > 0 && startedMs >= mainEndMs;
}

/**
 * 드레인 20초가 지나도 끝나지 않은 결제 수 = 시작한 수 - 끝난 수(음수는 0).
 * 시작·끝은 0 이상의 안전한 정수다(아니면 RangeError).
 * @param {{ started: number, finished: number }} o
 */
export function paymentDrainUnfinished({ started, finished }) {
  if (!Number.isSafeInteger(started) || started < 0) throw new RangeError(`시작한 결제 수는 0 이상의 안전한 정수다: ${started}`);
  if (!Number.isSafeInteger(finished) || finished < 0) throw new RangeError(`끝난 결제 수는 0 이상의 안전한 정수다: ${finished}`);
  return Math.max(0, started - finished);
}

/**
 * K7 결제 한 반복이 `payment_p99_3000ms` 초과인가.
 * 드레인 중 끝난 결제도 실제 시간으로 판정한다. 끝 상태가 아니면(UNKNOWN·PENDING 등) 위반이고,
 * 끝 상태면 접수 시작→끝 상태가 3,000ms를 넘었는지로 정한다.
 * @param {{ tookMs: number, terminal: boolean }} o
 */
export function paymentOverTarget({ tookMs, terminal }) {
  if (!terminal) return true;
  return tookMs > 3_000;
}


/**
 * 요청 하나가 넘은 목표 시간(ms) 목록. 목표 시간보다 '큰' 것만 넘은 것이다(같으면 넘지 않음).
 * 목표가 없는 경로는 빈 배열이다. durationMs가 유한한 수가 아니면 RangeError(음수는 0으로 본다: VM 시계가 거꾸로 간 k6 값)
 * @param {string} route
 * @param {number} durationMs
 * @returns {number[]}
 */
export function overTargets(route, durationMs) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) throw new RangeError(`요청 시간은 유한한 수다: ${durationMs}`);
  const d = Math.max(0, durationMs);
  const targets = Object.hasOwn(ROUTE_TARGETS, route) ? ROUTE_TARGETS[route] : [];
  return targets.filter((t) => d > t.le).map((t) => t.le);
}

/**
 * 경로 목표 지표가 요약에 남도록 거는 k6 기준(thresholds): 목표가 있는 경로마다
 * 'over_target{phase:main,route:<경로>,le:<ms>}': ['count>=0']. 목표가 없는 경로는 건너뛴다.
 * 경로 이름은 lib/model.mjs의 ROUTE_PATTERN(영소문자로 시작하고 영소문자·밑줄 32자 이하, phaseThresholds와 같은 규칙)에 맞고 겹치지 않아야 한다(아니면 RangeError).
 * 그래서 '__proto__'처럼 밑줄로 시작하는 이름은 RangeError이고, 'constructor'처럼 규칙에 맞지만 목표가 없는 이름은 건너뛴다
 * @param {string[]} routes
 * @returns {Record<string, string[]>}
 */
export function targetThresholds(routes) {
  if (!Array.isArray(routes) || !routes.every((r) => typeof r === 'string' && ROUTE_PATTERN.test(r)) || new Set(routes).size !== routes.length) {
    throw new RangeError('경로 이름은 겹치지 않는 영소문자·밑줄 이름이다');
  }
  const out = {};
  for (const r of routes) {
    if (!Object.hasOwn(ROUTE_TARGETS, r)) continue;
    for (const t of ROUTE_TARGETS[r]) out[`over_target{phase:main,route:${r},le:${t.le}}`] = ['count>=0'];
  }
  return out;
}

const isInt = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

/** 비율(0~100, 소수 한 자리까지)의 10배 정수. 소수 둘째 자리가 있거나 범위 밖·숫자가 아니면 NaN */
function tenthsOf(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return NaN;
  const t = Math.round(v * 10);
  return Math.abs(v * 10 - t) < 1e-9 && t >= 0 && t <= 1000 ? t : NaN;
}

/**
 * 결제 하나(가상 사용자 번호 i)에 넣을 결제사 장애(§3.10 K7 ②, 소수 비율은 §3.9 'v1 경로' 추천 적용 2026-11-10, BUILD_ORDER PRF-215).
 * 순위 = (i mod 100) × 10 + ⌊(i mod 1000) ÷ 100⌋(1,000명마다 0~999가 한 번씩)이 dropPct × 10보다 작으면 'drop'(승인한 뒤 응답을 버림),
 * (dropPct + delayPct) × 10보다 작으면 'delay'(승인을 늦춤), 아니면 null. 그래서 1,000명마다 정확히 dropPct × 10명·delayPct × 10명이고,
 * 정수 비율이면 'i mod 100 < 비율'(v0, 100명마다 그 수)과 같은 사람을 고른다.
 * i는 0 이상 정수, dropPct·delayPct는 0~100의 소수 한 자리까지이고 합이 100 이하(아니면 RangeError)
 * @param {number} i
 * @param {number} dropPct
 * @param {number} delayPct
 * @returns {'drop' | 'delay' | null}
 */
export function faultFor(i, dropPct, delayPct) {
  if (!isInt(i, 0, Number.MAX_SAFE_INTEGER)) throw new RangeError(`가상 사용자 번호는 0 이상 정수다: ${i}`);
  const drop = tenthsOf(dropPct);
  const delay = tenthsOf(delayPct);
  if (Number.isNaN(drop) || Number.isNaN(delay) || drop + delay > 1000) throw new RangeError('장애 비율은 0~100의 소수 한 자리까지이고 합이 100 이하다');
  const rank = (i % 100) * 10 + Math.floor((i % 1000) / 100);
  if (rank < drop) return 'drop';
  if (rank < drop + delay) return 'delay';
  return null;
}
