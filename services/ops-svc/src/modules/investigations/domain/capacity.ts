// F-04-19 조사 갈래 용량 외삽(동결 로컬, LCH-340).
// 정본: docs/features/forensic-replay.md §7.2·§8(FX-T22), docs/planning/02 §3.1 원칙 5.
// 실제 1/10 측정은 미실행이다. 이 파일은 측정값을 10배로 외삽하고 [추정]/미측정을 구분하는 계산만 둔다.

export type CapacityId = 'snapshot' | 'cluster' | 'replay-file' | 'evidence-bundle';
export interface CapacityMeasurement {
  id: CapacityId;
  /** 1/10 규모에서 잰 값(ms). null이면 미측정 */
  measuredMs: number | null;
  /** 1/10 규모의 입력 행 수 [가정] */
  rows: number;
  /** §7.2 목표(ms) */
  targetMs: number;
}
export interface CapacityEstimate {
  id: CapacityId;
  basis: 'MEASURED_EXTRAPOLATION' | 'UNMEASURED';
  label: '[추정]' | '미측정';
  measuredMs: number | null;
  extrapolatedMs: number | null;
  targetMs: number;
  ratio: number | null;
  verdict: 'PASS_ESTIMATE' | 'FAIL_ESTIMATE' | 'UNMEASURED';
  assumptions: readonly string[];
}

const ASSUMPTIONS = ['선형 비례', '1/10 규모 측정값 × 10', '실측 아님'] as const;

export function extrapolateCapacity(m: CapacityMeasurement, o: { factor?: number } = {}): CapacityEstimate {
  const factor = o.factor ?? 10;
  if (!Number.isFinite(factor) || factor <= 0) throw new RangeError('외삽 배율은 0보다 큰 유한한 수여야 합니다');
  if (!Number.isFinite(m.rows) || m.rows <= 0) throw new RangeError('측정 입력 행 수는 0보다 큰 유한한 수여야 합니다');
  if (!Number.isFinite(m.targetMs) || m.targetMs <= 0) throw new RangeError('목표 시간은 0보다 큰 유한한 수여야 합니다');
  if (m.measuredMs === null) {
    return {
      id: m.id,
      basis: 'UNMEASURED',
      label: '미측정',
      measuredMs: null,
      extrapolatedMs: null,
      targetMs: m.targetMs,
      ratio: null,
      verdict: 'UNMEASURED',
      assumptions: ASSUMPTIONS,
    };
  }
  if (!Number.isFinite(m.measuredMs) || m.measuredMs < 0) throw new RangeError('측정값은 0 이상의 유한한 수여야 합니다');
  const extrapolatedMs = m.measuredMs * factor;
  const ratio = extrapolatedMs / m.targetMs;
  return {
    id: m.id,
    basis: 'MEASURED_EXTRAPOLATION',
    label: '[추정]',
    measuredMs: m.measuredMs,
    extrapolatedMs,
    targetMs: m.targetMs,
    ratio,
    verdict: ratio <= 1 ? 'PASS_ESTIMATE' : 'FAIL_ESTIMATE',
    assumptions: ASSUMPTIONS,
  };
}

export function capacityEstimates(ms: readonly CapacityMeasurement[], o: { factor?: number } = {}): CapacityEstimate[] {
  return ms.map((m) => extrapolateCapacity(m, o));
}
