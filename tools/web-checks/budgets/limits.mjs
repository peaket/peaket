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

/** Lighthouse를 주소마다 몇 번 재는가 [가정](가운데 값을 쓴다, docs/frontend.md §5.8 'Lighthouse CI') */
export const RUNS = 3;

/** 적재 지표가 목표를 넘은 주소가 기준선보다 더 나빠져도 되는 여유 [가정]: 시간은 10%, CLS는 0.02 */
export const LOAD_MARGIN = { ms: 0.1, cls: 0.02 };

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
