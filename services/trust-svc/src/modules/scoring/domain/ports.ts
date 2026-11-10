// 위험 판정의 포트: 사람 확인, 판정 피처 저장소, 기기 가명, ASN 분류표, 규칙, 판정 기록, 행동 신호, 운영 신호.
import type { BlockListChange, BlockOp, Label, LabelEvidence, LabelSource, ReviewBatch, AppliedVerdict } from './labels.js';
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
  /**
   * 기기 라벨 키 회전의 이음(§4.10): 옛 판 값(from)의 키마다 새 판 값(to)의 키가 없으면 남은 수명 그대로 옮기고 옛 판 키를 지운다.
   * 무엇이든 옮겼으면 옛 판 값 → 새 판 값의 이어 달기를 until까지 둔다. 키마다 결과를 따로 주고 던지지 않는다
   */
  migrate(i: { from: string; to: string; eventId: string; until: number; now: number }): Promise<MigrationResult>;
}

/** 이음에서 옮기는 키(tr:devacct·tr:devhist·tr:block·tr:devshare 그 회차·차단 키의 판 가드 tr:blkv) */
export const MIGRATION_FEATURES = ['accounts', 'history', 'block', 'shared', 'block_version'] as const;
export type MigrationFeature = (typeof MIGRATION_FEATURES)[number];
/** moved 옮김, none 옛 판 키가 없음, skipped 새 판 키가 이미 있어 건너뜀(BUSYKEY), failed 옮기지 못함 */
export type MigrationOutcome = 'moved' | 'none' | 'skipped' | 'failed';
export type MigrationResult = Record<MigrationFeature, MigrationOutcome>;

/** 기기 가명(invRef("device", deviceId)). 라벨 키를 받지 못하면 undefined. 요청 처리 중에 KMS를 부르지 않는다 */
export interface DeviceRefs {
  ref(deviceId: string): string | undefined;
  /**
   * 키 회전의 이음 기간에만: 옛 판 값과 이음 끝(§4.10). 옛 판이 없거나, 이음 끝이 지났거나, 옛 판 라벨 키를 받지 못했으면 undefined.
   * 없으면 이음이 없는 공급자다
   */
  prev?(deviceId: string): { ref: string; until: number } | undefined;
  /** 판정이 읽는 기기 가명의 키 판: 지금 판과 이음 중인 옛 판(라벨 반영이 다른 판의 기기 가명을 쓰지 않게, §9 '기기 가명 찾기') */
  versions?(): readonly number[];
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
  /** 그림자 판(§10.4)이 돈 판정이면 그 판정. 정규 로그 줄에는 적용 판정과 함께, 판정 기록으로는 따로(shadow true) 낸다 */
  shadow?: ShadowVerdict;
}

/** 그림자 판의 판정. 적용하지 않고 기록만 한다 */
export interface ShadowVerdict {
  eventKey: string;
  verdict: Verdict;
  reason?: ReasonCategory;
  /** 그림자 판의 판 번호 */
  profileVersion: number;
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
  /** 그림자 판과 적용 판의 판정이 갈렸다(그 판만 추가 검증으로 보냈다, §10.4) */
  shadowDisagreement(direction: 'shadow_only' | 'active_only'): void;
  /** 키 회전의 이음에서 키 하나를 옮겼거나 옮기지 못했다(§4.10) */
  invRefMigration(feature: MigrationFeature, result: 'moved' | 'failed' | 'skipped'): void;
  /** 라벨 반영이 차단 키를 바꿨다(§9 '기록') */
  blockListChange(op: 'added' | 'removed', source: LabelSource): void;
}

/** 라벨 멱등 기록(tr:lbl)의 판 견주기 결과. device는 같은 라벨(부정 예매는 같은 (건 ID, pid)의 짝 출처 포함)의 앞 판이 찾아 둔 기기 가명 */
export type LabelClaim =
  /** 이 판으로 반영한다. resume이면 같은 판이 '시작함'에서 끊겼던 것을 이어 간다 */
  | { kind: 'GO'; resume: boolean; device: string | undefined }
  /** 같은 판이 이미 끝났다(그때의 결과) */
  | { kind: 'DONE'; result: BlockListChange }
  /** 저장한 판보다 작다(부정 예매는 짝 출처의 판과도 견준다). 저장한 판의 결과, 아직 끝나지 않았으면 NONE */
  | { kind: 'STALE'; result: BlockListChange }
  /** 같은 건 ID에 다른 출처, 또는 처음과 다른 사람·회차가 있다 */
  | { kind: 'CONFLICT' };

/**
 * 차단 키 Lua의 결과: APPLIED 이번에 정했다, REPLAY 같은 판이 이미 정한 처음 결과, SUPERSEDED 더 큰 판이 이미 반영돼 건너뜀(그 판의 결과),
 * MOVED 키 회전이 그 기기를 새 판 값(next)으로 옮겨 바꾸지 않았다
 */
export type BlockApplied = { kind: 'APPLIED' | 'REPLAY' | 'SUPERSEDED'; result: Exclude<BlockListChange, 'DEVICE_NOT_FOUND'> } | { kind: 'MOVED'; next: string };

/** 부정 예매 출처의 판 가드 칸: (건 ID, pid)의 짝, 사건의 조치 계정 수, 이 라벨이 조치(A)인지 이의 인정(R)인지 */
export interface FraudGuard {
  pair: string;
  caseField: string;
  kind: 'A' | 'R';
}

/** 라벨 반영 저장소(세션·캐시 Redis). 실패는 던진다(유스케이스가 UNAVAILABLE로 답한다) */
export interface LabelStore {
  /**
   * tr:lbl:{source_ref}의 판을 Lua 한 번으로 견주고, 반영할 판이면 '시작함'으로 잡는다. family는 같은 건 ID에 함께 올 수 있는 출처 묶음, who는 처음 받은 사람·회차의 해시,
   * entry는 라벨 ID의 칸 이름, fraud는 부정 예매 출처의 짝(같은 (건 ID, pid)의 두 출처 판을 함께 견준다)
   */
  claim(i: { sourceRef: string; family: string; who: string; entry: string; version: number; label: Label; fraud?: { pair: string; partner: string; kind: 'A' | 'R' } }): Promise<LabelClaim>;
  /** 판정 근거 키(tr:vb:{pid}:E). 없거나 읽을 수 없는 값이면 undefined */
  evidence(pid: string, eventId: string): Promise<LabelEvidence | undefined>;
  /** 키 회전의 이어 달기(tr:refnext)를 따라 새 판 값으로. 없으면 받은 값 */
  follow(deviceRef: string): Promise<string>;
  /** 차단 키·판 가드(tr:blkv)·이어 달기(tr:refnext)를 같은 슬롯의 Lua 한 번으로 본다. entry는 라벨 ID의 칸 이름 */
  applyBlock(i: { deviceRef: string; entry: string; version: number; op: BlockOp; evidenceBlock: boolean; value: string; caseId: string; fraud?: FraudGuard }): Promise<BlockApplied>;
  /** '끝남'과 결과, 찾은 기기 가명을 적는다. 그사이 더 큰 판이 잡았으면 적지 않고 false */
  finish(i: { sourceRef: string; entry: string; version: number; result: BlockListChange; device: string | undefined }): Promise<boolean>;
}

/** 라벨의 판정 기록(asyncapi TrustVerdict, source SAMPLE_REVIEW·POST_LABEL). 처리자·pid·기기 가명은 싣지 않는다 */
export interface LabelRecord {
  eventKey: string;
  eventId: string;
  queueEntryId?: string;
  category: 'LABELED_BOT' | 'LABELED_HUMAN';
  source: 'SAMPLE_REVIEW' | 'POST_LABEL';
  reviewBatch?: ReviewBatch;
  appliedVerdict?: AppliedVerdict;
  occurredAtMs: number;
}

/** 라벨의 판정 기록을 내보낸다. 던지지 않는다 */
export interface LabelRecorder {
  label(r: LabelRecord): void;
}

/** 라벨 반영이 실패한 단계(경고 줄) */
export type LabelStep = 'claim' | 'evidence' | 'follow' | 'block' | 'finish';

/**
 * 라벨 반영의 보안 로그(§9 '기록'·'실패', ASVS 16.3.3·16.3.4). 던지지 않는다.
 * change: 차단 키를 바꾼 줄 trust_block_list_change(건 ID, 출처, 바뀐 것, 처리자의 로그 가명, 시각). 기기 가명과 처리자 원문은 싣지 않는다
 * failed: 저장소에 닿지 못한 경고 줄(건 ID, 출처, 실패한 단계)
 */
export interface BlockListChangeLog {
  change(e: { caseId: string; source: LabelSource; actedBy: string; atMs: number; change: 'ADDED' | 'REMOVED' }): void;
  failed(e: { caseId: string; source: LabelSource; step: LabelStep }): void;
}
