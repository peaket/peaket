// admission-ctrl 리더 루프(docs/features/queue-admission.md §5, FR-037, ADR-0056 결정 3, ADR-0182).
// 200ms마다: Lease 세대가 있으면 진행 중인 회차마다 (처음이면) 세대부터 올리고, 리더 상태를 읽어 자동 제어로 목표를 정하고(HOT-030, ADR-0226), 회차끼리 상한을 나눈 뒤 전진하고, 필요하면 로비·묶음을 닫고 게시를 부른다.
// FENCED를 받으면 그 세대로는 더 쓰지 않는다(Lease가 새 세대를 줄 때까지). 저장소의 Lua가 쓰기를 세대로 막으므로 이 파일은 순서만 맡는다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { BatchMembersChanged } from '../../batch/index.js';
import { boundsOf, changedFields, decideAimd, demandOf, memoryFromFields, memoryToFields, openGapViolationsOf, pgRateCapOf, pgTargetCapOf, shareRate, shareTargets, storedTarget, type Pg, type ShareRow } from '../domain/aimd.js';
import {
  AGGREGATE_TARGET_CAP,
  ARRIVAL_WINDOW_MS,
  AUTO_STOP_CACHE_MS,
  closeAtOf,
  DEFAULT_TARGET,
  INITIAL_SALE_STATE,
  INPUT_POLL_MS,
  keepUntilOf,
  MAX_ADVANCE_PER_TICK,
  OPEN_GAP_CHECK_MS,
  OPEN_GAP_MS,
  PRE_OPEN_MS,
  RATE_CAP_PER_SEC,
  RATIO_FLOOR,
  RB05_CHECK_MS,
  RB05_SKIP_BASE,
  saleEndOf,
  SHUFFLE_PUBLISH_MS,
  TICK_MS,
} from '../domain/plan.js';
import { CONTROL_INPUTS, type Control, type ControlInputsReader, type ControlSnapshot, ELECTOR, type Elector, type EventPlan, LEADER_STORE, type LeaderStore, PUBLISHER, type Publisher } from '../domain/ports.js';
import { drandRoundTimeMs } from '@peaket/shuffle';
import { type ControlEvent, LEADER_METRICS, type LeaderMetrics } from './leader-metrics.js';

/** 회차 목록·일정 사본을 파드 메모리에 두는 시간 1초 [가정](queue-svc 일정 캐시와 같다) */
const CACHE_MS = 1_000;
/** 같은 회차의 같은 실패를 남기는 간격 10초 [가정](200ms 주기마다 같은 줄이 쌓이지 않게) */
const ERROR_LOG_EVERY_MS = 10_000;
/** 멈출 때 뒤에서 도는 게시를 기다리는 한도 10초 [가정](Lease를 놓기 전에 쓰기를 멈춘다, ADR-0056 결정 3) */
const STOP_WAIT_MS = 10_000;
/** 회차 판매 상태(ADR-0122). ON_SALE만 전진한다 */
const KNOWN_SALE_STATES = new Set(['UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED']);

/** 회차 하나의 이번 주기 준비(자동 제어까지 끝낸 값). 나누기 뒤 전진한다 */
interface Prep {
  eventId: string;
  plan: EventPlan;
  ctl: Control;
  /** 결제사 묶음 나누기 전의 목표 */
  want: number;
  fields: Record<string, string>;
  pg?: Pg;
  control: Omit<ControlEvent, 'target'>;
}
/** 준비가 실패한 회차(전진하지 않지만 합산에는 마지막 몫을 남긴다, ADR-0226 결정 10) */
interface Failed {
  failed: string;
}

const NO_CONTROL = { decreases: [], suppressed: 0, ignored: [], staleKinds: [] } satisfies Omit<ControlEvent, 'target'>;

@Injectable()
export class AdmissionLeader {
  #timer?: NodeJS.Timeout;
  #busy = false;
  /** 세대를 올린 회차(세대가 바뀌면 다시 올린다) */
  #bumped: { gen: number | undefined; events: Set<string> } = { gen: undefined, events: new Set() };
  /** FENCED를 받은 세대: 이 세대로는 더 쓰지 않는다 */
  #fencedGen?: number;
  /** at은 단조 시계(ms) */
  #events?: { at: number; ids: string[] };
  readonly #plans = new Map<string, { at: number; plan: EventPlan | null }>();
  /** 게시 뒤 참가자가 바뀌어 게시를 멈춘 회차(사람이 결과 파일로 되살린다) */
  readonly #stopped = new Set<string>();
  /** 회차마다 마지막으로 본 판매 상태(판매 상태 칸이 없을 때 쓴다, ADR-0122) */
  readonly #saleStates = new Map<string, string>();
  /** 회차마다 RB-05를 마지막으로 부른 시각(리더 시계) */
  readonly #rb05At = new Map<string, number>();
  readonly #loggedAt = new Map<string, number>();
  /** 뒤에서 도는 게시(구간마다 하나) */
  readonly #publishing = new Map<string, Promise<void>>();
  /** 회차마다 하나씩 뒤에서 도는 RB-05 복제 확인(WAIT가 0.5초까지 걸려 다른 회차의 전진을 막지 않게, ADR-0186) */
  readonly #confirming = new Map<string, Promise<void>>();
  /** 직전 주기의 값(나누기의 수요와 감축 확인의 예매 단계 인원, ADR-0226 결정 10) */
  readonly #last = new Map<string, { waiting: number; slots: number; soon: number; inFlight: number; saleState: string; gated: boolean }>();
  /** 회차마다 마지막으로 쓴 목표(준비가 실패한 회차의 몫으로 합산에 남긴다) */
  readonly #lastTargets = new Map<string, number>();
  /** 회차마다 아직 쓰지 못한 전진 몫(소수 몫을 주기마다 쌓는다, ADR-0226 결정 10) */
  readonly #rateCredit = new Map<string, number>();
  /** 제어 입력(첫 읽기 전에는 없다: 판단하지 않는다, ADR-0226 결정 4). 세대가 바뀌면 버린다 */
  #snapshot?: ControlSnapshot;
  #inputsEpoch = 0;
  #inputsReading = false;
  #inputsAt = Number.NEGATIVE_INFINITY;
  #autoStopped = false;
  #autoStopAt = Number.NEGATIVE_INFINITY;
  #openGapAt = Number.NEGATIVE_INFINITY;
  #openGapLast = 0;

  constructor(
    @Inject(LEADER_STORE) private readonly store: LeaderStore,
    @Inject(PUBLISHER) private readonly publish: Publisher,
    @Inject(ELECTOR) private readonly elector: Elector,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
    @Optional() @Inject(LEADER_METRICS) private readonly metrics?: LeaderMetrics,
    @Optional() @Inject(CONTROL_INPUTS) private readonly inputs?: ControlInputsReader,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), TICK_MS);
  }

  /** 루프를 멈춘다(종료 신호: 쓰기를 멈춘 뒤 Lease를 놓는 것은 시작 파일이 한다) */
  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    while (this.#busy) await new Promise((r) => setTimeout(r, 10));
    // 게시를 하다 만 채 Lease를 놓으면 새 리더가 같은 묶음을 또 게시한다. 한도 안에서 끝나기를 기다린다
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.#publishing.values(), ...this.#confirming.values()]), new Promise((r) => (timer = setTimeout(r, STOP_WAIT_MS)))]);
    clearTimeout(timer);
  }

  /** 한 주기. 앞 주기가 아직 돌면 건너뛴다 */
  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    const started = this.clock.monotonicMs();
    try {
      const gen = this.elector.generation();
      this.metrics?.leader(gen !== undefined);
      if (gen === undefined || this.#fencedGen === gen) return;
      if (this.#bumped.gen !== gen) {
        this.#bumped = { gen, events: new Set() };
        // 앞 세대에서 본 판매 상태는 그사이 바뀌었을 수 있다(다른 리더가 있었다). 처음 값으로 시작한다
        this.#saleStates.clear();
        // 옛 입력 사본으로 판단하면 입력 없음으로 잘못 넘어간다. '첫 읽기 전'으로 돌린다(뒤에서 돌던 옛 읽기의 결과도 버린다)
        this.#snapshot = undefined;
        this.#inputsEpoch += 1;
        this.#inputsAt = Number.NEGATIVE_INFINITY;
        this.#last.clear();
        this.#lastTargets.clear();
        this.#rateCredit.clear();
      }
      const now = this.clock.now();
      this.#refreshInputs();
      const ids = await this.#activeEvents(now);
      this.#forgetEnded(ids);
      const autoStopped = await this.#autoStop(now);
      const opens: number[] = [];
      const results = await Promise.all(ids.map((e) => this.#prepare(e, gen, now, autoStopped, opens)));
      const preps = results.filter((p): p is Prep => p !== null && !('failed' in p));
      const failed = results.filter((p): p is Failed => p !== null && 'failed' in p).map((p) => p.failed);
      this.#checkOpenGaps(opens, now);
      const shares = this.#allocate(preps, failed);
      await Promise.all(preps.map((p) => this.#advance(p, gen, now, shares)));
    } catch (err) {
      this.#logError('*', this.clock.now(), err, 'admission-ctrl 리더 주기 실패');
    } finally {
      this.metrics?.loop((this.clock.monotonicMs() - started) / 1000);
      this.#busy = false;
    }
  }

  /** 세대를 올리고, 리더 상태를 읽어 자동 제어로 이번 주기의 목표를 정한다(전진은 나누기 뒤) */
  async #prepare(eventId: string, gen: number, now: number, autoStopped: boolean, opens: number[]): Promise<Prep | Failed | null> {
    try {
      const plan = await this.#plan(eventId);
      if (!plan || now < plan.opensAtMs - PRE_OPEN_MS || now >= saleEndOf(plan)) return null;
      opens.push(plan.opensAtMs);
      const keepUntilMs = keepUntilOf(plan);
      // 교체 순서: 세대부터 올린다(ADR-0056 결정 3)
      if (!this.#bumped.events.has(eventId)) {
        if ((await this.store.bump(eventId, gen, keepUntilMs)) === 'FENCED') return this.#fence(gen, eventId), null;
        this.#bumped.events.add(eventId);
      }
      if (now < plan.opensAtMs || this.#fencedGen === gen) return null;
      const ctl = await this.store.control(eventId, now);
      const pg = pgOf(plan, ctl);
      const { upper, lower } = boundsOf(pg?.tps);
      const raw = ctl.memory ?? {};
      if (!this.inputs || !this.#snapshot) {
        // 자동 제어를 끄거나(입력 리더 없음) 첫 읽기 전이다: 운영자 값이나 지난 자기 목표를 그대로 쓴다. 안전 범위는 언제나 지킨다
        const want = Math.max(lower, Math.min(upper, ctl.target ?? storedTarget(raw) ?? DEFAULT_TARGET));
        return { eventId, plan, ctl, want, fields: {}, control: NO_CONTROL, ...(pg ? { pg } : {}) };
      }
      // 시작 값은 범위로 깎지 않고 넘긴다: 판단이 깎아야 결제사 상한 감축으로 세어진다. targetNow는 시작 값으로 쓰지 않는다(나눈 값이 자기 목표로 굳는다, ADR-0226 결정 3)
      const memory = memoryFromFields(raw, DEFAULT_TARGET, now);
      const result = decideAimd({ nowMs: now, memory, inputs: this.#snapshot.forEvent(eventId), slotsUsed: this.#last.get(eventId)?.slots, gated: this.#last.get(eventId)?.gated ?? false, paused: ctl.paused, autoStopped, operator: ctl.operator ?? { value: ctl.target ?? null, untilMs: null, resumeAtMs: null }, upper, lower, pgLimited: pg !== undefined });
      for (const d of result.decreases) this.logger?.warn({ eventId, reason: d.reason, journey: d.journey, exposure: d.exposure, from: d.from, to: d.to }, 'admission-ctrl 리더: 동시 입장 목표를 줄였다');
      // 저장된 칸 원문과 견준다: 칸이 없는 새 회차는 처음에 모두 쓰고, 그래야 '시작 때 지금으로 채운 값'이 다음 주기에 그대로 읽힌다
      return { eventId, plan, ctl, want: result.target, fields: changedFields(raw, memoryToFields(result.memory)), control: { decreases: result.decreases, suppressed: result.suppressed, ignored: result.ignored, staleKinds: result.staleKinds }, ...(pg ? { pg } : {}) };
    } catch (err) {
      this.#logError(eventId, now, err, 'admission-ctrl 리더: 회차 주기 실패(같은 회차는 10초에 한 번 남긴다)');
      return { failed: eventId };
    }
  }

  /** 회차끼리 상한을 나눈다: 결제사 묶음(목표·전진 속도) → 플랫폼 합산 상한(ADR-0226 결정 9·10). 준비가 실패한 회차는 저장소에 남은 목표로 계속 사람을 받으므로 마지막 몫을 합산에 넣는다 */
  #allocate(preps: readonly Prep[], failed: readonly string[]): Map<string, { target: number; rate: number }> {
    const out = new Map<string, { target: number; rate: number }>();
    const rows: ShareRow[] = preps.map((p) => ({ id: p.eventId, want: p.want, demand: demandOf(p.want, this.#last.get(p.eventId)) }));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const targets = new Map(rows.map((r) => [r.id, r.want]));
    const rates = new Map(preps.map((p) => [p.eventId, RATE_CAP_PER_SEC]));
    const groups = new Map<string, Prep[]>();
    for (const p of preps) if (p.pg) groups.set(p.pg.key, [...(groups.get(p.pg.key) ?? []), p]);
    for (const members of groups.values()) {
      const tps = Math.min(...members.map((m) => m.pg!.tps));
      const group = members.map((m) => byId.get(m.eventId)!);
      for (const [id, v] of shareTargets(group, pgTargetCapOf(tps))) targets.set(id, Math.min(targets.get(id)!, v));
      for (const [id, v] of shareRate(group, pgRateCapOf(tps))) rates.set(id, Math.min(rates.get(id)!, v));
    }
    // 준비가 실패한 회차의 목표는 저장소에 남아 그대로 쓰이므로 상한에서 먼저 뺀다. 마지막 몫을 모르면(새 리더의 첫 주기) 똑같이 나눈 값으로 본다
    const equal = Math.floor(AGGREGATE_TARGET_CAP / Math.max(1, rows.length + failed.length));
    const held = failed.reduce((sum, id) => sum + (this.#lastTargets.get(id) ?? equal), 0);
    const aggregate = shareTargets(
      rows.map((r) => ({ id: r.id, want: targets.get(r.id)!, demand: Math.min(r.demand, targets.get(r.id)!) })),
      Math.max(0, AGGREGATE_TARGET_CAP - held),
    );
    for (const r of rows) out.set(r.id, { target: aggregate.get(r.id)!, rate: rates.get(r.id)! });
    return out;
  }

  async #advance(p: Prep, gen: number, now: number, shares: Map<string, { target: number; rate: number }>): Promise<void> {
    const { eventId, plan, ctl } = p;
    try {
      const keepUntilMs = keepUntilOf(plan);
      const closeAtMs = closeAtOf(plan);
      const share = shares.get(eventId)!;
      const r = await this.store.tick({
        eventId,
        gen,
        target: share.target,
        ratioFloor: RATIO_FLOOR,
        saleStateFallback: this.#saleStates.get(eventId) ?? INITIAL_SALE_STATE,
        windowMs: ARRIVAL_WINDOW_MS,
        maxAdvance: ctl.paused ? 0 : this.#advanceAllowance(eventId, share.rate),
        keepUntilMs,
        saleEndMs: saleEndOf(plan),
        lobbyShuffle: plan.lobbyShuffle,
        openBatch: plan.openBatch,
        closeAtMs,
        ...(plan.batchRound !== undefined ? { batchResultDelayMs: Math.max(0, drandRoundTimeMs(plan.batchRound) + SHUFFLE_PUBLISH_MS - closeAtMs) } : {}),
        fields: p.fields,
      });
      if (r.kind === 'FENCED') return this.#fence(gen, eventId);
      this.#last.set(eventId, { waiting: r.waiting, slots: r.slots, soon: r.soon, inFlight: r.inFlight, saleState: r.saleState, gated: r.gated === 1 });
      this.#lastTargets.set(eventId, share.target);
      this.#saleStates.set(eventId, r.saleState);
      // 모르는 판매 상태는 전진 0이 된다. 조용히 멈추지 않게 남긴다
      if (!KNOWN_SALE_STATES.has(r.saleState)) this.#logError(`${eventId}:state`, now, undefined, `모르는 판매 상태(${r.saleState})라 전진하지 않는다`);
      this.metrics?.event(eventId, r);
      this.metrics?.control(eventId, { ...p.control, target: share.target });
      // 오픈이 지났는데 로비 표시가 없거나, 구간 끝이 지났는데 묶음 표시가 없으면 닫는다
      if ((plan.lobbyShuffle && r.lobbyMarked === 0) || (plan.openBatch && r.batchMarked === 0 && now >= closeAtMs)) {
        const c = await this.store.close({ eventId, gen, keepUntilMs, opensAtMs: plan.opensAtMs, closeAtMs, lobbyShuffle: plan.lobbyShuffle, openBatch: plan.openBatch });
        if (c === 'FENCED') return this.#fence(gen, eventId);
        // 장애 전환 뒤 RB-05 전이다: 진입 파드가 오지 않아도 리더가 RB-05를 돌고 다음 주기에 닫는다(ADR-0182 결정 6)
        if (c === 'RB05') await this.#rb05(eventId, plan, keepUntilMs, closeAtMs, now);
      }
      // 장애 전환 뒤 새 진입이 오지 않으면(조용한 회차) RB-05가 돌지 않아, 잃은 번호를 든 대기자는 카운터가 그 번호에 닿지 못해 차례가 오지 않는다.
      // 그래서 리더가 회차마다 1초에 한 번 RB-05를 부른다(세대 키가 같으면 Lua가 바로 끝난다, 명세 rb05의 공정성, ADR-0184)
      if (now - (this.#rb05At.get(eventId) ?? Number.NEGATIVE_INFINITY) >= RB05_CHECK_MS) await this.#rb05(eventId, plan, keepUntilMs, closeAtMs, now);
      // 진입 Degraded의 도착 시각 칸을 닫는다(칸 끝 + 20초 [가정], 쓰지 않은 번호를 빠진 번호로 돌린다, ADR-0223 결정 7). 칸이 없으면 Lua가 바로 끝난다
      const arrival = await this.store.closeArrivalSlots({ eventId, gen, keepUntilMs });
      if (arrival.kind === 'FENCED') return this.#fence(gen, eventId);
      if (arrival.kind === 'OK') this.metrics?.arrival(arrival.slots, arrival.returned);
      // 묶음이 닫혔고 게시 전이거나 다시 쓰기 표시가 있으면 게시를 부른다(비콘이 아직이면 다음 주기에 다시). 큰 묶음의 게시는 몇 초 걸리므로
      // 뒤에서 돌려 다른 회차의 전진을 막지 않는다. 게시는 세대를 확인하지 않으므로 지금도 같은 세대의 리더일 때만 시작한다
      if (plan.openBatch && r.batchMarked === 1 && (r.batchPublished === 0 || r.repair === 1)) this.#startPublish(eventId, 1, gen);
      // 로비 결과도 같은 조건으로 게시한다(HOT-040, ADR-0231 결정 9). 구간마다 따로 돌아 로비 셔플이 묶음 게시를 막지 않는다
      if (plan.lobbyShuffle && r.lobbyMarked === 1 && (r.lobbyPublished === 0 || r.lobbyRepair === 1)) this.#startPublish(eventId, 'lobby', gen);
    } catch (err) {
      this.#logError(eventId, now, err, 'admission-ctrl 리더: 회차 주기 실패(같은 회차는 10초에 한 번 남긴다)');
    }
  }

  /** 초당 몫을 이번 주기의 전진 폭으로 바꾼다. 소수 몫은 쌓아 다음 주기에 쓴다(합이 초당 상한을 넘지 않게) */
  #advanceAllowance(eventId: string, rate: number): number {
    const credit = (this.#rateCredit.get(eventId) ?? 0) + (rate * TICK_MS) / 1000;
    const whole = Math.floor(credit + 1e-9);
    this.#rateCredit.set(eventId, credit - whole);
    return Math.min(MAX_ADVANCE_PER_TICK, whole);
  }

  /** 뒤에서 입력을 읽는다(200ms 주기를 막지 않는다, ADR-0226 결정 4). 읽기가 실패하면 마지막 값을 그대로 쓴다 */
  #refreshInputs(): void {
    if (!this.inputs || this.#inputsReading) return;
    const mono = this.clock.monotonicMs();
    if (mono - this.#inputsAt < INPUT_POLL_MS) return;
    this.#inputsAt = mono;
    this.#inputsReading = true;
    const epoch = this.#inputsEpoch;
    this.inputs
      .read()
      .then((s) => {
        if (epoch === this.#inputsEpoch) this.#snapshot = s;
      })
      .catch((err: unknown) => this.#logError('*inputs', this.clock.now(), err, '제어 입력 읽기 실패(마지막 값으로 판단한다)'))
      .finally(() => {
        this.#inputsReading = false;
      });
  }

  /** 명령 11(자동화 정지)을 1초에 한 번 읽는다. 읽지 못하면 정지일 수 있으므로 모르는 동안 자동 판단을 멈춘다(지금 목표를 지킨다) */
  async #autoStop(now: number): Promise<boolean> {
    if (!this.inputs) return false;
    const mono = this.clock.monotonicMs();
    if (mono - this.#autoStopAt < AUTO_STOP_CACHE_MS) return this.#autoStopped;
    this.#autoStopAt = mono;
    try {
      this.#autoStopped = (await this.store.platformControl()).autoStopped;
    } catch (err) {
      this.#autoStopped = true;
      this.#logError('*autostop', now, err, '자동화 정지 상태를 읽지 못해 자동 판단을 멈춘다');
    }
    return this.#autoStopped;
  }

  /** 오픈 간격 규칙의 뒤쪽 그물: 진행 중인 회차끼리 가까우면 지표와 로그만 남긴다(ADR-0226 결정 11, POL-030). 막지 않는다 */
  #checkOpenGaps(opens: readonly number[], now: number): void {
    const mono = this.clock.monotonicMs();
    if (mono - this.#openGapAt < OPEN_GAP_CHECK_MS) return;
    this.#openGapAt = mono;
    const n = openGapViolationsOf(opens, OPEN_GAP_MS);
    this.metrics?.openGaps(n);
    // 위반 쌍의 수가 바뀔 때만 남긴다(판매 종료까지 10초마다 같은 줄이 쌓이지 않게. 지금 값은 지표로 본다)
    if (n > 0 && n !== this.#openGapLast) this.#logError(`*gaps${n}`, now, undefined, `진행 중인 회차끼리 오픈 간격이 5분보다 가깝다(${n}쌍, 등록·판매 승인 검사를 빠져나간 일정을 확인한다, POL-030)`);
    this.#openGapLast = n;
  }

  async #rb05(eventId: string, plan: EventPlan, keepUntilMs: number, closeAtMs: number, now: number): Promise<void> {
    this.#rb05At.set(eventId, now);
    const s = await this.store.rb05({ eventId, expireAtMs: keepUntilMs, skippedExpireAtMs: saleEndOf(plan), skipBase: RB05_SKIP_BASE, opensAtMs: plan.opensAtMs, closeAtMs, lobbyShuffle: plan.lobbyShuffle, openBatch: plan.openBatch });
    if (s.kind === 'SKIPPED') this.logger?.warn({ eventId, start: s.start, end: s.end, gen: s.gen }, 'RB-05(리더): 장애 전환 뒤 번호 구간을 건너뛰었다');
    // 건너뛰기를 붙은 복제본이 받은 것을 확인해야 진입이 다시 열린다(ADR-0186). 1초마다 다시 오므로 조용한 회차도 확인 전에 머물지 않는다
    if ((s.kind === 'SKIPPED' || s.kind === 'PENDING') && !this.#confirming.has(eventId)) {
      const p = this.store
        .confirmRb05({ eventId })
        .then((c) => {
          if (c === 'WAITING') this.#logError(`${eventId}:rb05-wait`, this.clock.now(), undefined, 'RB-05 복제 확인 대기: 붙은 복제본이 건너뛰기를 받지 못해 그 회차의 진입이 멈춰 있다(그 샤드 복제본의 연결·지연 확인, docs/infra.md RB-05)');
        })
        .catch((err: unknown) => this.#logError(`${eventId}:rb05-error`, this.clock.now(), err, 'RB-05 복제 확인 실패(다음 1초에 다시)'))
        .finally(() => this.#confirming.delete(eventId));
      this.#confirming.set(eventId, p);
    }
  }

  #startPublish(eventId: string, group: 'lobby' | number, gen: number): void {
    const key = `${eventId}:${group}`;
    if (this.#stopped.has(eventId) || this.#publishing.has(key)) return;
    if (this.elector.generation() !== gen || this.#fencedGen === gen) return;
    this.#publishing.set(key, this.#publish(eventId, group).finally(() => this.#publishing.delete(key)));
  }

  async #publish(eventId: string, group: 'lobby' | number): Promise<void> {
    try {
      const r = await this.publish.run({ eventId, group });
      this.metrics?.publish(r.status);
      // 비콘 대기 상한을 넘겨 멈췄다: SEV1(RB-35). 지표는 멈춤을 처음 쓴 호출에서 한 번만 낸다(ADR-0231 결정 12)
      if (r.status === 'BEACON_STOPPED' && r.first) {
        this.metrics?.beaconStopped(r.reason ?? 'beacon');
        this.logger?.error({ eventId, group, reason: r.reason }, '셔플 비콘 대기 상한을 넘겨 게시를 멈췄다(RB-35)');
      }
      // 복제본이 계속 없으면 serving이 묶음 첫 번호 - 1에 머문다. 조용히 멈추지 않게 남긴다
      if (r.status === 'WAITING_REPLICA') this.#logError(`${eventId}:replica`, this.clock.now(), undefined, '묶음 게시 전 복제 확인이 안 돼 게시를 미뤘다(복제본 수 확인)');
    } catch (err) {
      if (err instanceof BatchMembersChanged) {
        this.#stopped.add(eventId);
        this.logger?.error({ err, eventId }, '묶음 참가자가 게시 뒤 바뀌어 그 회차의 게시를 멈췄다(결과 파일로 되살린다)');
        return;
      }
      this.metrics?.publish('ERROR');
      this.#logError(`${eventId}:publish`, this.clock.now(), err, 'admission-ctrl 리더: 묶음 게시 실패(다음 주기에 다시)');
    }
  }

  /** 같은 열쇠의 같은 실패는 10초에 한 번 남긴다(200ms 주기마다 같은 줄이 쌓이지 않게) */
  #logError(key: string, now: number, err: unknown, msg: string): void {
    const at = this.#loggedAt.get(key);
    if (at !== undefined && now - at < ERROR_LOG_EVERY_MS) return;
    this.#loggedAt.set(key, now);
    if (err === undefined) this.logger?.warn({ key }, msg);
    else this.logger?.error({ err, key }, msg);
  }

  /** 목록에서 빠진(판매 종료 + 1일이 지난) 회차의 메모리 상태와 회차 이름표 지표를 지운다 */
  #forgetEnded(ids: readonly string[]): void {
    const live = new Set(ids);
    for (const e of [...this.#plans.keys()]) {
      if (live.has(e)) continue;
      this.#plans.delete(e);
      this.#stopped.delete(e);
      this.#saleStates.delete(e);
      this.#rb05At.delete(e);
      this.#last.delete(e);
      this.#lastTargets.delete(e);
      this.#rateCredit.delete(e);
      // 다시 오면 세대부터 다시 올린다
      this.#bumped.events.delete(e);
      this.metrics?.forget(e);
    }
    // 일정을 읽지 못해 계획이 없던 회차의 기록도 지운다('*'로 시작하면 회차가 아니라 주기 전체의 기록이다)
    for (const k of [...this.#loggedAt.keys()]) {
      const e = k.split(':')[0]!;
      if (!k.startsWith('*') && !live.has(e)) this.#loggedAt.delete(k);
    }
  }

  #fence(gen: number, eventId: string): void {
    if (this.#fencedGen !== gen) this.logger?.warn({ gen, eventId }, 'admission-ctrl 리더: 더 새 세대가 있어(FENCED) 이 세대의 쓰기를 멈춘다');
    this.#fencedGen = gen;
    this.metrics?.fenced();
  }

  async #activeEvents(now: number): Promise<string[]> {
    const mono = this.clock.monotonicMs();
    if (this.#events && mono - this.#events.at < CACHE_MS) return this.#events.ids;
    const ids = await this.store.activeEvents(now);
    this.#events = { at: mono, ids };
    return ids;
  }

  async #plan(eventId: string): Promise<EventPlan | null> {
    const mono = this.clock.monotonicMs();
    const hit = this.#plans.get(eventId);
    if (hit && mono - hit.at < CACHE_MS) return hit.plan;
    const plan = await this.store.schedule(eventId);
    this.#plans.set(eventId, { at: mono, plan });
    return plan;
  }
}

/** 결제사: 명령 6이 ctl에 쓴 값이 이기고, 없으면 일정 사본의 값이다. 둘 다 없으면 결제사 상한을 걸지 않는다(ADR-0226 결정 9) */
function pgOf(plan: EventPlan, ctl: Control): Pg | undefined {
  if (ctl.pgKey && ctl.pgTps) return { key: ctl.pgKey, tps: ctl.pgTps };
  if (plan.pgKey && plan.pgTps) return { key: plan.pgKey, tps: plan.pgTps };
  return undefined;
}
