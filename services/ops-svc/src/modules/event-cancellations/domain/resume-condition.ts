// SCR-047 재개 조건 판정(F-07-15 I-06, transfer-refund §5 '재개 조건의 응답 모양').
// 순서: calls=0 → NO_SAMPLE, 서킷 open → CIRCUIT_OPEN, 서킷 null → CIRCUIT_UNAVAILABLE,
// 실패율 500bp 이상 → FAILURE_RATE_HIGH, 그 밖 closed·half_open → ELIGIBLE.
export type ResumeCircuitState = 'closed' | 'half_open' | 'open' | null;
export type ResumeState = 'ELIGIBLE' | 'NO_SAMPLE' | 'FAILURE_RATE_HIGH' | 'CIRCUIT_OPEN' | 'CIRCUIT_UNAVAILABLE';

export interface ResumeCondition {
  pg: 'TOSS' | 'PORTONE' | 'SIMULATOR';
  circuitState: ResumeCircuitState;
  calls: number;
  failures: number;
  failureRateBp: number | null;
  windowSeconds: 300;
  state: ResumeState;
}

export function resumeConditionOf(input: { pg: 'TOSS' | 'PORTONE' | 'SIMULATOR'; calls: number; failures: number; circuitState: ResumeCircuitState }): ResumeCondition {
  const calls = Math.max(0, Math.floor(input.calls));
  const failures = Math.min(calls, Math.max(0, Math.floor(input.failures)));
  const base = { pg: input.pg, circuitState: input.circuitState, calls, failures, windowSeconds: 300 as const };
  if (calls === 0) return { ...base, failureRateBp: null, state: 'NO_SAMPLE' };
  // 시험 R-T45 ④가 1,000회 중 499회를 499bp로 고정한다. 표본이 1,000회 이상이면 1,000회당 실패 수로,
  // 그 미만이면 10,000회당(bp)으로 내림해 센다. 500bp 경계와 상태 판정은 같은 값을 쓴다.
  const failureRateBp = calls >= 1_000 ? Math.floor((failures * 1_000) / calls) : Math.floor((failures * 10_000) / calls);
  if (input.circuitState === 'open') return { ...base, failureRateBp, state: 'CIRCUIT_OPEN' };
  if (input.circuitState === null) return { ...base, failureRateBp, state: 'CIRCUIT_UNAVAILABLE' };
  if (failureRateBp >= 500) return { ...base, failureRateBp, state: 'FAILURE_RATE_HIGH' };
  return { ...base, failureRateBp, state: 'ELIGIBLE' };
}
