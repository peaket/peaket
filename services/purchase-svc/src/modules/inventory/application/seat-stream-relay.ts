// 좌석 Redis Stream 릴레이(BUILD_ORDER PRF-141, docs/features/seat-hold.md §6 '홀드 원장 적재의 첫 구현', docs/data.md §3 s:{event:E}:stream).
// 회차마다 Stream 항목을 Stream ID 순으로 읽어 Kafka로 보내고, 확인받은 묶음만 지운다. 리더 하나만 돌린다(조립은 PRF-164의 relay-app.ts·relay.ts, 반복이 deps.leader로 틱마다 리더를 본다).
// 묶음이 꽉 차면 한 틱 안에서 이어 읽고(회차마다 STREAM_RELAY_MAX_BATCHES 묶음까지), 상한에 닿으면 쉬지 않고 다음 틱을 돈다(코드 리뷰 2026-11-04: 초당 100항목에 묶이던 것).
// 실패하면 그 회차를 확인하지 않고 다음 틱에 다시 보낸다(적어도 한 번). 보낼 수 없는 항목은 확인해 넘기고 지표를 올린다.
// 반복(start)이 부른 틱은 회차 사이·묶음 사이마다 리더 확인과 멈춤 신호를 다시 보고, 리더가 아니거나 멈추면 그 틱을 끝낸다(보낸 묶음은 확인·지움까지 마친다,
// 보내기 중간에 끊지 않는다). 그래서 옛 리더와 새 리더가 함께 보내는 것은 묶음 하나와 그 보내기 시간까지다(PRF-164 리뷰 고침 M2, docs/data.md §5 '릴레이 리더 넘김').
import type { SeatStreamRelaySignals, SeatStreamSource, TradeEventCodec, TradeEventPublisher, TradeRecord } from '../domain/ports.js';
import {
  routeStreamEntry,
  STREAM_RELAY_BACKOFF_MAX_MS,
  STREAM_RELAY_BACKOFF_MIN_MS,
  STREAM_RELAY_BATCH,
  STREAM_RELAY_MAX_BATCHES,
  STREAM_RELAY_TICK_MS,
  type SeatStreamEntry,
  type StreamDropReason,
  type TradeTopic,
} from '../domain/seat-event.js';

export interface SeatStreamRelayLogger {
  warn(obj: object, msg: string): void;
}

export interface SeatStreamRelayDeps {
  source: SeatStreamSource;
  publisher: TradeEventPublisher;
  codec: TradeEventCodec;
  signals?: SeatStreamRelaySignals;
  logger?: SeatStreamRelayLogger;
  /** 회차마다 한 번에 읽는 항목 수(기본 STREAM_RELAY_BATCH) */
  batch?: number;
  /** 시험이 바꾸는 쉬기(기본 setTimeout). 틱 사이와 실패 뒤 늘려 쉬기에 쓴다 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * 리더 확인(BUILD_ORDER PRF-164, 릴레이 프로세스의 LeaderLoopContext.leader). 있으면 반복(start)이 틱마다 리더가 아니면 tick()을 부르지 않고
   * STREAM_RELAY_TICK_MS 쉰다(늘려 쉬기도 0으로 돌린다). 반복이 부른 틱 안에서도 회차 사이·묶음 사이마다 다시 보고 리더가 아니면 그 틱을 끝낸다(리뷰 고침 M2).
   * 직접 부르는 tick()은 리더를 보지 않는다(시험·도구용). 없으면 지금처럼 늘 돈다(멈춤 신호는 그래도 본다)
   */
  leader?: { isLeader(): boolean };
}

/**
 * 반복(#run)이 tick에 넘기는 내부 인자(리뷰 고침 M2). 있으면 회차 사이·묶음 사이마다 signal과 리더 확인(deps.leader가 있을 때)을 다시 보고,
 * 멈췄거나 리더가 아니면 그 틱을 끝낸다. 직접 부를 때는 넘기지 않는다(그때는 리더를 보지 않는다)
 */
export interface SeatStreamTickGuard {
  signal: AbortSignal;
}

/** 회차 하나의 한 틱 결과 */
export interface RelayEventReport {
  eventId: string;
  /** 보내고 확인받은 항목 수(넘긴 항목 포함 확인한 수는 acked) */
  sent: number;
  dropped: number;
  acked: number;
  /** 실패한 단계(없으면 성공) */
  failed?: 'read' | 'publish' | 'ack';
}

export interface RelayTickReport {
  events: RelayEventReport[];
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * 좌석 Stream 릴레이. 플랫폼 LeaderLoop 모양(name·start·stop)을 맞춘다(플랫폼 형을 가져오지 않고 모양만, BUILD_ORDER PRF-164):
 * 릴레이 프로세스의 leaderLoops가 그대로 돌린다
 */
export class SeatStreamRelay {
  /** 리더 반복 이름(LeaderLoop.name) */
  readonly name = 'seat-stream-relay';
  readonly #batch: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;
  /** 이번 틱에 실패한 단계(지표는 틱마다 단계당 한 번) */
  #failed = new Set<'read' | 'publish' | 'ack'>();
  /** 이번 틱에 묶음 상한에 닿아 밀린 항목이 남은 회차가 있었나(있으면 쉬지 않는다) */
  #more = false;

  constructor(private readonly deps: SeatStreamRelayDeps) {
    this.#batch = deps.batch ?? STREAM_RELAY_BATCH;
    this.#sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * 한 번 돈다: 회차 목록 → 회차마다 묶음을 읽어 보내고 확인한다.
   * @param guard 반복(#run)이 넘기는 내부 인자(SeatStreamTickGuard). 있으면 회차 사이·묶음 사이마다 멈춤 신호와 리더를 다시 보고, 멈췄거나 리더가 아니면
   *   남은 회차·묶음을 보지 않고 그때까지의 보고를 돌려준다(돌던 묶음은 확인까지 마친다). 직접 부를 때는 넘기지 않는다(리더를 보지 않는다)
   */
  async tick(guard?: SeatStreamTickGuard): Promise<RelayTickReport> {
    this.#failed = new Set();
    this.#more = false;
    try {
      let events: string[];
      try {
        events = await this.deps.source.events();
      } catch (err) {
        this.#failed.add('read');
        this.deps.logger?.warn({ err: errorName(err) }, '좌석 Stream 릴레이: 회차 목록을 읽지 못했다');
        return { events: [] };
      }
      const reports: RelayEventReport[] = [];
      for (const eventId of events) {
        if (!this.#mayContinue(guard)) break;
        reports.push(await this.#relay(eventId, guard));
      }
      return { events: reports };
    } finally {
      for (const stage of this.#failed) this.deps.signals?.failed(stage);
    }
  }

  /**
   * 회차 하나: 묶음이 꽉 차면 이어 읽는다. 한 묶음이라도 실패하면 거기서 멈추고(앞 묶음은 이미 확인받았다) 다음 틱에 다시.
   * guard가 있으면 둘째 묶음부터 읽기 전마다 멈춤 신호·리더를 다시 본다(첫 묶음 앞은 tick의 회차 사이 확인이 본다)
   */
  async #relay(eventId: string, guard: SeatStreamTickGuard | undefined): Promise<RelayEventReport> {
    const total: RelayEventReport = { eventId, sent: 0, dropped: 0, acked: 0 };
    for (let n = 0; n < STREAM_RELAY_MAX_BATCHES; n += 1) {
      if (n > 0 && !this.#mayContinue(guard)) return total;
      const r = await this.#relayBatch(eventId);
      total.sent += r.sent;
      total.dropped += r.dropped;
      total.acked += r.acked;
      if (r.failed !== undefined) return { ...total, failed: r.failed };
      if (r.read < this.#batch) return total;
    }
    this.#more = true;
    return total;
  }

  /** 반복이 부른 틱이 다음 회차·묶음으로 가도 되나: 멈춤 신호가 없고, 리더 확인이 있으면 리더다(확인이 던지면 리더가 아니다). guard가 없으면(직접 부름) 늘 참 */
  #mayContinue(guard: SeatStreamTickGuard | undefined): boolean {
    if (!guard) return true;
    if (guard.signal.aborted) return false;
    return this.deps.leader === undefined || this.#isLeader();
  }

  async #relayBatch(eventId: string): Promise<{ read: number; sent: number; dropped: number; acked: number; failed?: 'read' | 'publish' | 'ack' }> {
    const { source, publisher, codec, signals, logger } = this.deps;
    let entries: SeatStreamEntry[];
    try {
      entries = await source.read(eventId, this.#batch);
    } catch (err) {
      this.#failed.add('read');
      logger?.warn({ eventId, err: errorName(err) }, '좌석 Stream 릴레이: Stream을 읽지 못했다');
      return { read: 0, sent: 0, dropped: 0, acked: 0, failed: 'read' };
    }
    if (entries.length === 0) return { read: 0, sent: 0, dropped: 0, acked: 0 };
    const records: TradeRecord[] = [];
    const drops: { id: string; type: string | undefined; reason: StreamDropReason }[] = [];
    for (const entry of entries) {
      const route = routeStreamEntry(eventId, entry);
      if (route.kind === 'drop') {
        drops.push({ id: entry.id, type: entry.fields.type, reason: route.reason });
        continue;
      }
      let value: Buffer;
      try {
        value = codec.encode(route.topic, route.message);
      } catch {
        // 부호기가 받지 못하는 값(Avro 스키마와 안 맞음 등)은 다시 해도 같아 넘긴다. 넘기지 않으면 같은 항목에서 영원히 막힌다
        drops.push({ id: entry.id, type: entry.fields.type, reason: 'malformed' });
        continue;
      }
      records.push({ topic: route.topic, key: eventId, value, headers: {} });
    }
    if (records.length > 0) {
      try {
        await publisher.publish(records);
      } catch (err) {
        this.#failed.add('publish');
        logger?.warn({ eventId, err: errorName(err) }, '좌석 Stream 릴레이: Kafka로 보내지 못했다(다음 틱에 다시 보낸다)');
        return { read: entries.length, sent: 0, dropped: drops.length, acked: 0, failed: 'publish' };
      }
    }
    try {
      await source.ack(eventId, entries.map((e) => e.id));
    } catch (err) {
      this.#failed.add('ack');
      logger?.warn({ eventId, err: errorName(err) }, '좌석 Stream 릴레이: 보낸 항목을 지우지 못했다(다음 틱에 다시 보낸다)');
      return { read: entries.length, sent: records.length, dropped: drops.length, acked: 0, failed: 'ack' };
    }
    // 지표와 넘긴 항목의 경고는 확인한 뒤에 한 번만(다시 읽은 항목을 두 번 세지 않는다)
    const perTopic = new Map<TradeTopic, number>();
    for (const r of records) perTopic.set(r.topic, (perTopic.get(r.topic) ?? 0) + 1);
    for (const [topic, n] of perTopic) signals?.sent(topic, n);
    for (const d of drops) {
      signals?.dropped(d.reason);
      logger?.warn({ eventId, entryId: d.id, type: d.type, reason: d.reason }, '좌석 Stream 항목을 보낼 수 없어 확인하고 넘겼다');
    }
    return { read: entries.length, sent: records.length, dropped: drops.length, acked: entries.length };
  }

  start(): void {
    if (this.#abort) return;
    const ac = new AbortController();
    this.#abort = ac;
    this.#loop = this.#run(ac.signal);
  }

  async stop(): Promise<void> {
    const ac = this.#abort;
    if (!ac) return;
    ac.abort();
    await this.#loop;
    this.#abort = undefined;
    this.#loop = undefined;
  }

  async #run(signal: AbortSignal): Promise<void> {
    let backoff = 0;
    const guard: SeatStreamTickGuard = { signal };
    while (!signal.aborted) {
      // 리더가 아니면 회차 목록도 읽지 않고 한 틱 쉰다(늘려 쉬기도 0으로: 다시 리더가 되면 처음 실패부터 0.2초다). 틱마다 다시 본다
      if (this.deps.leader && !this.#isLeader()) {
        backoff = 0;
        await this.#pause(STREAM_RELAY_TICK_MS, signal);
        continue;
      }
      let failed: boolean;
      try {
        // 틱 안에서도 회차 사이·묶음 사이마다 리더·멈춤 신호를 다시 본다(리뷰 고침 M2)
        const report = await this.tick(guard);
        failed = this.#failed.size > 0 || report.events.some((e) => e.failed !== undefined);
      } catch (err) {
        // 예상 밖 오류도 반복을 끝내지 않는다(처리되지 않은 거부로 프로세스가 죽지 않게)
        failed = true;
        this.deps.logger?.warn({ err: errorName(err) }, '좌석 Stream 릴레이: 틱이 예상 밖 오류로 끝났다');
      }
      backoff = failed ? (backoff === 0 ? STREAM_RELAY_BACKOFF_MIN_MS : Math.min(backoff * 2, STREAM_RELAY_BACKOFF_MAX_MS)) : 0;
      if (signal.aborted) break;
      await this.#pause(backoff !== 0 ? backoff : this.#more ? 0 : STREAM_RELAY_TICK_MS, signal);
    }
  }

  /** 쉬기. 바꿔 끼운 쉬기가 던져도 반복을 거부로 끝내지 않는다(삼킨다, 리뷰 고침 L8. SeatRebuildLoop와 같다). 멈춤 신호는 반복 조건이 본다 */
  async #pause(ms: number, signal: AbortSignal): Promise<void> {
    try {
      await this.#sleep(ms, signal);
    } catch {
      // 기본 쉬기(setTimeout)는 던지지 않는다
    }
  }

  /**
   * 리더 확인. 구현에서 정한 것: 확인이 던지면 리더가 아닌 것으로 본다(확실하지 않으면 보내지 않는다. 두 파드가 같은 소비자 이름으로 읽으면 순서가 깨진다)
   * 경고 한 줄을 남긴다
   */
  #isLeader(): boolean {
    try {
      return this.deps.leader?.isLeader() === true;
    } catch (err) {
      this.deps.logger?.warn({ err: errorName(err) }, '좌석 Stream 릴레이: 리더 확인이 던져 이 틱을 건너뛴다');
      return false;
    }
  }
}

/** 오류의 이름만(메시지·값을 로그에 남기지 않는다) */
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
