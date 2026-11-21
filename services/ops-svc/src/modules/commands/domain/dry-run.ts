// 명령 사전 모의(dry-run)의 꼴·센 값 포트·예측 식·실행 뒤 비교(ADR-0340 결정 2·3, docs/features/control-tower.md §4 '센 값·예측 값·예측 오차 기록').
// 센 값은 유형마다 포트 DryRunSource로 센다. 원천이 없거나 실패하면 unavailable에 적고 접수를 막지 않는다(권한·한계 검사는 따로 한다).
// 예측 식은 명령 1만 낸다. 빈 결과를 '일치'로 적지 않는다: 세지 못한 값은 늘 unavailable에 남는다.
import type { ProtectedRangeHit } from './block-ranges.js';
import { SAFETY_LIMITS, type ApprovalMode, type CommandType } from './command.js';

/** dry-run 기록의 판 */
export const DRY_RUN_VERSION = 1;

/** 유형별로 세는 값(control-tower §4 '센 값'). 원천 어댑터는 BAT-365(OPS-300)가 잇는다 */
export const DRY_RUN_KEYS: Readonly<Partial<Record<CommandType, readonly string[]>>> = Object.freeze({
  // 명령 1: 지금 목표, 예매 단계 인원(slots_used), 곧 입장 대기, 오는 중, 입장 비율, 최근 10분 평균 체류(초), 전진 속도 상한(초당), 지금 serving 증가 속도(초당)
  ADMISSION_TARGET: ['currentTarget', 'slotsUsed', 'soonAdmitted', 'inFlight', 'admitRatio', 'avgDwellSeconds', 'servingRateCap', 'servingRate'],
  // 명령 3: 진행 중 결제 세션, 입장해 있는 구매 세션, 최근 5분 새 홀드·결제 접수 속도(초당), 대기 인원
  KILL_SWITCH: ['paymentSessions', 'purchaseSessions', 'holdsPerSecond5m', 'paymentAcceptsPerSecond5m', 'waiting'],
  // 명령 4: 그 대역의 최근 5분 요청 수·진입 시도 수(원천은 OPS-310에서 정한다)
  BLOCK_ASN_IP: ['requests5m', 'entryAttempts5m'],
});

export interface DryRunCount {
  readonly key: string;
  readonly value: number;
  readonly source: string;
  /** 센 시각(ISO) */
  readonly measuredAt: string;
}

export interface DryRunPrediction {
  readonly key: string;
  readonly value: number;
  readonly formula: string;
  readonly inputs: Readonly<Record<string, number>>;
  readonly assumptions: readonly string[];
}

export interface DryRunUnavailable {
  readonly key: string;
  readonly source: string;
  readonly reason: string;
}

/** 센 값 원천이 돌려주는 것. 센 값과 세지 못한 값을 함께 준다 */
export interface DryRunCountResult {
  readonly counted: readonly DryRunCount[];
  readonly unavailable: readonly DryRunUnavailable[];
}

/** 센 대상 */
export interface DryRunTarget {
  readonly type: CommandType;
  readonly params: Readonly<Record<string, unknown>>;
  readonly eventId?: string;
}

/** 유형별 센 값 포트(ADR-0340 결정 2). 원천 어댑터는 BAT-365가 잇는다. 그 전에는 unavailable 어댑터다 */
export interface DryRunSource {
  count(target: DryRunTarget, keys: readonly string[], nowMs: number): Promise<DryRunCountResult>;
}

/** openapi CommandDryRun(판 1) */
export interface CommandDryRun {
  readonly version: number;
  readonly approvalMode: ApprovalMode;
  readonly reauthRequired: boolean;
  readonly counted: readonly DryRunCount[];
  readonly predicted: readonly DryRunPrediction[];
  readonly unavailable: readonly DryRunUnavailable[];
  readonly limits: Readonly<Record<string, number>>;
  readonly protectedRangeHits?: readonly ProtectedRangeHit[];
  readonly protectedRangesVersion?: string;
}

/** 그 명령에 건 안전 한계 값(ADR-0340 결정 9) */
export function limitsOf(type: CommandType): Record<string, number> {
  switch (type) {
    case 'ADMISSION_TARGET':
      return { admissionTargetMax: SAFETY_LIMITS.admissionTargetMax, admissionTargetMin: SAFETY_LIMITS.admissionTargetMin };
    case 'ADMISSION_PAUSE':
      return { admissionPauseMs: SAFETY_LIMITS.admissionPauseMs };
    case 'BLOCK_ASN_IP':
      return { blockMaxTtlMs: SAFETY_LIMITS.blockMaxTtlMs, blockMaxEntries: SAFETY_LIMITS.blockMaxEntries };
    case 'LOG_LEVEL':
      return { logLevelMs: SAFETY_LIMITS.logLevelMs };
    default:
      return {};
  }
}

const valueOf = (counted: readonly DryRunCount[], key: string): number | undefined => counted.find((c) => c.key === key)?.value;

const PREDICTION_SOURCE = 'prediction';
const EXPONENTIAL_DWELL = '머무는 시간이 지수 분포다(queue-admission §5 감축 확인 시간과 같은 식)';
const STEADY = '정상 상태다(머무는 시간·입장 비율이 지금과 같다)';

/**
 * 명령 1 예측(control-tower §4 '예측 값'). 목표를 T에서 T′로 올리면 처음 채울 빈자리·채우는 시간·정상 상태 입장 속도·serving 증가 속도,
 * 내리면 새 목표에 닿는 시간이다. 넣을 값을 세지 못했거나 0으로 나누게 되면 그 예측은 unavailable이다
 */
export function predictAdmissionTarget(params: Readonly<Record<string, unknown>>, counted: readonly DryRunCount[]): { predicted: DryRunPrediction[]; unavailable: DryRunUnavailable[] } {
  const predicted: DryRunPrediction[] = [];
  const unavailable: DryRunUnavailable[] = [];
  const targetNew = typeof params.target === 'number' ? params.target : undefined;
  const current = valueOf(counted, 'currentTarget');
  const need = (key: string, inputs: readonly string[]): Record<string, number> | undefined => {
    const out: Record<string, number> = {};
    for (const k of inputs) {
      const v = k === 'targetNew' ? targetNew : valueOf(counted, k);
      if (v === undefined || !Number.isFinite(v)) {
        unavailable.push({ key, source: PREDICTION_SOURCE, reason: `input-unavailable:${k}` });
        return undefined;
      }
      out[k] = v;
    }
    return out;
  };
  const divisorZero = (key: string, inputs: Record<string, number>, divisors: readonly string[]): boolean => {
    const zero = divisors.find((d) => inputs[d] === 0);
    if (zero) unavailable.push({ key, source: PREDICTION_SOURCE, reason: `input-zero:${zero}` });
    return zero !== undefined;
  };
  if (targetNew === undefined || current === undefined) {
    unavailable.push({ key: 'direction', source: PREDICTION_SOURCE, reason: `input-unavailable:${targetNew === undefined ? 'targetNew' : 'currentTarget'}` });
    return { predicted, unavailable };
  }
  if (targetNew > current) {
    const v = need('vacancy', ['targetNew', 'slotsUsed', 'soonAdmitted', 'inFlight']);
    let vacancy: number | undefined;
    if (v) {
      vacancy = v.targetNew! - v.slotsUsed! - v.soonAdmitted! - v.inFlight!;
      predicted.push({ key: 'vacancy', value: vacancy, formula: 'targetNew − slotsUsed − soonAdmitted − inFlight', inputs: v, assumptions: [] });
    }
    if (vacancy === undefined) {
      unavailable.push({ key: 'fillSeconds', source: PREDICTION_SOURCE, reason: 'input-unavailable:vacancy' });
    } else {
      const f = need('fillSeconds', ['admitRatio', 'servingRateCap']);
      if (f && !divisorZero('fillSeconds', f, ['admitRatio', 'servingRateCap'])) {
        predicted.push({ key: 'fillSeconds', value: vacancy / f.admitRatio! / f.servingRateCap!, formula: 'vacancy ÷ admitRatio ÷ servingRateCap', inputs: { vacancy, ...f }, assumptions: [] });
      }
    }
    const s = need('steadyAdmissionRate', ['targetNew', 'avgDwellSeconds']);
    let steady: number | undefined;
    if (s && !divisorZero('steadyAdmissionRate', s, ['avgDwellSeconds'])) {
      steady = s.targetNew! / s.avgDwellSeconds!;
      predicted.push({ key: 'steadyAdmissionRate', value: steady, formula: 'targetNew ÷ avgDwellSeconds', inputs: s, assumptions: [STEADY] });
    }
    if (steady === undefined) {
      unavailable.push({ key: 'servingRate', source: PREDICTION_SOURCE, reason: 'input-unavailable:steadyAdmissionRate' });
    } else {
      const r = need('servingRate', ['admitRatio']);
      if (r && !divisorZero('servingRate', r, ['admitRatio'])) {
        predicted.push({ key: 'servingRate', value: steady / r.admitRatio!, formula: 'steadyAdmissionRate ÷ admitRatio', inputs: { steadyAdmissionRate: steady, ...r }, assumptions: [STEADY] });
      }
    }
  } else if (targetNew < current) {
    const v = need('reachSeconds', ['targetNew', 'slotsUsed', 'avgDwellSeconds']);
    if (v && !divisorZero('reachSeconds', v, ['targetNew'])) {
      // 이미 새 목표 아래면 닿는 시간은 0이다(ln ≤ 0)
      const ratio = v.slotsUsed! / v.targetNew!;
      const value = ratio <= 1 ? 0 : v.avgDwellSeconds! * Math.log(ratio);
      predicted.push({ key: 'reachSeconds', value, formula: 'avgDwellSeconds × ln(slotsUsed ÷ targetNew)', inputs: v, assumptions: [EXPONENTIAL_DWELL] });
    }
  }
  return { predicted, unavailable };
}

/** 예측 식이 있는 유형 */
export const PREDICTING_TYPES: readonly CommandType[] = ['ADMISSION_TARGET'];

export function predictionsOf(type: CommandType, params: Readonly<Record<string, unknown>>, counted: readonly DryRunCount[]): { predicted: DryRunPrediction[]; unavailable: DryRunUnavailable[] } {
  if (type === 'ADMISSION_TARGET') return predictAdmissionTarget(params, counted);
  return { predicted: [], unavailable: [] };
}

/** 실행 뒤 비교의 한 쌍 */
export interface DryRunComparisonPair {
  readonly key: string;
  readonly predicted: number;
  readonly actual: number;
  readonly diff: number;
}

/** DRY_RUN_COMPARED 사건에 남기는 값(ADR-0340 결정 3) */
export interface DryRunComparison {
  readonly version: number;
  readonly measuredAt: string;
  readonly pairs: readonly DryRunComparisonPair[];
  readonly actual: readonly DryRunCount[];
  readonly unavailable: readonly DryRunUnavailable[];
}

/** 실제 값으로 바꿔 견줄 수 있는 예측(빈자리·serving 증가 속도, control-tower §4 '예측 오차 기록'). 예매 단계 인원은 actual에 그대로 남는다 */
function actualOf(key: string, params: Readonly<Record<string, unknown>>, actual: readonly DryRunCount[]): number | undefined {
  if (key === 'servingRate') return valueOf(actual, 'servingRate');
  if (key === 'vacancy') {
    const target = typeof params.target === 'number' ? params.target : undefined;
    const s = valueOf(actual, 'slotsUsed');
    const q = valueOf(actual, 'soonAdmitted');
    const f = valueOf(actual, 'inFlight');
    return target === undefined || s === undefined || q === undefined || f === undefined ? undefined : target - s - q - f;
  }
  return undefined;
}

/**
 * 예측과 실제를 견준다. 실제 값을 세지 못한 예측은 unavailable에 남긴다(빈 결과를 '일치'로 적지 않는다).
 * 시간 예측(fillSeconds·reachSeconds·steadyAdmissionRate)은 5분 뒤 한 번 센 값으로 바꿀 수 없어 비교 대상 밖이고 unavailable(not-comparable)로 남긴다
 */
export function compareDryRun(predicted: readonly DryRunPrediction[], params: Readonly<Record<string, unknown>>, actual: DryRunCountResult, nowMs: number): DryRunComparison {
  const pairs: DryRunComparisonPair[] = [];
  const unavailable: DryRunUnavailable[] = [...actual.unavailable];
  for (const p of predicted) {
    if (p.key !== 'vacancy' && p.key !== 'servingRate') {
      unavailable.push({ key: p.key, source: PREDICTION_SOURCE, reason: 'not-comparable' });
      continue;
    }
    const a = actualOf(p.key, params, actual.counted);
    if (a === undefined) {
      unavailable.push({ key: p.key, source: PREDICTION_SOURCE, reason: 'actual-unavailable' });
      continue;
    }
    pairs.push({ key: p.key, predicted: p.value, actual: a, diff: a - p.value });
  }
  // 예매 단계 인원 등 실제 값 자체는 actual에 그대로 남긴다
  return { version: DRY_RUN_VERSION, measuredAt: new Date(nowMs).toISOString(), pairs, actual: actual.counted, unavailable };
}
