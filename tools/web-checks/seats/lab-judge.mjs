// 좌석맵 랩 회차 판정(F-08-1, docs/frontend.md FE-T10, docs/verification.md §3.10 K5).
// seats/lab.spec.mjs가 브라우저에서 모은 회차를 이 파일이 걸러 요약한다. p75·FE-T10 판정은 lib/vitals.mjs가 한다.
// 무효 회차(좌석 수·모드·계측 상태·표본 없음)를 통과로 세지 않고, 20회를 못 채우면 '잠정'이다.
// CPU 4배 느리게 하기는 메인 스레드에만 걸리고 Worker에는 걸리지 않는다(2026-11-04 PoC 확인).
// 그래서 Worker 스레드 몫은 메인 몫 + 배수 × Worker 몫으로 보수적으로 어림하고, 원값과 섞지 않는다(seatmap/judge.mjs와 같은 규칙).
import { aggregateRuns, labVerdict } from '../lib/vitals.mjs';

/** 5만 석(정본 K5·FE-T10의 규모) */
export const SEATS = 50_000;
/** seats/layout.mjs의 구역 25개 */
export const SECTIONS = 25;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 회차 하나가 판정에 쓸 수 있는지. 쓸 수 있으면 null, 아니면 까닭.
 * @param {object | null} run
 */
export function invalidReason(run) {
  if (!run || typeof run !== 'object') return '회차 기록이 없다';
  if (run.seats !== SEATS) return `좌석 수 ${run.seats} ≠ ${SEATS.toLocaleString('en-US')}`;
  if (run.sectionCount !== SECTIONS) return `구역 수 ${run.sectionCount} ≠ ${SECTIONS}`;
  if (run.mode !== 'worker' && run.mode !== 'main-thread') return `모드 ${run.mode}를 모른다`;
  if (run.expectedMode && run.mode !== run.expectedMode) return `모드 ${run.mode} ≠ 기대 ${run.expectedMode}`;
  if (!finite(run.firstPaintMs) || run.firstPaintMs <= 0) return '첫 그림 시각이 없다';
  if (!Array.isArray(run.longTasks)) return '긴 작업 기록이 없다';
  if (!finite(run.messageP95Ms) || run.messageP95Ms < 0) return '메시지 p95가 없다';
  if (!run.clicks || !Number.isInteger(run.clicks.hits) || run.clicks.hits < 1) return '조작이 좌석을 맞히지 못했다';
  const v = run.vitals;
  if (!v || v.status !== 'ready') return `계측 상태 ${v?.status ?? '없음'}`;
  // INP는 16ms 이상 사건만 표본이 된다(Event Timing). 누른 좌석이 있는데 표본이 0이면 모두 16ms 미만이라 0으로 적는다
  const fastNoSample = !finite(v.inpMs) && v.interactions === 0 && run.clicks && run.clicks.hits > 0;
  if (!finite(v.inpMs) && !fastNoSample) return 'INP 표본이 없다';
  if (!finite(v.lcpMs) || v.lcpMs < 0) return 'LCP 표본이 없다';
  if (!finite(v.cls) || v.cls < 0) return 'CLS 표본이 없다';
  return null;
}

/**
 * 한 모드의 회차들을 요약한다. 힙은 판정 지표 밖에 따로 둔다.
 * @param {object[]} runs
 * @param {{mode: 'worker' | 'main-thread', reps?: number}} o
 */
export function summarizeMode(runs, { mode, reps = 20 }) {
  if (mode !== 'worker' && mode !== 'main-thread') throw new TypeError(`모드 ${mode}를 모른다`);
  if (!Array.isArray(runs)) throw new TypeError('회차 배열이 아니다');
  const prepared = runs.map((r) => {
    const reason = invalidReason({ ...r, expectedMode: r?.expectedMode ?? mode });
    return {
      valid: reason === null,
      reason: reason ?? undefined,
      firstPaintMs: r?.firstPaintMs,
      inpMs: finite(r?.vitals?.inpMs) ? r.vitals.inpMs : r?.vitals?.interactions === 0 && r?.clicks?.hits > 0 ? 0 : null,
      lcpMs: r?.vitals?.lcpMs,
      cls: r?.vitals?.cls,
      longTasks: r?.longTasks,
      loafCount: r?.loafCount,
      messageP95Ms: r?.messageP95Ms,
      heapMB: r?.heapMB,
    };
  });
  return { ...aggregateRuns(prepared, { reps }), mode };
}

/** 한 모드의 요약과 FE-T10 판정 */
export function judgeMode(runs, { mode, reps = 20 }) {
  const summary = summarizeMode(runs, { mode, reps });
  return { summary, verdict: labVerdict(summary) };
}

/**
 * Canvas와 Worker를 견준다. 힙 감축률은 보조 숫자이고 판정에 쓰지 않는다(ADR-0096).
 * Worker 첫 그림은 Worker 몫에 CPU 4배가 걸리지 않으므로 이 값만으로 정식 판정하지 않고 PoC 보정값을 함께 본다.
 */
export function compareModes(canvas, worker) {
  const a = canvas?.heapMB?.p75;
  const b = worker?.heapMB?.p75;
  const heapReduction = finite(a) && finite(b) && a > 0 ? Math.round(((a - b) / a) * 10_000) / 10_000 : null;
  return {
    heapReduction,
    secondary: ['heapReduction'],
    note: '힙 감축률은 보조 숫자다(ADR-0096). Worker 첫 그림·풀기 몫에는 CPU 4배가 걸리지 않으므로 PoC judgeK5의 ×4 보정값을 함께 보고, 원값과 섞지 않는다',
  };
}

/** Worker 스레드 몫 보정: 메인 몫 + 배수 × Worker 몫(seatmap/judge.mjs의 stage3와 같은 식) */
export function workerCorrection({ mainMs, workerMs, throttle }) {
  for (const [k, v] of Object.entries({ mainMs, workerMs })) if (!finite(v) || v < 0) throw new TypeError(`${k}는 0 이상의 숫자여야 한다(받은 값 ${v})`);
  if (!finite(throttle) || throttle < 1) throw new TypeError(`배수는 1 이상의 수여야 한다(받은 값 ${throttle})`);
  return Math.round((mainMs + throttle * workerMs) * 100) / 100;
}
