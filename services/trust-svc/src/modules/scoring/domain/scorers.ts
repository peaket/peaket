// 점수기 여섯(docs/features/bot-defense.md §4.2). 저장소를 부르지 않는 순수 함수이고 ①이 모은 값만 받는다(단위 시험과 그림자 판이 같은 입력을 다시 쓴다).
// 기준값은 비공개 설정의 매개변수(ScorerParams)이고 코드에 숫자를 두지 않는다(POL-006). 값 없음은 risk null이다.
import type { ScorerParams } from './rules.js';
import type { BehaviorSummary, ClientSignals, DeviceHistory, HumanCheckResult, NetClass, ReasonCategory, ScorerName } from './types.js';

/** 값 없음의 까닭: dependency는 의존성 장애(degraded에 넣는다), absent는 원래 없는 값 */
export type MissingCause = 'dependency' | 'absent';

export interface ScorerOutcome {
  name: ScorerName;
  /** 0~1. null은 값 없음(가중합에 0으로 더한다) */
  risk: number | null;
  /** 이 점수기가 가장 크게 기여했을 때의 사유 범주 */
  reason: ReasonCategory;
  missing?: MissingCause;
}

export type DeviceSignals =
  /** 읽은 칸만 쓴다. 칸이 undefined면 그 키를 읽지 못했다(§18). 둘 다 없으면 FAILED로 온다 */
  | { state: 'READ'; accounts: number | undefined; shared: number | undefined; history: DeviceHistory | undefined }
  /** 기기 식별값이 없다 */
  | { state: 'NONE' }
  /** 저장소 오류, 또는 라벨 키가 없어 기기 가명을 만들지 못했다 */
  | { state: 'FAILED' };

export interface ScorerInput {
  now: number;
  human: HumanCheckResult;
  device: DeviceSignals;
  behavior: BehaviorSummary | undefined;
  network: { netClass: NetClass; entries10s: number | undefined };
  firstVisitAtMs: number | undefined;
  sessionCreatedAtMs: number | undefined;
  client: ClientSignals;
}

export interface Scorer {
  name: ScorerName;
  score(input: ScorerInput, params: ScorerParams): ScorerOutcome;
}

/** x가 from 이하면 0, at 이상이면 1, 사이는 직선 */
const ramp = (x: number, from: number, at: number): number => (x <= from ? 0 : x >= at ? 1 : (x - from) / (at - from));
/** x가 low 이하면 1, high 이상이면 0(작을수록 위험한 값) */
const rampDown = (x: number, low: number, high: number): number => 1 - ramp(x, low, high);

const none = (name: ScorerName, reason: ReasonCategory, missing: MissingCause): ScorerOutcome => ({ name, risk: null, reason, missing });

const humanCheck: Scorer = {
  name: 'HumanCheck',
  score: (i) => {
    if (i.human === 'PENDING') return none('HumanCheck', 'HUMAN_CHECK', 'dependency');
    if (i.human === 'ABSENT') return none('HumanCheck', 'HUMAN_CHECK', 'absent');
    return { name: 'HumanCheck', risk: i.human === 'FAILED' ? 1 : 0, reason: 'HUMAN_CHECK' };
  },
};

const deviceTrust: Scorer = {
  name: 'DeviceTrust',
  score: (i, p) => {
    if (i.device.state === 'NONE') return none('DeviceTrust', 'DEVICE_HISTORY', 'absent');
    if (i.device.state === 'FAILED') return none('DeviceTrust', 'DEVICE_HISTORY', 'dependency');
    const { accounts, shared, history } = i.device;
    const d = p.device;
    const risk = Math.max(accounts === undefined ? 0 : ramp(accounts, d.accountsFrom, d.accountsAt), shared === undefined ? 0 : ramp(shared, d.sharedFrom, d.sharedAt), history === undefined ? 0 : ramp(history.failed, d.failuresFrom, d.failuresAt));
    return { name: 'DeviceTrust', risk, reason: 'DEVICE_HISTORY' };
  },
};

const behaviorScore: Scorer = {
  name: 'BehaviorScore',
  score: (i, p) => {
    const b = i.behavior;
    // 표본이 적으면 값을 쓰지 않는다(몇 번 움직이지 않은 요약으로 사람을 봇으로 잡지 않게, 최소 표본 수는 비공개 설정)
    const hasPointer = b !== undefined && (b.pointerMoves ?? 0) >= p.behavior.minPointerMoves && b.pointerEntropy !== undefined;
    const hasInput = b !== undefined && b.windowMs >= p.behavior.minWindowMs && (b.inputIntervalMeanMs ?? 0) > 0 && b.inputIntervalStdMs !== undefined;
    if (!hasPointer && !hasInput) return none('BehaviorScore', 'INTERACTION', 'absent');
    const risks: number[] = [];
    if (hasPointer) risks.push(rampDown(b.pointerEntropy!, p.behavior.entropyLow, p.behavior.entropyHigh));
    if (hasInput) risks.push(rampDown(b.inputIntervalStdMs!, p.behavior.intervalStdLow, p.behavior.intervalStdHigh));
    return { name: 'BehaviorScore', risk: Math.max(...risks), reason: 'INTERACTION' };
  },
};

const networkScore: Scorer = {
  name: 'NetworkScore',
  score: (i, p) => {
    // ASN을 모르면(0: 헤더 없음) 네트워크 신호가 없는 것이다(§4.2). 분류표에 없는 ASN은 '그 밖'이라 위험 0이다
    if (i.client.asn === 0 && i.network.entries10s === undefined) return none('NetworkScore', 'NETWORK', 'absent');
    const n = p.network;
    const classRisk = i.network.netClass === 'HOSTING' ? n.hosting : i.network.netClass === 'PROXY' ? n.proxy : 0;
    const entries = i.network.entries10s;
    const rateRisk = entries === undefined ? 0 : ramp(entries, n.entriesFrom, n.entriesAt);
    return { name: 'NetworkScore', risk: Math.max(classRisk, rateRisk), reason: rateRisk > classRisk ? 'RAPID_REQUESTS' : 'NETWORK' };
  },
};

const ageScore: Scorer = {
  name: 'AgeScore',
  score: (i, p) => {
    const risks: number[] = [];
    if (i.firstVisitAtMs !== undefined) risks.push(rampDown(i.now - i.firstVisitAtMs, p.age.cookieYoungMs, p.age.cookieOldMs));
    if (i.sessionCreatedAtMs !== undefined) risks.push(rampDown(i.now - i.sessionCreatedAtMs, p.age.sessionYoungMs, p.age.sessionOldMs));
    if (risks.length === 0) return none('AgeScore', 'DEVICE_HISTORY', 'absent');
    return { name: 'AgeScore', risk: Math.max(...risks), reason: 'DEVICE_HISTORY' };
  },
};

const PLATFORMS: readonly (readonly [RegExp, string])[] = [
  [/Android/i, 'Android'],
  [/iPhone|iPad|iPod/i, 'iOS'],
  [/Windows NT/i, 'Windows'],
  [/Macintosh|Mac OS X/i, 'macOS'],
  [/CrOS/i, 'Chrome OS'],
  [/Linux/i, 'Linux'],
];
const unquote = (v: string | undefined): string | undefined => v?.replaceAll('"', '').trim();

const consistencyScore: Scorer = {
  name: 'ConsistencyScore',
  score: (i, p) => {
    const hints = i.client.clientHints;
    const platform = unquote(hints['sec-ch-ua-platform']);
    const mobile = unquote(hints['sec-ch-ua-mobile']);
    if (!i.client.userAgent || (platform === undefined && mobile === undefined)) return none('ConsistencyScore', 'INTERACTION', 'absent');
    const uaPlatform = PLATFORMS.find(([re]) => re.test(i.client.userAgent))?.[1];
    const platformMismatch = platform !== undefined && platform !== '' && uaPlatform !== undefined && platform !== 'Unknown' && platform !== uaPlatform;
    const uaMobile = /Mobi/i.test(i.client.userAgent);
    const mobileMismatch = (mobile === '?1' && !uaMobile) || (mobile === '?0' && uaMobile);
    return { name: 'ConsistencyScore', risk: platformMismatch || mobileMismatch ? p.consistency.mismatch : 0, reason: 'INTERACTION' };
  },
};

export const SCORER_LIST: readonly Scorer[] = [humanCheck, deviceTrust, behaviorScore, networkScore, ageScore, consistencyScore];
