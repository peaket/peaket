// admission-ctrl 리더 루프(docs/features/queue-admission.md §5, FR-037, ADR-0056 결정 3, ADR-0182).
// 200ms마다: Lease 세대가 있으면 진행 중인 회차마다 (처음이면) 세대부터 올리고, 리더 상태를 읽어 전진하고, 필요하면 로비·묶음을 닫고 게시를 부른다.
// FENCED를 받으면 그 세대로는 더 쓰지 않는다(Lease가 새 세대를 줄 때까지). 저장소의 Lua가 쓰기를 세대로 막으므로 이 파일은 순서만 맡는다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { BatchMembersChanged } from '../../batch/index.js';
import {
  ARRIVAL_WINDOW_MS,
  closeAtOf,
  DEFAULT_TARGET,
  INITIAL_SALE_STATE,
  keepUntilOf,
  MAX_ADVANCE_PER_TICK,
  PRE_OPEN_MS,
  RATIO_FLOOR,
  RB05_CHECK_MS,
  RB05_SKIP_BASE,
  saleEndOf,
  TICK_MS,
} from '../domain/plan.js';
import { ELECTOR, type Elector, type EventPlan, LEADER_STORE, type LeaderStore, PUBLISHER, type Publisher } from '../domain/ports.js';
import { LEADER_METRICS, type LeaderMetrics } from './leader-metrics.js';

/** 회차 목록·일정 사본을 파드 메모리에 두는 시간 1초 [가정](queue-svc 일정 캐시와 같다) */
const CACHE_MS = 1_000;
/** 같은 회차의 같은 실패를 남기는 간격 10초 [가정](200ms 주기마다 같은 줄이 쌓이지 않게) */
const ERROR_LOG_EVERY_MS = 10_000;
/** 멈출 때 뒤에서 도는 게시를 기다리는 한도 10초 [가정](Lease를 놓기 전에 쓰기를 멈춘다, ADR-0056 결정 3) */
const STOP_WAIT_MS = 10_000;
/** 회차 판매 상태(ADR-0122). ON_SALE만 전진한다 */
const KNOWN_SALE_STATES = new Set(['UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED']);

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
  /** 뒤에서 도는 게시(회차마다 하나) */
  readonly #publishing = new Map<string, Promise<void>>();
  /** 회차마다 하나씩 뒤에서 도는 RB-05 복제 확인(WAIT가 0.5초까지 걸려 다른 회차의 전진을 막지 않게, ADR-0186) */
  readonly #confirming = new Map<string, Promise<void>>();

  constructor(
    @Inject(LEADER_STORE) private readonly store: LeaderStore,
    @Inject(PUBLISHER) private readonly publish: Publisher,
    @Inject(ELECTOR) private readonly elector: Elector,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
    @Optional() @Inject(LEADER_METRICS) private readonly metrics?: LeaderMetrics,
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
      }
      const now = this.clock.now();
      const ids = await this.#activeEvents(now);
      this.#forgetEnded(ids);
      await Promise.all(ids.map((e) => this.#event(e, gen, now)));
    } catch (err) {
      this.#logError('*', this.clock.now(), err, 'admission-ctrl 리더 주기 실패');
    } finally {
      this.metrics?.loop((this.clock.monotonicMs() - started) / 1000);
      this.#busy = false;
    }
  }

  async #event(eventId: string, gen: number, now: number): Promise<void> {
    try {
      const plan = await this.#plan(eventId);
      if (!plan || now < plan.opensAtMs - PRE_OPEN_MS || now >= saleEndOf(plan)) return;
      const keepUntilMs = keepUntilOf(plan);
      // 교체 순서: 세대부터 올린다(ADR-0056 결정 3)
      if (!this.#bumped.events.has(eventId)) {
        if ((await this.store.bump(eventId, gen, keepUntilMs)) === 'FENCED') return this.#fence(gen, eventId);
        this.#bumped.events.add(eventId);
      }
      if (now < plan.opensAtMs) return;
      if (this.#fencedGen === gen) return;
      const ctl = await this.store.control(eventId, now);
      const closeAtMs = closeAtOf(plan);
      const r = await this.store.tick({
        eventId,
        gen,
        target: ctl.target ?? DEFAULT_TARGET,
        ratioFloor: RATIO_FLOOR,
        saleStateFallback: this.#saleStates.get(eventId) ?? INITIAL_SALE_STATE,
        windowMs: ARRIVAL_WINDOW_MS,
        maxAdvance: ctl.paused ? 0 : MAX_ADVANCE_PER_TICK,
        keepUntilMs,
        saleEndMs: saleEndOf(plan),
        lobbyShuffle: plan.lobbyShuffle,
        openBatch: plan.openBatch,
        closeAtMs,
      });
      if (r.kind === 'FENCED') return this.#fence(gen, eventId);
      this.#saleStates.set(eventId, r.saleState);
      // 모르는 판매 상태는 전진 0이 된다. 조용히 멈추지 않게 남긴다
      if (!KNOWN_SALE_STATES.has(r.saleState)) this.#logError(`${eventId}:state`, now, undefined, `모르는 판매 상태(${r.saleState})라 전진하지 않는다`);
      this.metrics?.event(eventId, r);
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
      if (plan.openBatch && r.batchMarked === 1 && (r.batchPublished === 0 || r.repair === 1) && !this.#stopped.has(eventId) && !this.#publishing.has(eventId)) {
        if (this.elector.generation() !== gen || this.#fencedGen === gen) return;
        this.#publishing.set(eventId, this.#publish(eventId).finally(() => this.#publishing.delete(eventId)));
      }
    } catch (err) {
      this.#logError(eventId, now, err, 'admission-ctrl 리더: 회차 주기 실패(같은 회차는 10초에 한 번 남긴다)');
    }
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

  async #publish(eventId: string): Promise<void> {
    try {
      const r = await this.publish.run({ eventId });
      this.metrics?.publish(r.status);
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
      // 다시 오면 세대부터 다시 올린다
      this.#bumped.events.delete(e);
      this.metrics?.forget(e);
    }
    // 일정을 읽지 못해 계획이 없던 회차의 기록도 지운다('*'는 주기 전체)
    for (const k of [...this.#loggedAt.keys()]) {
      const e = k.split(':')[0]!;
      if (k !== '*' && !live.has(e)) this.#loggedAt.delete(k);
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
