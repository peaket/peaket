// 시험 도구: 합성 규칙(POL-006: 실제 기준값·가중치는 저장소에 두지 않는다. 아래 값은 시험만을 위한 임의 값이다), 사람 확인 대역, 호출 기록.
import { fakeClock, type FakeClock } from '@peaket/platform';
import { MemoryFeatureStore } from '../src/modules/scoring/adapters/memory-feature-store.js';
import { ScoreRisk } from '../src/modules/scoring/application/score-risk.js';
import type { HumanCheckPort, HumanCheckRequest, TrustSignals, VerdictRecord, VerdictRecorder } from '../src/modules/scoring/domain/ports.js';
import { parseRuleSet, type RuleSet } from '../src/modules/scoring/domain/rules.js';
import type { Scorer } from '../src/modules/scoring/domain/scorers.js';
import type { HumanCheckResult, NetClass, ScoreRequest } from '../src/modules/scoring/domain/types.js';

const profile = (threshold: number, weight = 1) => ({
  threshold,
  weights: { HumanCheck: weight, DeviceTrust: weight, BehaviorScore: weight, NetworkScore: weight, AgeScore: weight, ConsistencyScore: weight },
});

const shuffles = (threshold: number) => ({ ON: profile(threshold), OFF: profile(threshold), NONE: profile(threshold) });

/** 합성 규칙: 점수기 하나가 위험 1이면 기준에 닿는다(판단 흐름만 본다) */
export const SYNTHETIC_RULES_JSON = JSON.stringify({
  version: 7,
  intensities: { RELAXED: shuffles(2), BASE: shuffles(1), STRICT: shuffles(0.5) },
  params: {
    device: { accountsFrom: 1, accountsAt: 3, sharedFrom: 1, sharedAt: 3, failuresFrom: 0, failuresAt: 2, newDevicesPerDay: 2 },
    behavior: { entropyLow: 0.1, entropyHigh: 1, intervalStdLow: 10, intervalStdHigh: 100, minPointerMoves: 5, minWindowMs: 1_000 },
    network: { hosting: 1, proxy: 0.8, entriesFrom: 1, entriesAt: 3 },
    age: { cookieYoungMs: 1_000, cookieOldMs: 2_000, sessionYoungMs: 1_000, sessionOldMs: 2_000 },
    consistency: { mismatch: 1 },
  },
});
export const SYNTHETIC_RULES: RuleSet = parseRuleSet(SYNTHETIC_RULES_JSON);

/** 정본의 deviceId 형식(CSPRNG 128비트, base64url 22자, docs/frontend.md §3.12) */
export const DEVICE_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
/** 형식에 맞는 다른 기기 식별값 */
export const deviceId = (n: number) => `AQEBAQEBAQEBAQEBAQEB${String(n).padStart(2, '0')}`;
export const DEVICE_REF = 'k1.ref-of-device';
export const PID = 'pid-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const EVENT = 'ev-1';
export const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000001';
export const JOURNEY = '0190f3a1-7c2e-7a00-8000-0000000000aa';
export const HUMAN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';

export function recordingHuman(result: HumanCheckResult = 'PASSED'): HumanCheckPort & { calls: HumanCheckRequest[]; set(r: HumanCheckResult): void } {
  let current = result;
  const calls: HumanCheckRequest[] = [];
  return {
    calls,
    set: (r) => {
      current = r;
    },
    verify: async (req) => {
      calls.push(req);
      return current;
    },
  };
}

export function recordingSignals(): TrustSignals & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    verdict: (c, v) => seen.push(`verdict:${c}:${v}`),
    humanCheck: (r) => seen.push(`human:${r}`),
    scorerMissing: (s, cause) => seen.push(`missing:${s}:${cause}`),
    hardSignal: (h) => seen.push(`hard:${h}`),
    featureFailed: (f) => seen.push(`feature:${f}`),
    afterFailed: (w) => seen.push(`after:${w}`),
  };
}

export function recordingRecorder(): VerdictRecorder & { records: VerdictRecord[] } {
  const records: VerdictRecord[] = [];
  return { records, record: (r) => void records.push(r) };
}

export interface World {
  clock: FakeClock;
  human: ReturnType<typeof recordingHuman>;
  features: MemoryFeatureStore;
  signals: ReturnType<typeof recordingSignals>;
  recorder: ReturnType<typeof recordingRecorder>;
  score: ScoreRisk;
  /** 응답 뒤로 미룬 일을 끝까지 기다린다 */
  flush(): Promise<void>;
}

export function world(o: { scorers?: readonly Scorer[]; rules?: RuleSet | null; deviceRef?: () => string | undefined; netClass?: (asn: number) => NetClass } = {}): World {
  const clock = fakeClock({ now: Date.UTC(2026, 10, 9, 1, 0, 0) });
  const human = recordingHuman();
  const features = new MemoryFeatureStore();
  const signals = recordingSignals();
  const recorder = recordingRecorder();
  const pending: Promise<unknown>[] = [];
  const score = new ScoreRisk({
    rules: { current: () => (o.rules === null ? null : (o.rules ?? SYNTHETIC_RULES)), intensity: () => 'BASE' },
    human,
    features,
    devices: { ref: (id) => (o.deviceRef ? o.deviceRef() : id === DEVICE_ID ? DEVICE_REF : `k1.ref-of-${id}`) },
    asn: { classify: (asn) => (o.netClass ? o.netClass(asn) : 'OTHER') },
    recorder,
    signals,
    clock,
    after: (w) => void pending.push(w()),
    ...(o.scorers ? { scorers: o.scorers } : {}),
  });
  return {
    clock,
    human,
    features,
    signals,
    recorder,
    score,
    flush: async () => {
      await Promise.all(pending.splice(0));
    },
  };
}

export function request(o: Partial<ScoreRequest> = {}): ScoreRequest {
  return {
    context: 'PREVERIFY',
    eventId: EVENT,
    pid: PID,
    accountId: ACCOUNT,
    humanCheckToken: 'turnstile-token-1',
    deviceId: DEVICE_ID,
    client: { ip: '198.51.100.7', userAgent: HUMAN_UA, clientHints: { 'sec-ch-ua-platform': '"Windows"', 'sec-ch-ua-mobile': '?0' }, asn: 64512 },
    shuffle: 'OFF',
    journeyId: JOURNEY,
    deadlineAtMs: Date.UTC(2026, 10, 9, 1, 0, 1),
    behavior: { v: 1, windowMs: 30_000, pointerMoves: 100, pointerEntropy: 3, inputIntervalMeanMs: 200, inputIntervalStdMs: 300, scrollEvents: 3, scrollDistancePx: 900 },
    ...o,
  };
}
