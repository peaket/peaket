// 셔플 커밋 공시(docs/features/queue-admission.md §2 '로비 참가와 커밋 공시의 첫 구현', ADR-0050 결정 7, ADR-0231 결정 6·7).
// 구간(로비·묶음)마다 시드를 CSPRNG로 만들어 봉인하고, SHA-256 커밋과 공시 라운드를 q:{event:E}:shuffle에 쓴다. 먼저 쓴 값 하나로 남고 바뀌지 않는다.
// 일꾼이 파드마다 5초 [가정]마다 돈다. 참가 응답이 기록을 못 찾으면 그 자리에서 만든다. 기록은 바뀌지 않으므로 파드 메모리에 둔다.
import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { commitment, drandRoundAfter, type ShuffleGroup } from '@peaket/shuffle';
import { type CommitRecord, EVENT_SCHEDULES, type EventSchedules, LOBBY_SIGNALS, type LobbySignals, noLobbySignals, SEED_SEALER, type SeedSealer, SHUFFLE_COMMIT_STORE, type ShuffleCommitStore } from '../domain/ports.js';
import { BATCH_NO, COMMIT_SWEEP_MS, commitDueAtOf, type EventSchedule, fixAtOf, keepUntilOf, QueueStoreUnavailable } from '../domain/queue.js';

/** 일꾼이 그 구간을 때가 지나고도 이만큼 못 만들었으면 늦은 공시로 센다(5초 주기 두 번 [가정]) */
const LATE_MARGIN_MS = 2 * COMMIT_SWEEP_MS;
/** 파드 메모리에 두는 시간 1초 [가정]과 개수 상한 1,024개 [가정]. Redis 기록이 정본이고, 메모리는 T=0 진입 202의 읽기만 덜어 준다 */
export const COMMIT_CACHE_MS = 1_000;
export const COMMIT_CACHE_MAX = 1_024;

@Injectable()
export class ShuffleCommits {
  readonly #cache = new Map<string, { at: number; rec: CommitRecord }>();

  constructor(
    @Inject(SHUFFLE_COMMIT_STORE) private readonly store: ShuffleCommitStore,
    @Inject(SEED_SEALER) private readonly sealer: SeedSealer,
    @Inject(EVENT_SCHEDULES) _schedules: EventSchedules,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(LOBBY_SIGNALS) private readonly signals: LobbySignals = noLobbySignals,
  ) {}

  #remember(key: string, rec: CommitRecord): void {
    this.#cache.delete(key);
    this.#cache.set(key, { at: this.clock.monotonicMs(), rec });
    while (this.#cache.size > COMMIT_CACHE_MAX) this.#cache.delete(this.#cache.keys().next().value!);
  }

  /** 기록을 읽기만 한다(없으면 null, 진입 202처럼 KMS를 부르지 않는 길). 파드 메모리에는 잠깐만 둔다 */
  async peek(eventId: string, group: ShuffleGroup): Promise<CommitRecord | null> {
    const key = `${eventId}|${group}`;
    const hit = this.#cache.get(key);
    if (hit && this.clock.monotonicMs() - hit.at < COMMIT_CACHE_MS) return hit.rec;
    const rec = await this.store.read(eventId, group);
    if (rec) this.#remember(key, rec);
    else this.#cache.delete(key);
    return rec;
  }

  /** 기록이 없으면 만든다. 시드를 봉인하지 못하면 QueueStoreUnavailable로 503이 되게 한다 */
  async ensure(eventId: string, group: ShuffleGroup, schedule: EventSchedule): Promise<CommitRecord> {
    const found = await this.peek(eventId, group);
    if (found) return found;
    const seed = randomBytes(32);
    let sealed: string;
    try {
      sealed = await this.sealer.seal(eventId, group, seed);
    } catch (err) {
      throw new QueueStoreUnavailable(err);
    }
    const commit = commitment(eventId, seed).toString('hex');
    const saved = await this.store.write(eventId, group, { commit, round: drandRoundAfter(fixAtOf(schedule, group)), sealed }, keepUntilOf(schedule));
    this.#remember(`${eventId}|${group}`, saved);
    // 이 호출이 쓴 기록일 때만 늦은 공시로 센다(공시 시각은 저장소 시각이다)
    if (saved.commit === commit && saved.atMs > commitDueAtOf(schedule) + LATE_MARGIN_MS) this.signals.commitLate();
    return saved;
  }
}

/** 공시 때가 지난 회차의 구간을 만든다. 한 구간이 실패해도 다음으로 넘어가고 다음 주기에 다시 한다 */
export class ShuffleCommitWorker {
  #timer?: NodeJS.Timeout;

  constructor(
    private readonly commits: ShuffleCommits,
    private readonly schedules: EventSchedules,
    private readonly listEvents: (nowMs: number) => Promise<string[]>,
    private readonly clock: Clock,
    private readonly logger?: PlatformLogger,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tickOnce().catch((err: unknown) => this.logger?.error({ err }, '셔플 커밋 공시 일꾼 주기 실패')), COMMIT_SWEEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async tickOnce(): Promise<void> {
    const now = this.clock.now();
    for (const eventId of await this.listEvents(now)) {
      const schedule = await this.schedules.get(eventId).catch(() => null);
      if (!schedule || now < commitDueAtOf(schedule)) continue;
      const groups: ShuffleGroup[] = [...(schedule.lobbyShuffle ? ['lobby' as const] : []), ...(schedule.openBatch ? [BATCH_NO] : [])];
      for (const group of groups) {
        try {
          await this.commits.ensure(eventId, group, schedule);
        } catch (err) {
          this.logger?.error({ err, eventId }, '셔플 커밋 공시 실패(다음 주기에 다시)');
        }
      }
    }
  }
}
