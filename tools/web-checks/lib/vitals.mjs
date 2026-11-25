// web-vitals p75 집계와 FE-T10 랩 판정(F-08-1, docs/frontend.md §5.8 '판정은 둘로 나눈다'·§5.17 FE-T10, NFR-012).
// 숫자만 다루는 순수 함수다(브라우저 없이 node --test로 시험한다). 정본 값은 docs/frontend.md와 docs/planning/02 NFR-012다.
// p75는 오름차순 정렬 뒤 ceil(0.75 × n) − 1번째(최근접 순위, 보간 없음)다. 20회면 15번째로 작은 값이다(계획 F-08-1 2절 3).
// 무효 회차는 빼되 수와 까닭을 남기고, 20회를 채우지 못하면 '잠정'이라 통과로 세지 않는다.

/** FE-T10·NFR-012: INP 200ms 이하 */
export const INP_LIMIT_MS = 200;
/** FE-T10·NFR-012: LCP 2.5초 이하 */
export const LCP_LIMIT_MS = 2500;
/** FE-T10·NFR-012: CLS 0.1 이하 */
export const CLS_LIMIT = 0.1;
/** FE-T10: 대기실 통과 뒤 좌석맵 첫 그림 1초 미만 */
export const FIRST_PAINT_LIMIT_MS = 1000;
/** FE-T10: 상태 메시지 처리 p95 2ms [가정] */
export const MESSAGE_P95_LIMIT_MS = 2;

/**
 * 오름차순 최근접 순위 백분위(보간 없음). p=0이면 가장 작은 값, p=1이면 가장 큰 값.
 * @param {number[]} xs
 * @param {number} p 0 이상 1 이하
 */
export function percentile(xs, p) {
  if (!Array.isArray(xs) || xs.length === 0) throw new Error('값이 없다');
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new TypeError(`비율은 0 이상 1 이하여야 한다(받은 값 ${p})`);
  for (const x of xs) if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`값은 유한한 숫자여야 한다(받은 값 ${x})`);
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[i];
}

/** p75(최근접 순위) */
export const p75 = (xs) => percentile(xs, 0.75);

/** 판정에 쓰는 지표: 회차 칸 이름, 화면 이름, 한도 */
const METRICS = [
  ['firstPaintMs', '첫 그림', FIRST_PAINT_LIMIT_MS],
  ['inpMs', 'INP', INP_LIMIT_MS],
  ['lcpMs', 'LCP', LCP_LIMIT_MS],
  ['cls', 'CLS', CLS_LIMIT],
];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 회차 배열을 모아 지표별 p75·최댓값·표본 수를 낸다. `valid: false`인 회차는 `reason`과 함께 뺀다.
 * 지표가 비어 있는 유효 회차는 그 지표의 표본 수만 줄인다(판정에서 표본 부족으로 실패한다).
 * @param {Array<{valid: boolean, reason?: string, firstPaintMs?: number, inpMs?: number, lcpMs?: number, cls?: number, longTasks?: number[], loafCount?: number, messageP95Ms?: number, heapMB?: number | null}>} runs
 * @param {{reps?: number}} [opts]
 */
export function aggregateRuns(runs, { reps = 20 } = {}) {
  if (!Array.isArray(runs)) throw new TypeError('회차 배열이 아니다');
  if (!Number.isInteger(reps) || reps < 1) throw new TypeError(`회차 수는 1 이상의 정수여야 한다(받은 값 ${reps})`);
  const invalid = [];
  const good = [];
  for (const [i, r] of runs.entries()) {
    if (!r || typeof r !== 'object' || r.valid !== true) invalid.push({ index: i, reason: r?.reason ?? '무효' });
    else good.push(r);
  }
  const metrics = {};
  for (const [key] of METRICS) {
    const values = good.map((r) => r[key]).filter(finite);
    metrics[key] = values.length
      ? { p75: p75(values), max: Math.max(...values), n: values.length }
      : { p75: null, max: null, n: 0 };
  }
  const longTasks = good.flatMap((r) => (Array.isArray(r.longTasks) ? r.longTasks : []));
  const loafCount = good.reduce((n, r) => n + (finite(r.loafCount) ? r.loafCount : 0), 0);
  const messageValues = good.map((r) => r.messageP95Ms).filter(finite);
  metrics.messageP95Ms = messageValues.length
    ? { p75: p75(messageValues), max: Math.max(...messageValues), n: messageValues.length }
    : { p75: null, max: null, n: 0 };
  const heaps = good.map((r) => r.heapMB).filter(finite);
  const heapMB = heaps.length ? { p75: p75(heaps), max: Math.max(...heaps), n: heaps.length } : null;
  return {
    reps,
    n: good.length,
    invalid,
    provisional: good.length < reps,
    metrics,
    longTasks: { count: longTasks.length, totalMs: Math.round(longTasks.reduce((a, b) => a + b, 0) * 100) / 100 },
    loaf: { count: loafCount },
    heapMB,
  };
}

/**
 * FE-T10 랩 판정. 지표마다 p75를 한도와 견주고, 긴 작업은 회차 전체 합이 0이어야 하며 메시지 p95는 최댓값을 본다.
 * 힙은 판정에 쓰지 않는다(보조 숫자, ADR-0096).
 * @param {ReturnType<typeof aggregateRuns>} agg
 */
export function labVerdict(agg) {
  if (!agg || !Number.isInteger(agg.n)) throw new TypeError('집계 결과가 아니다');
  const reasons = [];
  const metrics = {};
  if (agg.n === 0) {
    return { status: 'unknown', reasons: ['유효 회차가 없다'], metrics, longTasks: agg.longTasks ?? { count: 0, totalMs: 0 }, provisional: true };
  }
  for (const [key, label, limit] of METRICS) {
    const m = agg.metrics?.[key] ?? { p75: null, n: 0, max: null };
    if (m.n !== agg.n) {
      metrics[key] = { value: m.p75, limit, status: 'fail' };
      reasons.push(`${label} 표본 ${m.n}/${agg.n}`);
      continue;
    }
    const pass = m.p75 <= limit;
    metrics[key] = { value: m.p75, limit, status: pass ? 'pass' : 'fail' };
    if (!pass) reasons.push(`${label} p75 ${m.p75} > ${limit}`);
  }
  const msg = agg.metrics?.messageP95Ms ?? { max: null, n: 0 };
  if (msg.n !== agg.n) {
    metrics.messageP95Ms = { value: msg.max, limit: MESSAGE_P95_LIMIT_MS, status: 'fail' };
    reasons.push(`메시지 p95 표본 ${msg.n}/${agg.n}`);
  } else {
    const pass = msg.max <= MESSAGE_P95_LIMIT_MS;
    metrics.messageP95Ms = { value: msg.max, limit: MESSAGE_P95_LIMIT_MS, status: pass ? 'pass' : 'fail' };
    if (!pass) reasons.push(`메시지 p95 최댓값 ${msg.max} > ${MESSAGE_P95_LIMIT_MS}`);
  }
  if (agg.longTasks.count > 0) {
    metrics.longTasks = { value: agg.longTasks.count, limit: 0, status: 'fail' };
    reasons.push(`긴 작업 ${agg.longTasks.count}건(합 ${agg.longTasks.totalMs}ms)`);
  } else {
    metrics.longTasks = { value: 0, limit: 0, status: 'pass' };
  }
  const failed = reasons.length > 0;
  const status = failed ? 'fail' : agg.provisional ? 'provisional' : 'pass';
  return { status, reasons, metrics, longTasks: agg.longTasks, provisional: agg.provisional };
}

const STATUS_KO = { pass: '통과', fail: '실패', provisional: '잠정', unknown: '알 수 없음' };
const fmt = (v, digits = 0) => (typeof v === 'number' && Number.isFinite(v) ? (digits ? v.toFixed(digits) : String(Math.round(v))) : '-');

/**
 * 모드별 랩 결과를 Markdown으로 낸다(측정 보고서에 붙인다). 20회를 못 채운 모드는 '잠정'을 붙인다.
 * @param {{reps: number, profile: string, modes: {name: string, label: string, summary: ReturnType<typeof aggregateRuns>, verdict: ReturnType<typeof labVerdict>}[]}} o
 */
export function renderLabReport({ reps, profile, modes }) {
  const head = ['모드', '판정', '유효/전체', '첫 그림 p75/최대(ms)', 'INP p75/최대(ms)', 'LCP p75(ms)', 'CLS p75', '긴 작업(건)', 'LoAF(건)', '메시지 p95 최대(ms)', '힙 p75(MB)'];
  const cell = (v) => String(v).replaceAll('|', '\\|');
  const rows = modes.map((m) => {
    const s = m.summary;
    const p = (k) => s.metrics[k];
    const status = `${STATUS_KO[m.verdict.status] ?? m.verdict.status}${s.provisional && m.verdict.status === 'provisional' ? '' : s.provisional ? '(잠정)' : ''}`;
    return `| ${cell(m.label)} | ${cell(status)} | ${s.n}/${reps} | ${fmt(p('firstPaintMs').p75)} / ${fmt(p('firstPaintMs').max)} | ${fmt(p('inpMs').p75)} / ${fmt(p('inpMs').max)} | ${fmt(p('lcpMs').p75)} | ${fmt(p('cls').p75, 3)} | ${s.longTasks.count} | ${s.loaf.count} | ${fmt(p('messageP95Ms').max, 3)} | ${s.heapMB ? fmt(s.heapMB.p75, 2) : '-'} |`;
  });
  const reasons = modes.flatMap((m) => (m.verdict.reasons.length ? [`- ${m.label}: ${m.verdict.reasons.join(' · ')}`] : []));
  return [
    '### 좌석맵 랩(Canvas/Worker, 5만 석)',
    '',
    `- 프로필: ${profile}`,
    `- 회차: 모드마다 ${reps}회(정본 §5.8의 20회 [가정]). 20회를 못 채운 모드는 잠정이다`,
    '',
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows,
    '',
    ...(reasons.length ? ['판정 까닭:', ...reasons] : ['판정 까닭: 없음(모든 지표가 한도 안)']),
  ].join('\n');
}
