// GAT-030 키 증명 PoC의 열화 단계 다섯과 판정 규칙.
// 값은 모두 [가정]이다: 실제 카메라의 원근·초점·눈부심을 재현하지 않고, 캔버스 흐림·평면 회전·밝기만 건다.
// 단계가 올라갈수록 흐림·기울임이 커지고 밝기가 낮아진다. 다섯 단계를 모두 같은 폭(351px)으로 잰다.

/** @typedef {{ id: string, label: string, blurPx: number, rotateDeg: number, brightness: number }} DegradationLevel */

/** @type {ReadonlyArray<DegradationLevel>} */
export const LEVELS = Object.freeze([
  { id: 'L1', label: '맑음', blurPx: 0, rotateDeg: 0, brightness: 1 },
  { id: 'L2', label: '약한 열화', blurPx: 1, rotateDeg: 5, brightness: 0.85 },
  { id: 'L3', label: '중간 열화', blurPx: 2, rotateDeg: 10, brightness: 0.7 },
  { id: 'L4', label: '강한 열화', blurPx: 3, rotateDeg: 15, brightness: 0.55 },
  { id: 'L5', label: '매우 강한 열화', blurPx: 4, rotateDeg: 20, brightness: 0.4 },
]);

/** 표시용: 흐림 px·기울임 도·밝기 배율 */
export function levelText(level) {
  return `흐림 ${level.blurPx}px · 기울임 ${level.rotateDeg}° · 밝기 ${level.brightness.toFixed(2)}`;
}

/** 가장 가까운 차례(nearest-rank) 백분위. 빈 배열은 던진다 */
export function percentile(sorted, p) {
  if (!sorted.length) throw new Error('백분위를 낼 표본이 없습니다');
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}

/**
 * 한 칸(판 × 단계)의 결과를 요약한다.
 * times에는 실패한 시도의 시간도 들어간다(인식 시간은 성공·실패를 함께 본 값이다).
 */
export function summarize({ times, failures, errors = 0 }) {
  if (!Array.isArray(times) || times.length === 0) throw new Error('시간 표본이 없습니다');
  const sorted = [...times].sort((a, b) => a - b);
  const attempts = times.length;
  const sum = times.reduce((n, v) => n + v, 0);
  return {
    attempts,
    failures,
    errors,
    failureRate: failures / attempts,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / attempts,
  };
}

/** 실패율이 처음 이 값을 넘는 단계의 차례. 없으면 Infinity */
export function firstLevelOver(panelResults, threshold = 0.1) {
  for (let i = 0; i < LEVELS.length; i++) {
    const r = panelResults[LEVELS[i].id];
    if (r && r.failureRate > threshold) return i;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * PC 측정만으로 내리는 판정(채택 결정 자체는 소유자 몫이다).
 * 규칙 [가정]:
 *  ① 맑은 단계(L1)에서 키 증명 판이 1% 넘게 실패하지 않는다.
 *  ② 맑은 단계(L1)의 p95가 판정 예산 150ms(offline-gate §6.4 10번) 안에 든다. 디코딩 몫만 잰 값이다.
 *  ③ 실패율 10%를 처음 넘는 단계가 QR v1보다 앞서지 않는다.
 *  ④ 약한 열화(L2)에서 키 증명 판 실패율이 5% 이하다.
 * 넷을 모두 지키면 '채택 가능(조건부)', 아니면 '보류'다. 실기기 확인 결과가 오기 전의 PC 판정이다.
 */
export function judge(results) {
  const clean = results['key-proof'].L1;
  const mild = results['key-proof'].L2;
  const qrEdge = firstLevelOver(results['qr-v1']);
  const proofEdge = firstLevelOver(results['key-proof']);
  const checks = [
    { id: '①', pass: clean.failureRate <= 0.01, text: `맑음(L1) 실패율 ${(clean.failureRate * 100).toFixed(1)}% ≤ 1%` },
    { id: '②', pass: clean.p95 <= 150, text: `맑음(L1) p95 ${clean.p95.toFixed(1)}ms ≤ 150ms` },
    {
      id: '③',
      pass: proofEdge >= qrEdge,
      text: `실패율 10% 첫 단계: 키 증명 ${levelName(proofEdge)} · QR v1 ${levelName(qrEdge)} (키 증명이 앞서지 않아야 한다)`,
    },
    { id: '④', pass: mild.failureRate <= 0.05, text: `약한 열화(L2) 실패율 ${(mild.failureRate * 100).toFixed(1)}% ≤ 5%` },
  ];
  const pass = checks.every((c) => c.pass);
  return {
    verdict: pass ? '채택 가능(조건부)' : '보류',
    checks,
    edge: { qrV1: levelName(qrEdge), keyProof: levelName(proofEdge) },
  };
}

function levelName(index) {
  return Number.isFinite(index) ? LEVELS[index].id : '없음(10% 넘는 단계 없음)';
}

/** 사람이 읽는 Markdown 표(도구가 표준 출력으로 낸다) */
export function markdownTable(results) {
  const rows = ['| 판 | 단계 | 열화 | p50(ms) | p95(ms) | 실패율 | 실패/시도 |', '| --- | --- | --- | ---: | ---: | ---: | ---: |'];
  for (const [panelId, panelLabel] of [
    ['qr-v1', '지금 QR v1'],
    ['key-proof', '키 증명 판'],
  ]) {
    for (const level of LEVELS) {
      const r = results[panelId][level.id];
      rows.push(
        `| ${panelLabel} | ${level.id} | ${levelText(level)} | ${r.p50.toFixed(2)} | ${r.p95.toFixed(2)} | ${(r.failureRate * 100).toFixed(1)}% | ${r.failures}/${r.attempts} |`,
      );
    }
  }
  return rows.join('\n');
}
