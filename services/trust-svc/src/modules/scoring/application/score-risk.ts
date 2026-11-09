// ScoreRisk(docs/features/bot-defense.md §2·§4): ① 입력 정리 ② 확정 신호 ③ 점수기 모두 돌리기 ④ 가중합과 기준값 ⑤ 기록.
// 사람 확인 토큰은 1회용이라 확정 신호로 판정이 정해져도 검증은 한다. 판정 기록은 응답을 보낸 뒤 쓴다(실패해도 판정은 그대로, §18).
// 추가 검증 제출(VERIFICATION)은 HumanCheck만 보고 가중합을 하지 않는다(§3.1·§5.2, FR-020).
import { type Clock, uuidv7 } from '@peaket/platform';
import { decide } from '../domain/pipeline.js';
import { type BehaviorRecorder, type DeviceRefs, type AsnClassifier, FEATURE_NAMES, type FeatureRead, type FeatureStore, type HumanCheckPort, type RuleSource, type TrustSignals, type VerdictRecorder } from '../domain/ports.js';
import { type DeviceSignals, type Scorer, SCORER_LIST, type ScorerOutcome } from '../domain/scorers.js';
import type { HardSignal, HumanAction, HumanCheckResult, ScoreContext, ScoreRequest, ScoreResult, ShuffleMode } from '../domain/types.js';
import { TrustError } from './trust-error.js';

/** Redis 해시 태그 안에 들어가는 값(회차 ID·pid)의 모양 */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
/** deviceId의 모양: CSPRNG 128비트, base64url 22자(docs/frontend.md §3.12) */
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;
/** 사람 확인 토큰 상한: 관리 로그인 계약(openapi humanCheckToken maxLength 2048)과 같다. Cloudflare 문서에서 저장소 안의 근거를 찾지 못해 값 자체는 [가정]이다 */
const HUMAN_TOKEN_MAX = 2048;
const ACTION: Record<Exclude<ScoreContext, 'LOGIN'>, HumanAction> = { LOBBY_ENTRY: 'lobby', PREVERIFY: 'preverify', VERIFICATION: 'verify' };

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
    const profile = current.intensities[rules.intensity()][shuffleOf(req)];

    // ① 입력 정리. 기기 가명은 원문을 저장하지 않으려고 먼저 바꾼다
    const deviceRef = req.deviceId ? devices.ref(req.deviceId) : undefined;
    const refMissing = req.deviceId !== '' && deviceRef === undefined;
    const netClass = asn.classify(req.client.asn);

    // ②·③의 입력을 함께 모은다: 사람 확인과 Redis 읽기는 서로 기다릴 까닭이 없다(§4.6의 시간 안에 끝나게). 토큰은 1회용이라 확정 신호가 있어도 검증한다
    const [human, read] = await Promise.all([this.#humanCheck(req), this.#read(deviceRef, req.pid, now)]);
    if (human !== 'ABSENT') signals.humanCheck(human);
    for (const f of read.failed) signals.featureFailed(f);

    // ② 확정 신호. 판정을 앞에서 정할 뿐 ③을 건너뛰지 않는다(§4.1 ②). 읽지 못한 키는 신호 없음으로 본다(§18)
    const hard: HardSignal = read.blocked ? 'BLOCK_LIST' : read.honeypot ? 'HONEYPOT' : 'NONE';
    if (hard !== 'NONE') signals.hardSignal(hard);

    // ③ 점수기 여섯을 모두 돌린다
    const device: DeviceSignals = req.deviceId === '' ? { state: 'NONE' } : !deviceRef || (read.accounts === undefined && read.history === undefined) ? { state: 'FAILED' } : { state: 'READ', accounts: read.accounts, shared: undefined, history: read.history };
    const outcomes: ScorerOutcome[] = this.#scorers.map((s) =>
      s.score(
        {
          now,
          human,
          device,
          behavior: req.behavior,
          network: { netClass, entries10s: undefined },
          firstVisitAtMs: req.firstVisitAtMs,
          sessionCreatedAtMs: req.sessionCreatedAtMs,
          client: req.client,
        },
        current.params,
      ),
    );

    // ④ 가중합과 기준값(값 없음은 0으로 더한다)
    const decision = decide(outcomes, profile, hard, { featureFailed: read.failed.length > 0, noEvidence: req.context === 'LOGIN' && !hasLoginEvidence(outcomes, device) });
    for (const o of outcomes) if (o.risk === null) signals.scorerMissing(o.name, o.missing ?? 'absent');
    signals.verdict(req.context, decision.verdict);

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
          await features.recordChallenge({ deviceRef, pid: req.pid, eventId: req.eventId, now, evidence: { eventKey, deviceRef, hardSignal: hard, reason, profileVersion: current.version, decidedAtMs: now } });
        } catch {
          signals.afterFailed('challenge');
        }
      });
    }
    // 사람 확인을 통과한 판정의 계정만 기기 집합에 넣는다(그러지 않으면 아무 값으로나 남의 기기 이력을 더럽힐 수 있다)
    if (human === 'PASSED' && deviceRef && req.pid !== '') {
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

  /** 피처 읽기 실패는 값 없음이다(§4.4·§18). 판정을 막지 않고, 저장소 전체가 던지면 모든 칸을 실패로 둔다 */
  async #read(deviceRef: string | undefined, pid: string, now: number): Promise<FeatureRead> {
    try {
      return await this.#d.features.read({ deviceRef, pid, now });
    } catch {
      return { blocked: undefined, honeypot: undefined, accounts: undefined, history: undefined, failed: FEATURE_NAMES };
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

/** 이력이 있는 기기인가(지난 30일 사람 확인을 통과한 계정이나 추가 검증 기록이 있다) */
const hasDeviceHistory = (d: DeviceSignals): boolean => d.state === 'READ' && ((d.accounts ?? 0) > 0 || (d.history !== undefined && d.history.sent + d.history.passed + d.history.failed > 0));

/**
 * 로그인 판정의 근거가 있는가. 처음 보는 기기의 DeviceTrust는 위험 0이지만 '이 기기를 안다'는 근거가 아니다(훔친 비밀번호로 새 기기에서 로그인해도 같다).
 * 그래서 로그인에서는 이력이 없는 기기를 근거로 세지 않는다. 로비·사전 검증은 사람 확인이 근거라 이 규칙을 쓰지 않는다(identity §7, ADR-0248 결정 4)
 */
const hasLoginEvidence = (outcomes: readonly ScorerOutcome[], device: DeviceSignals): boolean => outcomes.some((o) => o.risk !== null && (o.name !== 'DeviceTrust' || hasDeviceHistory(device)));

const shuffleOf = (r: ScoreRequest): ShuffleMode => (r.context === 'LOGIN' || r.context === 'VERIFICATION' ? 'NONE' : r.shuffle);
