// 대기 상태 파일을 만들고 내준다(docs/features/queue-admission.md §4 '대기 상태 파일의 첫 구현', ADR-0110).
// 파드마다 만든다. 회차는 처음 물을 때 켜고, 마지막 요청 뒤 ACTIVE_FOR_MS 동안 매초 경계에 그 회차의 모든 구간 파일을 다시 만든다.
// 요청은 미리 만든 파일을 내줄 뿐 대기열 Redis를 부르지 않는다(켤 때 한 번만 부른다).
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { type EventSchedule, type EventSchedules, QueueStoreUnavailable } from '../../entry/index.js';
import { STATE_OPTIONS, STATE_SCHEDULES, STATE_SNAPSHOTS, type StateOptions, type StateSnapshots } from '../domain/ports.js';
import { ACTIVE_FOR_MS, boundaryOf, buildStateFiles, MAX_ACTIVE_EVENTS, type PlatformNotice, type StateFile, TICK_CONCURRENCY } from '../domain/state.js';

interface Active {
  schedule: EventSchedule;
  askedAt: number;
  files: StateFile[];
}

/** 켤 때 처음 만들지 못했다(일정 사본이나 회차 슬롯을 대기열 Redis에서 못 읽음). 받는 층이 503 Retry-After 1초로 답한다 */
export class StateUnavailable extends Error {
  constructor(cause?: unknown) {
    super('대기 상태 파일을 아직 만들지 못했다', { cause });
    this.name = 'StateUnavailable';
  }
}

/** 다음에 돌 초 경계. 타이머가 경계보다 조금 일찍 깨도 앞서 돈 경계를 다시 돌지 않는다 */
export function nextBoundary(now: number, previous: number | undefined): number {
  return Math.max(boundaryOf(now) + 1000, previous === undefined ? -Infinity : previous + 1000);
}

@Injectable()
export class StateFiles implements OnModuleInit, OnModuleDestroy {
  /** 켠 회차(넣은 순서 = 마지막으로 물은 순서. 상한을 넘으면 가장 오래 묻지 않은 회차부터 끈다). 일정 사본을 확인한 회차만 들어온다 */
  readonly #active = new Map<string, Active>();
  /** 켜는 중인 회차. 같은 회차의 요청이 몰려도 이것 하나를 함께 기다린다(사본이 없으면 null). 켠 목록과 따로 둬 확인 전의 무작위 회차 ID가 진짜 회차를 밀어내지 않게 한다 */
  readonly #pending = new Map<string, Promise<Active | null>>();
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;
  #lastBoundary: number | undefined;
  /** 마지막으로 읽은 전체 범위 공지(못 읽으면 이 값으로 만든다, ADR-0214) */
  #platform: PlatformNotice = {};

  constructor(
    @Inject(STATE_SNAPSHOTS) private readonly snapshots: StateSnapshots,
    @Inject(STATE_SCHEDULES) private readonly schedules: EventSchedules,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STATE_OPTIONS) private readonly options: StateOptions,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {}

  onModuleInit(): void {
    if (this.options.autoTick) this.#schedule();
  }

  onModuleDestroy(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** 구간 파일. 일정 사본이 없는 회차와 만든 구간보다 뒤 구간은 null */
  async file(eventId: string, segment: number): Promise<StateFile | null> {
    let a = this.#active.get(eventId);
    if (!a) {
      let p = this.#pending.get(eventId);
      if (!p) {
        p = this.#activate(eventId);
        this.#pending.set(eventId, p);
        void p.then(
          () => this.#pending.delete(eventId),
          () => this.#pending.delete(eventId),
        );
      }
      a = (await p) ?? undefined;
      if (!a) return null;
    }
    a.askedAt = this.clock.now();
    this.#active.delete(eventId);
    this.#active.set(eventId, a);
    while (this.#active.size > MAX_ACTIVE_EVENTS) this.#active.delete(this.#active.keys().next().value!);
    return a.files[segment] ?? null;
  }

  /** 일정 사본을 읽고, 있으면 처음 만들어 켠 목록에 넣는다. 생성 시각은 대기열 Redis를 읽기 바로 전의 초 경계다 */
  async #activate(eventId: string): Promise<Active | null> {
    try {
      // 사본이 없는 회차는 켜지 않는다(형식만 맞는 무작위 회차 ID로 파드 메모리를 키우지 못하게)
      const schedule = await this.schedules.get(eventId);
      if (!schedule) return null;
      const boundaryMs = boundaryOf(this.clock.now());
      const platform = await this.#readPlatform();
      const files = buildStateFiles(await this.snapshots.read(eventId), schedule, boundaryMs, platform, eventId);
      const a: Active = { schedule, askedAt: this.clock.now(), files };
      this.#active.set(eventId, a);
      return a;
    } catch (err) {
      throw new StateUnavailable(err);
    }
  }

  /** 매초 경계: 켠 회차의 파일을 함께(TICK_CONCURRENCY개씩) 다시 만들고 오래 묻지 않은 회차를 끈다.
   * 회차 하나가 실패해도(일시 장애든 키 형이 틀린 버그든) 던지지 않고 앞 파일을 그대로 두며, 버그는 기록으로 남긴다 */
  async tick(boundaryMs: number): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const work: [string, Active][] = [];
      for (const [eventId, a] of [...this.#active]) {
        if (boundaryMs - a.askedAt > ACTIVE_FOR_MS) this.#active.delete(eventId);
        else work.push([eventId, a]);
      }
      const platform = work.length > 0 ? await this.#readPlatform() : this.#platform;
      let next = 0;
      const lane = async () => {
        while (next < work.length) {
          const [eventId, a] = work[next++]!;
          try {
            const schedule = await this.schedules.get(eventId).catch(() => a.schedule);
            if (schedule) a.schedule = schedule;
            const files = buildStateFiles(await this.snapshots.read(eventId), a.schedule, boundaryMs, platform, eventId);
            // 늦게 끝난 생성이 그 사이 만든 더 새 파일을 덮지 않게 한다
            if (a.files[0]!.generatedAtMs < boundaryMs) a.files = files;
          } catch (err) {
            if (!(err instanceof QueueStoreUnavailable)) this.logger?.error({ err, eventId }, '대기 상태 파일을 다시 만들지 못했다');
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(TICK_CONCURRENCY, work.length) }, lane));
    } finally {
      this.#ticking = false;
    }
  }

  /** 전체 범위 공지를 읽는다. 못 읽으면 마지막 값을 쓴다(일시 장애가 아닌 오류는 남긴다) */
  async #readPlatform(): Promise<PlatformNotice> {
    try {
      this.#platform = await this.snapshots.readPlatform();
    } catch (err) {
      if (!(err instanceof QueueStoreUnavailable)) this.logger?.error({ err }, '전체 범위 공지를 읽지 못했다');
    }
    return this.#platform;
  }

  activeForTest(): number {
    return this.#active.size;
  }

  /** 다음 초 경계에 맞춰 돈다(앞 tick이 1초를 넘기면 그 경계는 건너뛴다) */
  #schedule(): void {
    const now = this.clock.now();
    const next = nextBoundary(now, this.#lastBoundary);
    this.#timer = setTimeout(() => {
      this.#lastBoundary = next;
      void this.tick(next)
        .catch((err: unknown) => this.logger?.error({ err }, '대기 상태 파일 매초 생성 실패'))
        .finally(() => {
          if (this.#timer !== undefined) this.#schedule();
        });
    }, next - now);
    this.#timer.unref();
  }
}
