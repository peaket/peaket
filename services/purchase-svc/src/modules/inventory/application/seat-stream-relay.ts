// 좌석 Redis Stream 릴레이(BUILD_ORDER PRF-141, docs/features/seat-hold.md §6 '홀드 원장 적재의 첫 구현', docs/data.md §3 s:{event:E}:stream).
// 회차마다 Stream 항목을 Stream ID 순으로 읽어 Kafka로 보내고, 확인받은 묶음만 지운다. 리더 하나만 돌린다(조립은 PRF-160의 relay.ts).
// 묶음이 꽉 차면 한 틱 안에서 이어 읽고(회차마다 STREAM_RELAY_MAX_BATCHES 묶음까지), 상한에 닿으면 쉬지 않고 다음 틱을 돈다(코드 리뷰 2026-11-04: 초당 100항목에 묶이던 것).
// 실패하면 그 회차를 확인하지 않고 다음 틱에 다시 보낸다(적어도 한 번). 보낼 수 없는 항목은 확인해 넘기고 지표를 올린다.
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

export class SeatStreamRelay {
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

  async tick(): Promise<RelayTickReport> {
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
      for (const eventId of events) reports.push(await this.#relay(eventId));
      return { events: reports };
    } finally {
      for (const stage of this.#failed) this.deps.signals?.failed(stage);
    }
  }

  /** 회차 하나: 묶음이 꽉 차면 이어 읽는다. 한 묶음이라도 실패하면 거기서 멈추고(앞 묶음은 이미 확인받았다) 다음 틱에 다시 */
  async #relay(eventId: string): Promise<RelayEventReport> {
    const total: RelayEventReport = { eventId, sent: 0, dropped: 0, acked: 0 };
    for (let n = 0; n < STREAM_RELAY_MAX_BATCHES; n += 1) {
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
    while (!signal.aborted) {
      let failed: boolean;
      try {
        const report = await this.tick();
        failed = this.#failed.size > 0 || report.events.some((e) => e.failed !== undefined);
      } catch (err) {
        // 예상 밖 오류도 반복을 끝내지 않는다(처리되지 않은 거부로 프로세스가 죽지 않게)
        failed = true;
        this.deps.logger?.warn({ err: errorName(err) }, '좌석 Stream 릴레이: 틱이 예상 밖 오류로 끝났다');
      }
      backoff = failed ? (backoff === 0 ? STREAM_RELAY_BACKOFF_MIN_MS : Math.min(backoff * 2, STREAM_RELAY_BACKOFF_MAX_MS)) : 0;
      if (signal.aborted) break;
      await this.#sleep(backoff !== 0 ? backoff : this.#more ? 0 : STREAM_RELAY_TICK_MS, signal);
    }
  }
}

/** 오류의 이름만(메시지·값을 로그에 남기지 않는다) */
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
