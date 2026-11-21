// 스트림 작업자의 파티션별 묶음 규칙(docs/streaming.md §2.4 표와 '묶음 세부', §2.7 지표, OPS-150, BAT-220 계획 §5).
// Kafka 클라이언트와 상관없는 조각이다: 묶음 닫기(건수·첫 레코드부터의 시간), 중복 거르기 표시, 다시 시도 지연, 커밋 위치, 지표.
// 실행기(runBatchWorker, stream-worker.ts)가 이 조각으로 파티션마다 묶음 하나씩 쓰고, 쓰기가 성공한 뒤에만 '끝 오프셋 + 1'을 커밋한다.
// 오프셋은 10진수 글로 다룬다(2^53을 넘어도 잃지 않게). 크기 견주기와 더하기는 BigInt로 한다(글끼리 견주면 9 → 10이 거꾸로 선다).
import { Counter, Gauge, Histogram, type Registry } from '@prometheus-io/client';

/** 읽지 못한 레코드의 분류(docs/streaming.md §2.7 `reason`, §6.3 `brz_rejected.error_class`) */
export type RejectReason = 'DESERIALIZE' | 'UNKNOWN_SCHEMA' | 'MISSING_FIELD';

export interface BatchRecord<T> {
  topic: string;
  partition: number;
  /** 10진수 오프셋 */
  offset: string;
  /** Kafka 레코드 시각(밀리초, 10진수 글). 업무 시각은 메시지 안의 시각을 쓴다(streaming §2.6) */
  timestamp: string;
  value: T;
}

/** 읽지 못한 레코드의 위치. 원문 바이트·값은 싣지 않는다(streaming §2.4, ADR-0072 결정 7) */
export interface RejectedPosition {
  topic: string;
  partition: number;
  offset: string;
  /** Kafka 레코드 시각(밀리초, 10진수 글) */
  kafkaTs: string;
  /** 머리에서 읽은 스키마 ID. 머리가 틀려 읽지 못했으면 없음 */
  schemaId: number | null;
  reason: RejectReason;
}

export interface ClosedBatch<T> {
  topic: string;
  partition: number;
  /** 거절 레코드까지 넣은 그 묶음의 처음과 끝 오프셋 */
  firstOffset: string;
  lastOffset: string;
  /** dedupToken(topic, partition, firstOffset, lastOffset) */
  dedupToken: string;
  records: BatchRecord<T>[];
  rejected: RejectedPosition[];
}

/** 싱크. 던지면 같은 묶음(같은 레코드·같은 표시)을 다시 보낸다. table은 stream_insert_seconds의 라벨 */
export interface BatchSink<T> {
  table: string;
  write(batch: ClosedBatch<T>): Promise<void>;
}

/** 작업자 전체 동시 묶음 4개 [가정], 재조정·종료 때 처리 중 묶음을 기다리는 한도 10초 [가정](streaming §2.4) */
export const BATCH_WORKER_DEFAULTS = {
  maxInFlight: 4,
  drainTimeoutMs: 10_000,
} as const;

/** 다시 시도 지연: 0.2초에서 매번 두 배, 30초에서 멈춘다 [가정](streaming §2.4 '묶음 세부') */
const RETRY_MIN_MS = 200;
const RETRY_MAX_MS = 30_000;

const DECIMAL = /^(0|[1-9][0-9]*)$/;

const assertOffset = (offset: string, what: string): bigint => {
  if (typeof offset !== 'string' || !DECIMAL.test(offset)) throw new TypeError(`${what}은 음이 아닌 10진수 글이어야 한다: ${String(offset)}`);
  return BigInt(offset);
};

/** 중복 거르기 표시 `<토픽>:<파티션>:<첫 오프셋>:<끝 오프셋>`(10진수, streaming §2.4 '묶음 세부') */
export function dedupToken(topic: string, partition: number, firstOffset: string, lastOffset: string): string {
  assertOffset(firstOffset, '첫 오프셋');
  assertOffset(lastOffset, '끝 오프셋');
  return `${topic}:${partition}:${firstOffset}:${lastOffset}`;
}

/** attempt번째(0부터) 다시 시도 앞에 기다릴 시간(ms). 0 → 200, 1 → 400 … 30,000에서 멈춘다 */
export function retryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError(`attempt는 0 이상의 정수여야 한다: ${attempt}`);
  // 2의 거듭제곱이 끝없이 커지지 않게 상한에 닿는 횟수에서 자른다
  return attempt >= 8 ? RETRY_MAX_MS : Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt);
}

const isRejected = <T>(item: BatchRecord<T> | RejectedPosition): item is RejectedPosition => 'reason' in item;

export interface BatchPartitionOptions {
  topic: string;
  partition: number;
  /** 건수 한도(거절 레코드도 센다) */
  maxRecords: number;
  /** 첫 레코드를 받은 때부터의 시간 한도(ms) */
  maxWaitMs: number;
  /** 단조 시계(ms). 시험은 가짜 시계를 준다 */
  now?: () => number;
}

/**
 * 파티션 하나의 열린 묶음. 첫 레코드를 받은 때부터 시간 한도가 지나거나 건수 한도에 닿으면 닫혀 돌려준다.
 * 받은 순서가 곧 오프셋 순서다(실행기가 다시 배달된 오프셋을 먼저 거른다)
 */
export class BatchPartition<T> {
  readonly #now: () => number;
  #records: BatchRecord<T>[] = [];
  #rejected: RejectedPosition[] = [];
  #first: string | undefined;
  #last: string | undefined;
  #count = 0;
  #openedAt = 0;

  constructor(private readonly o: BatchPartitionOptions) {
    if (!Number.isInteger(o.maxRecords) || o.maxRecords < 1) throw new RangeError(`maxRecords는 1 이상의 정수여야 한다: ${o.maxRecords}`);
    if (!Number.isFinite(o.maxWaitMs) || o.maxWaitMs < 0) throw new RangeError(`maxWaitMs는 0 이상이어야 한다: ${o.maxWaitMs}`);
    this.#now = o.now ?? (() => performance.now());
  }

  /** 레코드나 거절 위치를 더한다. 이 레코드로 묶음이 닫히면 닫힌 묶음을 돌려준다 */
  push(item: BatchRecord<T> | RejectedPosition): ClosedBatch<T> | undefined {
    if (item.topic !== this.o.topic || item.partition !== this.o.partition) {
      throw new Error(`다른 파티션의 레코드다: ${item.topic}/${item.partition}(이 묶음은 ${this.o.topic}/${this.o.partition})`);
    }
    const at = assertOffset(item.offset, '오프셋');
    if (this.#last !== undefined && at <= BigInt(this.#last)) throw new Error(`오프셋이 앞 레코드보다 크지 않다: ${item.offset} ≤ ${this.#last}`);
    if (this.#count === 0) {
      this.#openedAt = this.#now();
      this.#first = item.offset;
    }
    this.#last = item.offset;
    this.#count += 1;
    if (isRejected(item)) this.#rejected.push(item);
    else this.#records.push(item);
    return this.#count >= this.o.maxRecords || this.#due() ? this.#close() : undefined;
  }

  /** 시간 한도가 지났으면 닫아 돌려준다(실행기가 타이머로 부른다) */
  poll(): ClosedBatch<T> | undefined {
    return this.#count > 0 && this.#due() ? this.#close() : undefined;
  }

  /** 열린 묶음이 시간으로 닫히기까지 남은 ms. 열린 묶음이 없으면 없음 */
  msUntilDue(): number | undefined {
    return this.#count === 0 ? undefined : Math.max(0, this.#openedAt + this.o.maxWaitMs - this.#now());
  }

  /** 열린 묶음의 건수(거절 포함) */
  get size(): number {
    return this.#count;
  }

  /** 열린 묶음을 버린다(넘긴 파티션: 커밋하지 않았으므로 새 주인이 다시 받는다) */
  discard(): void {
    this.#reset();
  }

  /** 그 묶음 쓰기가 성공한 뒤 커밋할 위치: 끝 오프셋 + 1 */
  static commitOffset(b: Pick<ClosedBatch<unknown>, 'lastOffset'>): string {
    return (assertOffset(b.lastOffset, '끝 오프셋') + 1n).toString();
  }

  #due(): boolean {
    return this.#now() - this.#openedAt >= this.o.maxWaitMs;
  }

  #close(): ClosedBatch<T> {
    const first = this.#first!;
    const last = this.#last!;
    const batch: ClosedBatch<T> = {
      topic: this.o.topic,
      partition: this.o.partition,
      firstOffset: first,
      lastOffset: last,
      dedupToken: dedupToken(this.o.topic, this.o.partition, first, last),
      records: this.#records,
      rejected: this.#rejected,
    };
    this.#reset();
    return batch;
  }

  #reset(): void {
    this.#records = [];
    this.#rejected = [];
    this.#first = undefined;
    this.#last = undefined;
    this.#count = 0;
  }
}

const metricsByRegistry = new WeakMap<Registry, BatchWorkerMetrics>();

/** 쓰기 시간 칸(초). 묶음 쓰기는 수십 ms~수 초다 */
const INSERT_BUCKETS_SECONDS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/** 스트림 작업자 지표 여섯(docs/streaming.md §2.7, 이름·라벨은 정본 그대로) */
export class BatchWorkerMetrics {
  /** 지표 저장소마다 하나(같은 저장소로 두 번 만들면 이름이 겹쳐 실패한다) */
  static for(registry: Registry, worker: string): BatchWorkerMetrics {
    let m = metricsByRegistry.get(registry);
    if (!m) {
      m = new BatchWorkerMetrics(registry, worker);
      metricsByRegistry.set(registry, m);
    }
    return m;
  }

  readonly consumerLag: Gauge<'worker' | 'topic' | 'partition'>;
  readonly insertSeconds: Histogram<'worker' | 'table'>;
  readonly insertRetries: Counter<'worker'>;
  readonly rejected: Counter<'worker' | 'topic' | 'reason'>;
  readonly unrecognizedSymbols: Counter<'worker' | 'topic' | 'record' | 'field'>;
  readonly pausedPartitions: Gauge<'worker'>;

  private constructor(
    registry: Registry,
    readonly worker: string,
  ) {
    const registers = [registry];
    this.consumerLag = new Gauge({ name: 'stream_consumer_lag_records', help: '파티션의 소비 밀림(높은 물표 − 다음에 읽을 오프셋)', labelNames: ['worker', 'topic', 'partition'] as const, registers });
    this.insertSeconds = new Histogram({ name: 'stream_insert_seconds', help: '묶음 쓰기 한 번의 시간(초)', labelNames: ['worker', 'table'] as const, buckets: INSERT_BUCKETS_SECONDS, registers });
    this.insertRetries = new Counter({ name: 'stream_insert_retries_total', help: '실패해 다시 보낸 묶음 쓰기 수', labelNames: ['worker'] as const, registers });
    this.rejected = new Counter({ name: 'stream_rejected_total', help: '읽지 못한 레코드 수(reason: DESERIALIZE·UNKNOWN_SCHEMA·MISSING_FIELD)', labelNames: ['worker', 'topic', 'reason'] as const, registers });
    this.unrecognizedSymbols = new Counter({ name: 'stream_unrecognized_symbol_total', help: '빌드된 계약 판에 없는 열거 기호 수', labelNames: ['worker', 'topic', 'record', 'field'] as const, registers });
    this.pausedPartitions = new Gauge({ name: 'stream_paused_partitions', help: '다시 시도로 가져오기를 멈춘 파티션 수', labelNames: ['worker'] as const, registers });
  }
}
