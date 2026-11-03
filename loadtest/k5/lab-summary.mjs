// K5 랩 판정 요약(docs/verification.md §3.10 K5, S-T15의 v0 쪽). seatmap-lab.mjs가 회마다 모은 줄을 요약한다.

const KEYS = ['drawMs', 'inpMs', 'lcpMs', 'cls', 'loafCount', 'loafMs', 'longTasks', 'heapMb'];
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
const r4 = (x) => (x === null ? null : Math.round(x * 10000) / 10000);
const rank = (xs, q) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(q * s.length) - 1)];
};

/**
 * 회마다 한 줄: { rep, drawMs, inpMs, lcpMs, cls, loafCount, loafMs, longTasks, heapMb } (값이 없으면 null).
 * 결과: { reps: 줄 수,
 *   drawMs: { p75, max, missing }, inpMs: { p75, max, missing }, lcpMs: { p75, max, missing }, cls: { p75, max, missing },
 *   loafCount: { sum, max }, longTasks: { sum, max }, heapMb: { median, max, missing } }.
 * p75는 null을 뺀 값을 오름차순으로 놓고 가장 가까운 순위(⌈0.75 × n⌉번째), median은 ⌈0.5 × n⌉번째다. 값이 하나도 없으면 null이고
 * missing은 null의 수다. 수는 소수 첫째 자리(cls는 넷째 자리)로 둥근다. loafCount·longTasks의 null은 0으로 센다.
 * rows가 빈 배열이거나, null이 아닌 값이 음수·유한하지 않은 수면 RangeError
 * @param {Array<{ rep: number, drawMs: number | null, inpMs: number | null, lcpMs: number | null, cls: number | null, loafCount: number | null, loafMs: number | null, longTasks: number | null, heapMb: number | null }>} rows
 */
export function summarizeLab(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new RangeError('요약할 회가 없다');
  for (const r of rows) {
    if (r === null || typeof r !== 'object') throw new RangeError('회 줄이 객체가 아니다');
    for (const k of KEYS) {
      const v = r[k];
      if (v === null || v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new RangeError(`${k}는 0 이상 유한한 수거나 null이다: ${v}`);
    }
  }
  const vals = (k) => rows.map((r) => r[k]).filter((v) => typeof v === 'number');
  const missing = (k) => rows.filter((r) => typeof r[k] !== 'number').length;
  const pct = (k, round) => {
    const xs = vals(k);
    return { p75: round(rank(xs, 0.75)), max: round(xs.length ? Math.max(...xs) : null), missing: missing(k) };
  };
  const sum = (k) => {
    const xs = rows.map((r) => (typeof r[k] === 'number' ? r[k] : 0));
    return { sum: r1(xs.reduce((a, b) => a + b, 0)), max: r1(Math.max(...xs)) };
  };
  const heap = vals('heapMb');
  return {
    reps: rows.length,
    drawMs: pct('drawMs', r1),
    inpMs: pct('inpMs', r1),
    lcpMs: pct('lcpMs', r1),
    cls: pct('cls', r4),
    loafCount: sum('loafCount'),
    longTasks: sum('longTasks'),
    heapMb: { median: r1(rank(heap, 0.5)), max: r1(heap.length ? Math.max(...heap) : null), missing: missing('heapMb') },
  };
}
