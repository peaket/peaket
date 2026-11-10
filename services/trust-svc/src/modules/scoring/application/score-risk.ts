// ScoreRisk(docs/features/bot-defense.md §2·§4): ① 입력 정리 ② 확정 신호 ③ 점수기 모두 돌리기 ④ 가중합과 기준값 ⑤ 기록.
// 사람 확인 토큰은 1회용이라 확정 신호로 판정이 정해져도 검증은 한다. 판정 기록은 응답을 보낸 뒤 쓴다(실패해도 판정은 그대로, §18).
// 추가 검증 제출(VERIFICATION)은 HumanCheck만 보고 가중합을 하지 않는다(§3.1·§5.2, FR-020).
// 로비 입장·사전 검증에서만: 키 회전의 이음 기간이면 피처를 읽기 전에 옛 판 키를 새 판으로 옮기고(§4.10), 그림자 판이 있으면 ③·④만 그 판으로 다시 계산해 따로 기록한다(§10.4).
import { type Clock, uuidv7 } from '@peaket/platform';
import { decide } from '../domain/pipeline.js';
import {
  type BehaviorRecorder,
  type DeviceRefs,
  type AsnClassifier,
  FEATURE_NAMES,
  type FeatureName,
  type FeatureRead,
  type FeatureStore,
  type HumanCheckPort,
  MIGRATION_FEATURES,
  type MigrationFeature,
  type MigrationResult,
  type RuleSource,
  type ShadowVerdict,
  type TrustSignals,
  type VerdictRecorder,
} from '../domain/ports.js';
import type { ShadowRuleSet } from '../domain/rules.js';
import { type DeviceSignals, type Scorer, SCORER_LIST, type ScorerInput, type ScorerOutcome } from '../domain/scorers.js';
import type { HardSignal, HumanAction, HumanCheckResult, Intensity, ScoreContext, ScoreRequest, ScoreResult, ShuffleMode } from '../domain/types.js';
import { TrustError } from './trust-error.js';

/** Redis 해시 태그 안에 들어가는 값(회차 ID·pid)의 모양 */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
/** deviceId의 모양: CSPRNG 128비트, base64url 22자(docs/frontend.md §3.12) */
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;
/** 사람 확인 토큰 상한: 관리 로그인 계약(openapi humanCheckToken maxLength 2048)과 같다. Cloudflare 문서에서 저장소 안의 근거를 찾지 못해 값 자체는 [가정]이다 */
const HUMAN_TOKEN_MAX = 2048;
const ACTION: Record<Exclude<ScoreContext, 'LOGIN'>, HumanAction> = { LOBBY_ENTRY: 'lobby', PREVERIFY: 'preverify', VERIFICATION: 'verify' };
/** 옮기지 못하면 값 없음이 되는 읽기 피처(차단 키의 판 가드는 판정에 쓰지 않는다) */
const MIGRATION_READS: Partial<Record<MigrationFeature, FeatureName>> = { accounts: 'accounts', history: 'history', block: 'block', shared: 'shared' };
const READ_FIELD: Partial<Record<FeatureName, 'accounts' | 'history' | 'blocked' | 'shared'>> = { accounts: 'accounts', history: 'history', block: 'blocked', shared: 'shared' };

export interface ScoreRiskDeps {
  rules: RuleSource;
  human: HumanCheckPort;
  features: FeatureStore;
  devices: DeviceRefs;
  asn: AsnClassifier;
  recorder: VerdictRecorder;
  behaviors: BehaviorRecorder;
  signals: TrustSignals;
  clock: Clock;
  /** 응답 뒤로 미룰 일을 맡긴다 */
  after: (work: () => Promise<void>) => void;
  scorers?: readonly Scorer[];
}

export class ScoreRisk {
  readonly #d: ScoreRiskDeps;
  readonly #scorers: readonly Scorer[];

  constructor(deps: ScoreRiskDeps) {
    this.#d = deps;
    this.#scorers = deps.scorers ?? SCORER_LIST;
  }

  async run(req: ScoreRequest): Promise<ScoreResult> {
    validate(req);
    const startedAt = this.#d.clock.monotonicMs();
    const now = this.#d.clock.now();
    if (req.context === 'VERIFICATION') return this.#verification(req, now, startedAt);
    return this.#score(req, now, startedAt);
  }

  async #score(req: ScoreRequest, now: number, startedAt: number): Promise<ScoreResult> {
    const { rules, features, devices, asn, signals, recorder, behaviors, clock } = this.#d;
    const current = rules.current();
    // 처음부터 읽지 못한 파드는 준비 상태가 되지 않는다(§4.4). 그래도 불렸으면 통과로 보지 않고 UNAVAILABLE이다
    if (!current) throw new TrustError('UNAVAILABLE', '비공개 규칙 설정을 읽지 못했다');
    // 강도(명령 5)는 한 번만 읽는다. 그림자 판도 이 강도로 계산한다(요청 도중 강도가 바뀌어도 두 판이 같은 강도다, §10.4)
    const intensity = rules.intensity();
    const profile = current.intensities[intensity][shuffleOf(req)];

    // ① 입력 정리. 기기 가명은 원문을 저장하지 않으려고 먼저 바꾼다
    const deviceRef = req.deviceId ? devices.ref(req.deviceId) : undefined;
    const refMissing = req.deviceId !== '' && deviceRef === undefined;
    const netClass = asn.classify(req.client.asn);

    // 회차 피처는 로비 입장·사전 검증에만 있다(§3.1). 호스팅·프록시 대역만 진입 수를 센다
    const perEvent = req.context === 'LOBBY_ENTRY' || req.context === 'PREVERIFY';
    const hostEntry = perEvent && (netClass === 'HOSTING' || netClass === 'PROXY') ? { asn: req.client.asn, eventId: req.eventId } : undefined;
    // 기기 공유 수는 사람 확인 결과와 상관없이 넣고 센다. 일부러 사람 확인에 실패해 세지 않게 피하지 못한다(§4.9, ADR-0251 결정 1)
    const shareEventId = perEvent && deviceRef && req.pid !== '' ? req.eventId : undefined;
    // 키 회전의 이음: 옛 판 값(이음 끝 전이고 옛 판 라벨 키를 받았을 때만, §4.10). 로그인·추가 검증 제출은 옮기지 않는다
    const prev = perEvent && deviceRef ? devices.prev?.(req.deviceId) : undefined;

    // ②·③의 입력을 함께 모은다: 사람 확인과 Redis 읽기는 서로 기다릴 까닭이 없다(§4.6의 시간 안에 끝나게). 토큰은 1회용이라 확정 신호가 있어도 검증한다
    const [human, prepared] = await Promise.all([this.#humanCheck(req), this.#prepare(deviceRef, prev, req.eventId, req.pid, now, hostEntry, shareEventId)]);
    const { read, notMoved } = prepared;
    if (human !== 'ABSENT') signals.humanCheck(human);
    for (const f of read.failed) signals.featureFailed(f);

    // ② 확정 신호. 판정을 앞에서 정할 뿐 ③을 건너뛰지 않는다(§4.1 ②). 읽지 못한 키는 신호 없음으로 본다(§18)
    const hard: HardSignal = read.blocked ? 'BLOCK_LIST' : read.honeypot ? 'HONEYPOT' : 'NONE';
    if (hard !== 'NONE') signals.hardSignal(hard);

    // ③ 점수기 여섯을 모두 돌린다
    const device: DeviceSignals = req.deviceId === '' ? { state: 'NONE' } : !deviceRef || (read.accounts === undefined && read.history === undefined && read.shared === undefined) ? { state: 'FAILED' } : { state: 'READ', accounts: read.accounts, shared: read.shared, history: read.history };
    const input: ScorerInput = {
      now,
      human,
      device,
      behavior: req.behavior,
      network: { netClass, entries10s: read.hostEntries },
      firstVisitAtMs: req.firstVisitAtMs,
      sessionCreatedAtMs: req.sessionCreatedAtMs,
      client: req.client,
    };
    const outcomes: ScorerOutcome[] = this.#scorers.map((s) => s.score(input, current.params));

    // ④ 가중합과 기준값(값 없음은 0으로 더한다)
    const featureFailed = read.failed.length > 0;
    const decision = decide(outcomes, profile, hard, { featureFailed, noEvidence: req.context === 'LOGIN' && !hasDeviceHistory(device) });
    for (const o of outcomes) if (o.risk === null) signals.scorerMissing(o.name, o.missing ?? 'absent');
    signals.verdict(req.context, decision.verdict);

    // 그림자 판(§10.4): 같은 사람 확인 결과·읽은 피처·확정 신호로 ③·④만 다시 한다. 사람 확인·Redis를 더 부르지 않고, 던져도 적용 판정은 그대로다
    const shadow = perEvent && current.shadow ? this.#shadow(current.shadow, intensity, shuffleOf(req), input, hard, featureFailed) : undefined;
    if (shadow && shadow.verdict !== decision.verdict) signals.shadowDisagreement(shadow.verdict === 'CHALLENGE' ? 'shadow_only' : 'active_only');

    // ⑤ 기록(점수 원값·가중치·기준값은 싣지 않는다)
    const eventKey = uuidv7(clock);
    recorder.record({
      eventKey,
      context: req.context,
      verdict: decision.verdict,
      ...(decision.reason ? { reason: decision.reason } : {}),
      degraded: decision.degraded,
      hardSignal: hard,
      humanCheck: human,
      missingScorers: decision.missingScorers,
      profileVersion: current.version,
      eventId: req.eventId,
      pid: req.pid,
      journeyId: req.journeyId,
      ...(deviceRef ? { deviceRef } : {}),
      refMissing,
      decidedAtMs: now,
      durationMs: Math.max(0, clock.monotonicMs() - startedAt),
      ...(shadow ? { shadow } : {}),
    });
    // 행동 신호는 로비 입장과 사전 검증에서만 낸다. 로비에는 요약이 없다(§4.1)
    if (req.context === 'LOBBY_ENTRY' || req.context === 'PREVERIFY') {
      behaviors.behavior({
        eventKey,
        eventId: req.eventId,
        pid: req.pid,
        journeyId: req.journeyId,
        screen: req.context === 'LOBBY_ENTRY' ? 'LOBBY' : 'EVENT_DETAIL',
        ...(deviceRef ? { deviceRef } : {}),
        refMissing,
        netClass,
        asn: req.client.asn,
        ...(req.behavior ? { features: req.behavior } : {}),
        tsMs: now,
      });
    }
    if (decision.verdict === 'CHALLENGE' && req.context !== 'LOGIN') {
      const reason = decision.reason!;
      this.#d.after(async () => {
        try {
          // 기기 이력을 옮기지 못했으면 새 판 이력의 보냄 수를 올리지 않는다(다음 판정이 옮기게, §4.10 '실패'). 판정 근거 키는 남긴다
          const historyRef = notMoved.has('history') ? undefined : deviceRef;
          await features.recordChallenge({ deviceRef: historyRef, pid: req.pid, eventId: req.eventId, now, evidence: { eventKey, deviceRef, hardSignal: hard, reason, profileVersion: current.version, decidedAtMs: now } });
        } catch {
          signals.afterFailed('challenge');
        }
      });
    }
    // 그림자 판의 CHALLENGE는 판정 근거 키와 기기 이력을 쓰지 않는다(위는 적용 판정만 본다)
    // 사람 확인을 통과한 판정의 계정만 기기 집합에 넣는다(그러지 않으면 아무 값으로나 남의 기기 이력을 더럽힐 수 있다)
    // 기기 집합을 옮기지 못했으면 새 판 집합에 넣지 않는다(다음 판정이 옮기게, §4.10 '실패')
    if (human === 'PASSED' && deviceRef && req.pid !== '' && !notMoved.has('accounts')) {
      this.#d.after(async () => {
        try {
          await features.addAccount({ deviceRef, pid: req.pid, now, newDevicesPerDay: current.params.device.newDevicesPerDay });
        } catch {
          signals.afterFailed('account');
        }
      });
    }
    return { verdict: decision.verdict, ...(decision.reason ? { reason: decision.reason } : {}), degraded: decision.degraded };
  }

  /** 추가 검증 제출: 성공이면 ALLOW, 아니면 CHALLENGE(보류도 통과로 보지 않는다, §5.2) */
  async #verification(req: ScoreRequest, now: number, startedAt: number): Promise<ScoreResult> {
    const { recorder, signals, features, devices, clock, rules } = this.#d;
    const human = await this.#humanCheck(req);
    signals.humanCheck(human);
    const passed = human === 'PASSED';
    const degraded = human === 'PENDING';
    signals.verdict('VERIFICATION', passed ? 'ALLOW' : 'CHALLENGE');
    const deviceRef = req.deviceId ? devices.ref(req.deviceId) : undefined;
    recorder.record({
      eventKey: uuidv7(clock),
      context: 'VERIFICATION',
      verdict: passed ? 'ALLOW' : 'CHALLENGE',
      ...(passed ? {} : { reason: 'HUMAN_CHECK' as const }),
      degraded,
      hardSignal: 'NONE',
      humanCheck: human,
      missingScorers: human === 'PENDING' ? ['HumanCheck'] : [],
      profileVersion: rules.current()?.version ?? 0,
      eventId: req.eventId,
      pid: req.pid,
      journeyId: req.journeyId,
      ...(deviceRef ? { deviceRef } : {}),
      refMissing: req.deviceId !== '' && deviceRef === undefined,
      decidedAtMs: now,
      durationMs: Math.max(0, clock.monotonicMs() - startedAt),
    });
    if (deviceRef && human !== 'PENDING') {
      this.#d.after(async () => {
        try {
          await features.recordVerification({ deviceRef, passed, now });
        } catch {
          signals.afterFailed('verification');
        }
      });
    }
    return passed ? { verdict: 'ALLOW', degraded } : { verdict: 'CHALLENGE', reason: 'HUMAN_CHECK', degraded };
  }

  #humanCheck(req: ScoreRequest): Promise<HumanCheckResult> {
    if (req.context === 'LOGIN') return Promise.resolve('ABSENT');
    if (!req.humanCheckToken) return Promise.resolve('FAILED');
    return this.#d.human.verify({ token: req.humanCheckToken, action: ACTION[req.context], remoteIp: req.client.ip, deadlineAtMs: req.deadlineAtMs });
  }

  /** 그림자 판의 판정. 점수기·합치기가 던지면 이 요청의 그림자 기록만 없다 */
  #shadow(rules: ShadowRuleSet, intensity: Intensity, shuffle: ShuffleMode, input: ScorerInput, hard: HardSignal, featureFailed: boolean): ShadowVerdict | undefined {
    try {
      const outcomes = this.#scorers.map((s) => s.score(input, rules.params));
      const d = decide(outcomes, rules.intensities[intensity][shuffle], hard, { featureFailed });
      return { eventKey: uuidv7(this.#d.clock), verdict: d.verdict, ...(d.reason ? { reason: d.reason } : {}), profileVersion: rules.version };
    } catch {
      return undefined;
    }
  }

  /**
   * 키 회전의 이음이면 피처를 읽기 전에 옮긴다(§4.10). 옮기지 못한 피처는 읽기 실패와 같이 값 없음이고 degraded가 참이다(판정은 이어 간다).
   * 옮기지 못한 피처의 새 판 키는 이 판정이 만들지 않는다(공유 수 세기를 하지 않고, 부른 쪽이 응답 뒤 쓰기를 건너뛴다). 새 판 키가 먼저 생기면 다음 판정의 옮기기가 건너뛰기 때문이다.
   * 차단 키의 판 가드는 판정에 쓰지 않으므로 지표로만 센다
   */
  async #prepare(deviceRef: string | undefined, prev: { ref: string; until: number } | undefined, eventId: string, pid: string, now: number, hostEntry: { asn: number; eventId: string } | undefined, shareEventId: string | undefined): Promise<{ read: FeatureRead; notMoved: ReadonlySet<FeatureName> }> {
    const failed = new Set<FeatureName>();
    if (deviceRef && prev && prev.ref !== deviceRef) {
      let result: MigrationResult;
      try {
        result = await this.#d.features.migrate({ from: prev.ref, to: deviceRef, eventId, until: prev.until, now });
      } catch {
        result = Object.fromEntries(MIGRATION_FEATURES.map((f) => [f, 'failed'])) as MigrationResult;
      }
      for (const f of MIGRATION_FEATURES) {
        const outcome = result[f];
        if (outcome !== 'none') this.#d.signals.invRefMigration(f, outcome);
        const feature = MIGRATION_READS[f];
        if (outcome === 'failed' && feature) failed.add(feature);
      }
    }
    // 공유 수는 이 판정이 셀 때만(pid가 있을 때) 읽는 피처다. 옮기지 못했으면 새 판 키에 넣지 않는다
    const share = failed.has('shared') ? undefined : shareEventId;
    const read = await this.#read(deviceRef, pid, now, hostEntry, share);
    const counted = [...failed].filter((f) => f !== 'shared' || shareEventId !== undefined);
    if (counted.length === 0) return { read, notMoved: failed };
    const out: FeatureRead = { ...read, failed: [...new Set([...read.failed, ...counted])] };
    for (const f of counted) {
      const field = READ_FIELD[f];
      if (field) out[field] = undefined;
    }
    return { read: out, notMoved: failed };
  }

  /** 피처 읽기 실패는 값 없음이다(§4.4·§18). 판정을 막지 않고, 저장소 전체가 던지면 물어본 칸을 실패로 둔다 */
  async #read(deviceRef: string | undefined, pid: string, now: number, hostEntry: { asn: number; eventId: string } | undefined, shareEventId: string | undefined): Promise<FeatureRead> {
    try {
      return await this.#d.features.read({ deviceRef, pid, now, hostEntry, shareEventId });
    } catch {
      return { blocked: undefined, honeypot: undefined, accounts: undefined, history: undefined, shared: undefined, hostEntries: undefined, failed: FEATURE_NAMES.filter((f) => (f !== 'shared' || shareEventId !== undefined) && (f !== 'entries' || hostEntry !== undefined)) };
    }
  }
}

function validate(r: ScoreRequest): void {
  if (r.context === 'LOBBY_ENTRY' || r.context === 'PREVERIFY') {
    if (r.shuffle === 'NONE') throw new TrustError('INVALID_ARGUMENT', '정렬 설정이 없다');
  }
  if (r.context !== 'LOGIN' && !KEY_PART.test(r.eventId)) throw new TrustError('INVALID_ARGUMENT', '회차 ID 모양이 틀렸다');
  if (r.eventId !== '' && !KEY_PART.test(r.eventId)) throw new TrustError('INVALID_ARGUMENT', '회차 ID 모양이 틀렸다');
  if (r.pid !== '' && !KEY_PART.test(r.pid)) throw new TrustError('INVALID_ARGUMENT', 'pid 모양이 틀렸다');
  if (r.deviceId !== '' && !DEVICE_ID.test(r.deviceId)) throw new TrustError('INVALID_ARGUMENT', '기기 식별값 모양이 틀렸다');
  if (r.humanCheckToken.length > HUMAN_TOKEN_MAX) throw new TrustError('INVALID_ARGUMENT', '사람 확인 토큰이 너무 길다');
}

/**
 * 이력이 있는 기기인가(지난 30일 사람 확인을 통과한 계정이나 추가 검증 기록이 있다). 로그인 판정의 근거는 이것 하나다.
 * 처음 보는 기기는 위험 0이어도 '이 기기를 안다'는 근거가 아니고(훔친 비밀번호로 새 기기에서 로그인해도 같다), 망·브라우저 정보·나이의 값도 근거가 아니다. 기준값을 넘으면 decide가 CHALLENGE를 낸다(identity §7, ADR-0248 결정 4, ADR-0251 결정 7)
 */
const hasDeviceHistory = (d: DeviceSignals): boolean => d.state === 'READ' && ((d.accounts ?? 0) > 0 || (d.history !== undefined && d.history.sent + d.history.passed + d.history.failed > 0));

const shuffleOf = (r: ScoreRequest): ShuffleMode => (r.context === 'LOGIN' || r.context === 'VERIFICATION' ? 'NONE' : r.shuffle);
