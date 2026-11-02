// 승인 지연 분포(docs/features/payment.md §2.1 'PG 시뮬레이터의 기본 승인 지연', 추천 적용 2026-10-28, 기술 검토 낮음-120).
// 시험이 따로 지연을 넣지 않으면 로그정규 분포(오른쪽 꼬리가 긴 분포)로 늦춘다. 중앙값 300ms, p99 1.5초 [가정]이고 근거는 없다.
export type LatencySpec = { kind: 'lognormal'; medianMs: number; p99Ms: number } | { kind: 'fixed'; ms: number } | { kind: 'none' };

export const DEFAULT_CONFIRM_LATENCY: LatencySpec = { kind: 'lognormal', medianMs: 300, p99Ms: 1500 };

/** 표준정규분포의 99번째 백분위 z값 */
const Z99 = 2.3263478740408408;

/** 시드를 고정한 난수(mulberry32). [0, 1) */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 지연(ms, 0 이상 정수)을 하나씩 뽑는 함수 */
export function latencySampler(spec: LatencySpec, random: () => number): () => number {
  switch (spec.kind) {
    case 'none':
      return () => 0;
    case 'fixed': {
      if (!(Number.isInteger(spec.ms) && spec.ms >= 0)) throw new RangeError(`고정 지연은 0 이상 정수(ms)여야 한다: ${spec.ms}`);
      return () => spec.ms;
    }
    case 'lognormal': {
      if (!(spec.medianMs > 0)) throw new RangeError(`중앙값은 0보다 커야 한다: ${spec.medianMs}`);
      if (!(spec.p99Ms > spec.medianMs)) throw new RangeError(`p99는 중앙값보다 커야 한다: ${spec.p99Ms}`);
      const mu = Math.log(spec.medianMs);
      const sigma = Math.log(spec.p99Ms / spec.medianMs) / Z99;
      return () => {
        // Box–Muller. 1 − u로 log(0)을 피한다
        const u1 = 1 - random();
        const u2 = random();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return Math.max(0, Math.round(Math.exp(mu + sigma * z)));
      };
    }
  }
}

export function parseLatencySpec(v: unknown): LatencySpec {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  let spec: LatencySpec;
  if (o.kind === 'none') spec = { kind: 'none' };
  else if (o.kind === 'fixed') spec = { kind: 'fixed', ms: Number(o.ms) };
  else if (o.kind === 'lognormal') spec = { kind: 'lognormal', medianMs: Number(o.medianMs), p99Ms: Number(o.p99Ms) };
  else throw new RangeError(`지연 종류는 none·fixed·lognormal 가운데 하나다: ${String(o.kind)}`);
  latencySampler(spec, () => 0.5); // 값 검사
  return spec;
}
