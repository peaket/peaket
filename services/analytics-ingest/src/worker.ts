// analytics-ingest 작업자(docs/streaming.md §1·§2·§6, docs/features/analytics.md §3.1, OPS-200·OPS-205, F-04-3).
// 거래·제어 클러스터 토픽 일곱과 텔레메트리 클러스터 토픽 셋을 묶음 실행기 둘로 읽어 브론즈에 싣는다(집계 없음, 쓰기 뒤 커밋).
// investigation.requests는 구독하지 않는다(analytics §3.1 '조사용 요청 신호는 읽지 않는다', A-T22). telemetry.behavior·rum도 싣지 않는다.
// 다시 적재(§6 '다시 적재', RB-34): backfill이면 운영 그룹과 다른 버리는 그룹으로 가장 이른 곳부터 읽고, 중복 거르기 표시 앞에 끝말을 붙인다.
import type { Registry } from '@prometheus-io/client';
import { avroSchemas, localSchemaIds } from '@peaket/contracts/avro';
import type { ConsumedMessage, KafkaAuth } from '@peaket/platform';
import { UnknownSchemaError, createAvroReader, runBatchWorker, type BatchWorkerRun, type DecodeOutcome, type SchemaSource } from '@peaket/platform/stream-worker';
import { BronzeSink, type BronzeSignals, type DecodedEvent } from './bronze-sink.js';
import type { ClickHouseHttp } from './clickhouse.js';
import type { EventPseudonymizer } from './pseudonym.js';

export const ANALYTICS_INGEST_WORKER = 'analytics-ingest';
/** 거래·제어 클러스터(analytics §3.1 표의 7개) */
export const TRADE_TOPICS = ['trade.orders', 'trade.payments', 'trade.seats', 'trade.purchase-sessions', 'trade.tickets', 'trade.settlements', 'control.settings'] as const;
/** 텔레메트리 클러스터(analytics §3.1 표의 3개) */
export const TELEMETRY_TOPICS = ['telemetry.queue', 'telemetry.purchase', 'telemetry.trust-verdicts'] as const;
/** 읽지 않는 토픽(A-T22, analytics §3.1) */
export const NEVER_TOPICS = ['investigation.requests', 'telemetry.behavior', 'telemetry.rum'] as const;
/** 묶음 10,000건 또는 1초 [가정](§2.4) */
export const ANALYTICS_BATCH = { maxRecords: 10_000, maxWaitMs: 1_000 } as const;

/** 읽기 스키마: 이 작업자가 빌드된 계약 판 전부(@peaket/contracts/avro) */
export const READER_SCHEMAS: readonly unknown[] = Object.values(avroSchemas);

/**
 * 레지스트리가 없는 local·ci 무대의 스키마 원천: 고정 스키마 ID(주제 → ID, ADR-0357 결정 4)를 거꾸로 찾아 계약 판 스키마를 준다.
 * 모르는 ID는 UnknownSchemaError(거절 기록 UNKNOWN_SCHEMA)
 */
export function localSchemaSource(ids: Readonly<Record<string, number>> = localSchemaIds): SchemaSource {
  const byId = new Map<number, unknown>();
  for (const [subject, id] of Object.entries(ids)) {
    const full = Object.keys(avroSchemas).find((name) => subject.endsWith(`-${name}`));
    if (full) byId.set(id, avroSchemas[full]);
  }
  return {
    async byId(id: number) {
      const s = byId.get(id);
      if (s === undefined) throw new UnknownSchemaError(`모르는 스키마 ID ${id}`);
      return s;
    },
  };
}

export interface AnalyticsIngestOptions {
  readonly env: string;
  readonly pod: string;
  readonly tradeBrokers: string[];
  readonly telemetryBrokers: string[];
  readonly auth?: KafkaAuth;
  readonly schemas: SchemaSource;
  readonly clickhouse: Pick<ClickHouseHttp, 'insert'>;
  readonly pseudonyms: EventPseudonymizer;
  readonly probeEvents: ReadonlySet<string>;
  readonly registry?: Registry;
  readonly signals?: BronzeSignals;
  readonly logger?: { warn(o: object, msg?: string): void };
  readonly backfillTag?: string;
  readonly drainTimeoutMs?: number;
  readonly maxWaitMs?: number;
}

export const analyticsGroupId = (env: string, backfillTag?: string) => (backfillTag ? `peaket.analytics-ingest.${env}.backfill-${backfillTag}` : `peaket.analytics-ingest.${env}`);

export function startAnalyticsIngest(o: AnalyticsIngestOptions): { started: Promise<void>; stop(): Promise<void> } {
  // 모르는 열거 기호는 원래 기호 그대로 싣는다(브론즈는 원문 보관, §2.6)
  const reader = createAvroReader({ source: o.schemas, readerSchemas: READER_SCHEMAS, keepUnknownSymbols: true });
  const decode = async (m: ConsumedMessage): Promise<DecodeOutcome> => {
    const out = await reader.decode(m.topic, m.value ?? new Uint8Array());
    if (out.kind !== 'record') return out;
    const value: DecodedEvent = {
      record: out.recordName.slice(out.recordName.lastIndexOf('.') + 1),
      key: m.key,
      schemaId: out.schemaId,
      value: (out.value ?? {}) as Record<string, unknown>,
    };
    return { ...out, value };
  };
  const sink = new BronzeSink(o.clickhouse, o.pseudonyms, o.probeEvents, {
    ...(o.backfillTag ? { tokenPrefix: `backfill-${o.backfillTag}` } : {}),
    ...(o.signals ? { signals: o.signals } : {}),
  });
  const common = {
    worker: ANALYTICS_INGEST_WORKER,
    env: o.env,
    groupId: analyticsGroupId(o.env, o.backfillTag),
    decode,
    sink,
    maxRecords: ANALYTICS_BATCH.maxRecords,
    maxWaitMs: o.maxWaitMs ?? ANALYTICS_BATCH.maxWaitMs,
    startAt: 'earliest' as const,
    ...(o.auth ? { auth: o.auth } : {}),
    ...(o.registry ? { registry: o.registry } : {}),
    ...(o.logger ? { logger: o.logger } : {}),
    ...(o.drainTimeoutMs !== undefined ? { drainTimeoutMs: o.drainTimeoutMs } : {}),
  };
  const runs: BatchWorkerRun[] = [
    runBatchWorker<DecodedEvent>({ ...common, pod: `${o.pod}-trade`, brokers: o.tradeBrokers, topics: [...TRADE_TOPICS] }),
    runBatchWorker<DecodedEvent>({ ...common, pod: `${o.pod}-telemetry`, brokers: o.telemetryBrokers, topics: [...TELEMETRY_TOPICS] }),
  ];
  return {
    started: Promise.all(runs.map((r) => r.started)).then(() => undefined),
    async stop() {
      await Promise.all(runs.map((r) => r.stop()));
    },
  };
}
