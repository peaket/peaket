// 위험 판정의 포트: 사람 확인, 판정 피처 저장소, 기기 가명, ASN 분류표, 규칙, 판정 기록, 행동 신호, 운영 신호.
import type { RuleSet } from './rules.js';
import type { MissingCause } from './scorers.js';
import type { BehaviorSummary, DeviceHistory, HardSignal, HumanAction, HumanCheckResult, Intensity, NetClass, ReasonCategory, ScoreContext, ScorerName, Verdict } from './types.js';

export interface HumanCheckRequest {
  token: string;
  action: HumanAction;
  remoteIp: string;
  deadlineAtMs: number;
}

/** 사람 확인 서버 검증(§6). 받는 결과는 PASSED·FAILED·PENDING이다 */
export interface HumanCheckPort {
  verify(req: HumanCheckRequest): Promise<HumanCheckResult>;
}

/** 판정 피처 하나의 이름(읽기 실패를 칸마다 구분한다, §18) */
export const FEATURE_NAMES = ['block', 'honeypot', 'accounts', 'history', 'shared', 'entries'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

/** 읽은 값. 칸이 undefined면 그 키를 읽지 못했거나 묻지 않은 것이다(값 없음, §4.4) */
export interface FeatureRead {
  blocked: boolean | undefined;
  honeypot: boolean | undefined;
  /** 지난 30일 그 기기에서 판정받은 사람 수(이번 요청의 pid를 넣어 센 값) */
  accounts: number | undefined;
  history: DeviceHistory | undefined;
  /** 회차별 기기 공유 수(이번 요청의 pid를 넣어 센 값). 세지 않았거나 실패하면 undefined */
  shared: number | undefined;
  /** 호스팅·프록시 대역의 이번 10초 칸 진입 수(이번 요청을 넣어 센 값). 세지 않았거나 실패하면 undefined */
  hostEntries: number | undefined;
  /** 읽기가 실패한 피처 */
  failed: readonly FeatureName[];
}

/** 판정 근거 키의 값(tr:vb, §3.2) */
export interface VerdictEvidence {
  eventKey: string;
  deviceRef: string | undefined;
  hardSignal: HardSignal;
  reason: ReasonCategory;
  profileVersion: number;
  decidedAtMs: number;
}

/** 판정 피처 저장소(세션·캐시 Redis). 실패는 던진다(호출 쪽이 값 없음으로 둔다) */
export interface FeatureStore {
  /** shareEventId를 주면 그 회차의 기기 공유 수(tr:devshare)에 pid를 넣고 센다. hostEntry를 주면 대역 진입 수(tr:asnhost)를 올리고 센다 */
  read(i: { deviceRef: string | undefined; pid: string; now: number; hostEntry?: { asn: number; eventId: string } | undefined; shareEventId?: string | undefined }): Promise<FeatureRead>;
  /** 사람 확인을 통과한 판정의 계정을 기기 집합에 넣는다. pid마다 하루 새 기기 수에 상한이 있다(기기 이력 오염을 막는다) */
  addAccount(i: { deviceRef: string; pid: string; now: number; newDevicesPerDay: number }): Promise<void>;
  /** 추가 검증으로 보낸 판정: 기기의 보냄 수와 판정 근거 키(첫 판정의 근거를 덮지 않는다) */
  recordChallenge(i: { deviceRef: string | undefined; pid: string; eventId: string; evidence: VerdictEvidence; now: number }): Promise<void>;
  /** 추가 검증 제출의 결과: 기기의 통과·실패 수 */
  recordVerification(i: { deviceRef: string; passed: boolean; now: number }): Promise<void>;
  /** 허니팟 적중 표시(tr:hp, 24시간 [가정], §7). 값은 적중 시각과 회차다. 이 (pid, 회차)에서 24시간 안의 첫 적중이고 pid당 회차 수 상한 안이면 true(회차를 모르면 false). 표시는 상한과 상관없이 쓴다 */
  recordHoneypot(i: { pid: string; eventId: string; now: number }): Promise<boolean>;
}

/** 기기 가명(invRef("device", deviceId)). 라벨 키를 받지 못하면 undefined. 요청 처리 중에 KMS를 부르지 않는다 */
export interface DeviceRefs {
  ref(deviceId: string): string | undefined;
}

export interface AsnClassifier {
  classify(asn: number): NetClass;
}

export interface RuleSource {
  /** 한 번도 읽지 못했으면 null */
  current(): RuleSet | null;
  intensity(): Intensity;
}

/** 판정 기록(§4.1 ⑤). 점수 원값·가중치·기준값은 어디에도 싣지 않는다 */
export interface VerdictRecord {
  eventKey: string;
  context: ScoreContext;
  verdict: Verdict;
  reason?: ReasonCategory;
  degraded: boolean;
  hardSignal: HardSignal;
  humanCheck: HumanCheckResult;
  missingScorers: ScorerName[];
  profileVersion: number;
  eventId: string;
  pid: string;
  journeyId: string;
  deviceRef?: string;
  refMissing: boolean;
  decidedAtMs: number;
  durationMs: number;
}

/** 판정 기록을 내보낸다. 실패해도 판정은 그대로다(§18). 던지지 않는다 */
export interface VerdictRecorder {
  record(r: VerdictRecord): void;
}

/** 행동 신호 한 건(§4.1 ⑤). screen은 로비 입장 LOBBY, 사전 검증 EVENT_DETAIL이다 */
export interface BehaviorRecord {
  eventKey: string;
  eventId: string;
  pid: string;
  journeyId: string;
  screen: 'LOBBY' | 'EVENT_DETAIL';
  deviceRef?: string;
  refMissing: boolean;
  netClass: NetClass;
  /** ASN. netClass가 HOSTING·PROXY일 때만 내보낸다 */
  asn: number;
  /** 로비 입장에는 없다 */
  features?: BehaviorSummary;
  tsMs: number;
}

/** 행동 신호를 내보낸다. 던지지 않는다 */
export interface BehaviorRecorder {
  behavior(r: BehaviorRecord): void;
}

/** 허니팟 적중의 판정 기록(§7). 사람 식별값은 싣지 않는다 */
export interface HoneypotRecord {
  eventKey: string;
  eventId: string;
  occurredAtMs: number;
}

/** 허니팟 적중의 판정 기록을 내보낸다. 던지지 않는다 */
export interface HoneypotRecorder {
  honeypot(r: HoneypotRecord): void;
}

/** 운영 신호(§15·§16) */
export interface TrustSignals {
  verdict(context: ScoreContext, verdict: Verdict): void;
  humanCheck(result: HumanCheckResult): void;
  scorerMissing(scorer: ScorerName, cause: MissingCause): void;
  hardSignal(signal: Exclude<HardSignal, 'NONE'>): void;
  /** 피처 키 읽기가 실패했다(그 피처는 값 없음이다) */
  featureFailed(feature: FeatureName): void;
  /** 응답 뒤로 미룬 쓰기가 실패했다 */
  afterFailed(work: 'challenge' | 'verification' | 'account' | 'honeypot'): void;
  /** 허니팟 적중 하나(§7). 기록 조건을 만족한 요청만 부른다 */
  honeypotHit(signedIn: boolean): void;
  /** 기기 라벨 키를 받지 못해 가명을 계산하지 못했다 */
  invRefMissing(label: string, reason: 'THROTTLED' | 'KMS_ERROR' | 'NO_KEY'): void;
}
