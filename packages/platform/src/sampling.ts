// 정상 표본 문턱(ADR-0125 결정 3, docs/observability.md §6·§7, openspec 변경 add-service-logging 결정 3).
// OTel 확률 표본 규약의 문턱 방식: R = trace ID 끝 56비트, R ≥ (1 − p) × 2^56이면 남긴다.
// 비율은 'N건에 1건'(p = 1/N)인 정수로 받아 정수로만 계산한다: R ≥ 2^56 − ⌊2^56 / N⌋.
const TWO56 = 2n ** 56n;
const TRACE_ID = /^[0-9a-f]{32}$/;

export function sampleThreshold(oneIn: number): bigint {
  if (!Number.isInteger(oneIn) || oneIn < 1) throw new RangeError(`표본 비율 N은 1 이상의 정수여야 한다: ${oneIn}`);
  return TWO56 - TWO56 / BigInt(oneIn);
}

/** 이 trace를 정상 표본으로 남기는가. 같은 trace ID와 N이면 서비스·로그·추적이 모두 같은 답을 낸다 */
export function sampleKeep(traceId: string, oneIn: number): boolean {
  const t = sampleThreshold(oneIn);
  if (!TRACE_ID.test(traceId)) throw new TypeError(`trace ID는 32자리 소문자 16진수여야 한다: ${traceId}`);
  return BigInt(`0x${traceId.slice(18)}`) >= t;
}
