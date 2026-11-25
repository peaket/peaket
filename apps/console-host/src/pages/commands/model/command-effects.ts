// 명령 4·5 효과 줄(F-03-7).
// 정본: docs/features/control-tower.md §3 '명령 4·5 효과 줄' — ack 뒤 10분 [가정] 동안 차단 비율·추가 검증 통과율·이의 제기 수를
// 실행 전 5분 값과 나란히 보이고, 통과율 10%p [가정] 하락 또는 이의 5건 [가정]이면 SEV2다. 값이 없으면 0으로 그리지 않는다.

/** 효과 줄을 보이는 시간(정본 10분 [가정]) */
export const EFFECT_WINDOW_MS = 10 * 60_000;
/** 추가 검증 통과율 하락 경고(10%p [가정]) */
export const PASS_RATE_DROP = 0.1;
/** 이의 제기 경고(5건 [가정]) */
export const OBJECTIONS_WARN = 5;

export interface EffectMeasurement {
  blockedRatio?: number;
  passRate?: number;
  objections?: number;
}

export interface EffectRow {
  visible: boolean;
  kind: 'measured' | 'source-unavailable';
  blockedRatio: { before: number; after: number } | null;
  passRate: { before: number; after: number } | null;
  objections: { before: number; after: number } | null;
  warn: boolean;
  warnReason?: 'passed-rate-drop' | 'objections';
}

/** 명령 4·5의 결과 효과 줄. 그 밖의 명령 또는 ack 전이면 null */
export function effectRowOf(o: {
  type: string;
  ackedAt?: string | null;
  nowMs: number;
  before?: EffectMeasurement;
  after?: EffectMeasurement;
}): EffectRow | null {
  if (o.type !== 'BLOCK_ASN_IP' && o.type !== 'BOT_LEVEL') return null;
  const acked = o.ackedAt ? Date.parse(o.ackedAt) : Number.NaN;
  if (!Number.isFinite(acked)) return null;
  const visible = o.nowMs - acked >= 0 && o.nowMs - acked <= EFFECT_WINDOW_MS;
  const before = o.before;
  const after = o.after;
  const has = (m?: EffectMeasurement): m is Required<EffectMeasurement> =>
    !!m && typeof m.blockedRatio === 'number' && typeof m.passRate === 'number' && typeof m.objections === 'number';
  if (!has(before) || !has(after)) {
    return { visible, kind: 'source-unavailable', blockedRatio: null, passRate: null, objections: null, warn: false };
  }
  const passDrop = after.passRate <= before.passRate - PASS_RATE_DROP;
  const objections = after.objections >= OBJECTIONS_WARN;
  return {
    visible,
    kind: 'measured',
    blockedRatio: { before: before.blockedRatio, after: after.blockedRatio },
    passRate: { before: before.passRate, after: after.passRate },
    objections: { before: before.objections, after: after.objections },
    warn: passDrop || objections,
    ...(passDrop ? { warnReason: 'passed-rate-drop' as const } : objections ? { warnReason: 'objections' as const } : {}),
  };
}
