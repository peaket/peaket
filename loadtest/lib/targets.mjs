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
 * K7 결제 확정의 본구간 끝 경계(ms). 본구간 마지막 3초 안에 시작한 반복은 k6가 본구간 종료와 함께
 * 끝내지 못해 PENDING으로 남을 수 있다. 그 반복은 결제가 3초를 넘겼다는 증거가 아니므로 초과 집계에서 뺀다.
 * 본구간 밖에서 시작한 비끝 상태는 M6 규칙대로 그대로 초과로 센다(실제 미확정을 숨기지 않는다).
 */
export const PAYMENT_END_GUARD_MS = 3_000;

/**
 * 본구간 마지막 `PAYMENT_END_GUARD_MS` 안에 시작해 끝에서 잘렸을 수 있는 반복인가.
 * @param {{ startedMs: number, mainEndMs: number }} o
 */
export function paymentEndTruncated({ startedMs, mainEndMs }) {
  return mainEndMs > 0 && startedMs >= mainEndMs - PAYMENT_END_GUARD_MS;
}

/**
 * K7 결제 한 반복이 `payment_p99_3000ms` 초과인가.
 * - 끝 상태 여부와 무관하게 본구간 마지막 `PAYMENT_END_GUARD_MS` 안에 시작했으면 초과가 아니다(끝에서 잘린 반복).
 * - 그 밖에서 끝 상태가 아니면(UNKNOWN·PENDING 등) 시작 시각과 무관하게 초과다(M6, 실제 미확정을 숨기지 않는다).
 * - 그 밖은 결제 확정 시간이 3,000ms를 넘었는지로 정한다.
 * @param {{ tookMs: number, terminal: boolean, startedMs: number, mainEndMs: number }} o
 */
export function paymentOverTarget({ tookMs, terminal, startedMs, mainEndMs }) {
  if (paymentEndTruncated({ startedMs, mainEndMs })) return false;
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
