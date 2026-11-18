// 예산 한도 계산(docs/frontend.md §5.8, BUILD_ORDER BAS-220). 숫자 판정만 두어 node --test로 따로 시험한다.

/** 예산을 넘은 경로가 기준선보다 더 커져도 되는 여유(kB) [가정]. wbs 7.5.2에서 예산을 다시 정할 때까지만 쓴다 */
export const JS_OVER_BUDGET_MARGIN = 1;

/** 첫 JS 한도: 예산 안이면 예산, 기준선(예산을 넘은 경로의 잰 값)이 있으면 그 값 + 여유 */
export function jsLimit(budget, baseline) {
  if (typeof budget !== 'number') throw new TypeError('예산이 없다');
  if (baseline === undefined) return budget;
  if (!(baseline > budget)) throw new Error(`기준선 ${baseline}kB는 예산 ${budget}kB를 넘은 경로에만 둔다`);
  return Math.round((baseline + JS_OVER_BUDGET_MARGIN) * 100) / 100;
}

/** Lighthouse를 주소마다 다섯 번 [가정] 잰다(작은 차례로 늘어놓은 셋째 값, 곧 가운데 값으로 판정한다, docs/frontend.md §5.8 'Lighthouse CI', BAT-174) */
export const RUNS = 5;

/**
 * 적재 지표가 목표를 넘은 주소가 기준선보다 더 나빠져도 되는 여유 [가정]: 시간은 25%, CLS는 0.02.
 * 같은 빌드도 CI 러너가 바뀌면 가운데 값이 13~16% 달라졌다(실행 42504480557과 42506948850, 2026-11-09). 그보다 넓어야 큰 회귀만 잡고 흔들림에 깨지지 않는다
 */
export const LOAD_MARGIN = { ms: 0.25, cls: 0.02 };

/**
 * 적재 지표 한도. 목표가 있으면 목표(넘은 주소는 기준선 + 여유), 목표가 없으면(§5.8 그 행에 LCP가 없다) 잰 값(기준선) + 여유로 회귀만 막는다
 * @param {number | undefined} target
 * @param {number | undefined} baseline
 * @param {'lcpMs' | 'cls' | 'tbtMs'} kind
 */
export function loadLimit(target, baseline, kind) {
  if (target === undefined) {
    if (typeof baseline !== 'number') throw new TypeError(`${kind} 목표가 없는 주소는 기준선이 있어야 한다`);
  } else if (baseline === undefined) {
    return target;
  } else if (!(baseline > target)) {
    throw new Error(`${kind} 기준선 ${baseline}은 목표 ${target}를 넘은 주소에만 둔다`);
  }
  return kind === 'cls' ? Math.round((baseline + LOAD_MARGIN.cls) * 1000) / 1000 : Math.round(baseline * (1 + LOAD_MARGIN.ms));
}

/**
 * Lighthouse 실행 여럿의 가운데 값(짝수면 가운데 둘의 평균)
 * @param {number[]} xs
 */
export function median(xs) {
  if (xs.length === 0) throw new Error('값이 없다');
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 한도를 넘어도 실패 대신 알림만 내는 화면·지표(임시). docs/frontend.md §5.8 'Lighthouse CI', 소유자 결정 2026-11-19 OPEN[52] (다), BAT-176.
 * 항목마다 되돌릴 날(until: 한국 시각 날짜 'YYYY-MM-DD', 그날 끝까지 알림)과 까닭(reason)이 있어야 한다.
 * 한도 값은 바꾸지 않는다(loadLimit 그대로). 되돌릴 날이 지나면 loadVerdict가 저절로 실패를 돌려준다
 */
export const WARN_ONLY = Object.freeze([
  Object.freeze({ page: '월렛', metric: 'lcpMs', until: '2026-11-30', reason: '임시, 되돌릴 날: (나)를 합치는 날, 늦어도 2026-11-30 [가정], OPEN[52]' }),
]);

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 한국 시각(UTC+9) 날짜. CI 러너 시계는 UTC라 되돌릴 날 경계를 한국 시각으로 바꿔 견준다
 * @param {Date} now
 * @returns {string} 'YYYY-MM-DD'
 */
export function kstDate(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('올바른 시각(Date)이 아니다');
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 알림만 항목 하나를 본다. 되돌릴 날이나 까닭이 없으면 알림으로 새지 않게 던진다 */
function checkWarnEntry(e) {
  if (!e || typeof e.page !== 'string' || typeof e.metric !== 'string') throw new TypeError('알림만 항목에 화면(page)과 지표(metric)가 있어야 한다');
  if (typeof e.until !== 'string' || !DATE_RE.test(e.until)) throw new TypeError(`알림만 항목 ${e.page} ${e.metric}의 되돌릴 날은 'YYYY-MM-DD' 꼴이어야 한다`);
  if (typeof e.reason !== 'string' || e.reason.trim() === '') throw new TypeError(`알림만 항목 ${e.page} ${e.metric}에 까닭이 있어야 한다`);
}

/**
 * 적재 지표 하나의 판정. 한도 안이면 pass, 넘으면 화면과 지표가 둘 다 맞는 알림만 항목이 있고 한국 시각 오늘이 되돌릴 날 이하일 때만 warn, 아니면 fail.
 * 받은 한도를 그대로 쓰고 알림이어도 여유를 더하지 않는다. 시계(now)가 없거나 망가졌으면 던진다
 * @param {{ page: string, metric: 'lcpMs' | 'cls' | 'tbtMs', value: number, limit: number, now: Date, warnOnly?: readonly { page: string, metric: string, until: string, reason: string }[] }} args
 * @returns {{ verdict: 'pass' } | { verdict: 'warn', until: string, reason: string } | { verdict: 'fail' }}
 */
export function loadVerdict({ page, metric, value, limit, now, warnOnly = WARN_ONLY }) {
  const today = kstDate(now);
  if (!Array.isArray(warnOnly)) throw new TypeError('알림만 목록은 배열이어야 한다');
  warnOnly.forEach(checkWarnEntry);
  if (typeof value !== 'number' || Number.isNaN(value)) throw new TypeError(`${page} ${metric} 값이 수가 아니다`);
  if (typeof limit !== 'number' || Number.isNaN(limit)) throw new TypeError(`${page} ${metric} 한도가 수가 아니다`);
  if (value <= limit) return { verdict: 'pass' };
  const hit = warnOnly.find((e) => e.page === page && e.metric === metric);
  if (hit && today <= hit.until) return { verdict: 'warn', until: hit.until, reason: hit.reason };
  return { verdict: 'fail' };
}
