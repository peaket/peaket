// Outbox 폴링 릴레이(openspec 변경 add-idempotency-and-outbox 결정 9, ADR-0116 결정 1~5, docs/data.md §4의 7번).
// - 리더(Lease)일 때만 묶음을 돈다. 묶음 하나 = 트랜잭션 하나: FOR UPDATE로 seq 순서 500행 → 보내기(모든 확인까지) → sent_at → 커밋
// - SKIP LOCKED를 쓰지 않는다. 리더가 바뀌는 순간 옛 리더가 잡은 앞 묶음을 건너뛰고 뒤 사건을 먼저 보낼 수 있어서다
// - 실패하면 되돌리고(행은 그대로) 0.1초에서 5초 [가정]까지 늘려 쉰다. 보낸 뒤 표시 전에 멈추면 같은 행이 다시 나가고 받는 쪽이 eventKey로 지운다
import { Counter, Gauge, Histogram, type Registry } from '@prometheus-io/client';
import { sql } from 'drizzle-orm';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import { LATENCY_BUCKETS_SECONDS } from './metrics.js';
import { OUTBOX_PARTITION_DEFAULTS, OUTBOX_TABLE, outboxHealth } from './outbox.js';

/** 릴레이 기본값(ADR-0116 결정 3·5, architecture §5 '시간 초과 기본값'). 수는 [가정]이고 V-T27에서 잰다 */
export const OUTBOX_RELAY_DEFAULTS = {
  batchSize: 500,
  pollMs: 100,
  backoffMinMs: 100,
  backoffMaxMs: 5_000,
  /** Kafka 보내기 상한(message.timeout.ms와 같다) */
  publishTimeoutMs: 10_000,
  statementTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 30_000,
  /** 지연·파티션 지표를 재는 주기(두 복제 모두) */
  measureEveryMs: 5_000,
} as const;

export interface OutboxRecord {
  id: string;
  /** 보내는 순서(bigint를 10진수 문자열로) */
  seq: string;
  topic: string;
  key: string;
  payload: Buffer;
  headers: Record<string, string>;
}

/**
 * 보내기 포트. 받은 순서대로 보내고, 모두 확인(acks=all)을 받은 뒤 끝난다. 같은 파티션 안 순서를 지키는 멱등 생산자로 구현한다.
 * Kafka 어댑터는 Kafka 클라이언트·필수 설정을 정하는 단계에서 만든다(BUILD_ORDER FND-090)
 */
export interface OutboxPublisher {
  publish(records: readonly OutboxRecord[], o: { signal: AbortSignal }): Promise<void>;
}

/** 리더 여부(LeaseElector가 구현한다) */
export interface LeaderState {
  isLeader(): boolean;
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * 끝나면 풀리고, signal이 끊으면 바로 풀린다(던지지 않는다). 잠이 끝나면 signal에 붙인 리스너를 뗀다
 * (반복이 오래 사는 멈춤 신호로 100ms마다 부르므로, 떼지 않으면 리스너가 쌓인다, 코드 리뷰 2026-11-01)
 */
export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const LABELS = ['service'] as const;

/** 릴레이 지표(ADR-0116 결정 5, docs/observability.md §5). 파티션 지표는 결정 8 */
export class OutboxRelayMetrics {
  readonly lag: Gauge<'service'>;
  readonly published: Counter<'service'>;
  readonly errors: Counter<'service'>;
  readonly batch: Histogram<'service'>;
  readonly isLeader: Gauge<'service'>;
  readonly partitionsAhead: Gauge<'service'>;
  readonly partitionsOverdue: Gauge<'service'>;

  constructor(
    registry: Registry,
    readonly service: string,
  ) {
    const registers = [registry];
    this.lag = new Gauge({ name: 'outbox_relay_lag_seconds', help: '가장 오래 기다린 보내지 않은 Outbox 행의 나이(초). 두 복제가 5초마다 DB에서 잰다', labelNames: LABELS, registers });
    this.published = new Counter({ name: 'outbox_relay_published_total', help: '보내고 표시한 Outbox 행 수', labelNames: LABELS, registers });
    this.errors = new Counter({ name: 'outbox_relay_errors_total', help: '실패해 되돌린 릴레이 묶음 수', labelNames: LABELS, registers });
    this.batch = new Histogram({ name: 'outbox_relay_batch_seconds', help: '행이 있던 릴레이 묶음 하나의 처리 시간(초). 칸은 표준 목록', labelNames: LABELS, buckets: [...LATENCY_BUCKETS_SECONDS], registers });
    this.isLeader = new Gauge({ name: 'outbox_relay_is_leader', help: '이 복제가 Lease를 쥔 리더면 1', labelNames: LABELS, registers });
    this.partitionsAhead = new Gauge({ name: 'outbox_partitions_ahead_days', help: '내일부터 이어서 미리 만든 Outbox 일 파티션 수(3 [가정]보다 적으면 SEV2 hygiene)', labelNames: LABELS, registers });
    this.partitionsOverdue = new Gauge({ name: 'outbox_partitions_overdue', help: '지울 날에서 하루 더 지나도 남은 Outbox 파티션 수(0보다 크면 SEV2)', labelNames: LABELS, registers });
  }
}

export interface OutboxRelayOptions {
  database: Database;
  publisher: OutboxPublisher;
  leader: LeaderState;
  clock: Clock;
  metrics: OutboxRelayMetrics;
  /** 기다림(시험에서 바꿔 끼운다). 기본 setTimeout */
  sleep?: Sleep;
  /** 실패를 남길 곳(기본 없음) */
  onError?: (err: unknown) => void;
  batchSize?: number;
  pollMs?: number;
  keepDays?: number;
}

export class OutboxRelay {
  private readonly o: Required<Omit<OutboxRelayOptions, 'onError'>> & Pick<OutboxRelayOptions, 'onError'>;
  private stopper?: AbortController;
  private loops?: Promise<unknown>;

  constructor(o: OutboxRelayOptions) {
    this.o = { sleep: realSleep, batchSize: OUTBOX_RELAY_DEFAULTS.batchSize, pollMs: OUTBOX_RELAY_DEFAULTS.pollMs, keepDays: OUTBOX_PARTITION_DEFAULTS.keepDays, ...o };
  }

  private get label() {
    return { service: this.o.metrics.service };
  }

  /** 묶음 하나(리더인지는 부르는 쪽이 본다). 보낸 행 수를 돌려준다. 실패하면 되돌리고 던진다 */
  async relayOnce(signal?: AbortSignal): Promise<number> {
    const { database, clock, batchSize } = this.o;
    return database.transaction(async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', ${String(OUTBOX_RELAY_DEFAULTS.statementTimeoutMs)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(OUTBOX_RELAY_DEFAULTS.idleInTransactionTimeoutMs)}, true)`);
      // SKIP LOCKED 없이: 다른 릴레이가 잡은 앞 행은 그 트랜잭션이 끝날 때까지 기다렸다가 조건(sent_at IS NULL)을 다시 본다
      const rows = (
        await tx.execute(sql`
          select id::text as id, seq::text as seq, topic, msg_key, payload, headers
          from ${sql.identifier(OUTBOX_TABLE)} where sent_at is null order by seq limit ${batchSize} for update`)
      ).rows as { id: string; seq: string; topic: string; msg_key: string; payload: Buffer; headers: Record<string, string> | null }[];
      if (rows.length === 0) return 0;
      const records: OutboxRecord[] = rows.map((r) => ({ id: r.id, seq: r.seq, topic: r.topic, key: r.msg_key, payload: r.payload, headers: r.headers ?? {} }));
      await this.publishWithin(records, signal);
      await tx.execute(sql`update ${sql.identifier(OUTBOX_TABLE)} set sent_at = ${new Date(clock.now())} where id = any(${`{${records.map((r) => r.id).join(",")}}`}::uuid[])`);
      return rows.length;
    });
  }

  /** 보내기 상한(10초 [가정]) 안에 끝나지 않으면 던진다(트랜잭션이 되돌아간다) */
  private async publishWithin(records: readonly OutboxRecord[], signal?: AbortSignal): Promise<void> {
    const done = new AbortController();
    const signals = signal ? [done.signal, signal] : [done.signal];
    const sending = this.o.publisher.publish(records, { signal: AbortSignal.any(signals) });
    sending.catch(() => {});
    const timedOut = this.o.sleep(OUTBOX_RELAY_DEFAULTS.publishTimeoutMs, done.signal).then(() => {
      if (!done.signal.aborted) throw new Error(`Outbox 보내기가 ${OUTBOX_RELAY_DEFAULTS.publishTimeoutMs}ms 안에 끝나지 않았다`);
    });
    try {
      await Promise.race([sending, timedOut]);
    } finally {
      done.abort();
    }
  }

  /** 지연·파티션·리더 지표를 잰다(리더가 아니어도) */
  async measure(): Promise<void> {
    const h = await outboxHealth(this.o.database, this.o.clock, { keepDays: this.o.keepDays });
    const m = this.o.metrics;
    m.lag.set(this.label, h.lagSeconds);
    m.partitionsAhead.set(this.label, h.aheadDays);
    m.partitionsOverdue.set(this.label, h.overdue);
    m.isLeader.set(this.label, this.o.leader.isLeader() ? 1 : 0);
  }

  /** 보내는 반복. signal이 끊을 때까지 돈다 */
  async runLoop(signal: AbortSignal): Promise<void> {
    const { clock, metrics, sleep, pollMs, batchSize } = this.o;
    let backoff = 0;
    while (!signal.aborted) {
      if (!this.o.leader.isLeader()) {
        await sleep(pollMs, signal);
        continue;
      }
      const started = clock.monotonicMs();
      try {
        const n = await this.relayOnce(signal);
        if (n > 0) {
          metrics.published.inc(this.label, n);
          metrics.batch.observe(this.label, (clock.monotonicMs() - started) / 1000);
        }
        backoff = 0;
        // 꽉 찬 묶음 뒤에는 밀린 행이 더 있으므로 쉬지 않는다
        if (n < batchSize) await sleep(pollMs, signal);
      } catch (err) {
        metrics.errors.inc(this.label);
        this.o.onError?.(err);
        backoff = backoff === 0 ? OUTBOX_RELAY_DEFAULTS.backoffMinMs : Math.min(backoff * 2, OUTBOX_RELAY_DEFAULTS.backoffMaxMs);
        await sleep(backoff, signal);
      }
    }
  }

  /** 재는 반복(5초마다) */
  async measureLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.measure();
      } catch (err) {
        this.o.onError?.(err);
      }
      await this.o.sleep(OUTBOX_RELAY_DEFAULTS.measureEveryMs, signal);
    }
  }

  start(): void {
    if (this.stopper) return;
    this.stopper = new AbortController();
    this.loops = Promise.all([this.runLoop(this.stopper.signal), this.measureLoop(this.stopper.signal)]);
  }

  async stop(): Promise<void> {
    this.stopper?.abort();
    await this.loops;
    this.stopper = undefined;
  }
}
