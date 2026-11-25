// inv-ingest 작업자(docs/streaming.md §6.4, docs/features/forensic-replay.md §6.7.1, LCH-240, F-04-10).
// 원천 열 개를 읽어 inv 표 넷에 싣는다. 가명 처리를 하지 않고, 분석 저장소에는 어떤 행도 쓰지 않는다.
// investigation.requests만 JSON이고 나머지는 Avro다. 스키마를 읽지 못하면 그 파티션을 멈추고 다시 시도한다.
import type { Registry } from '@prometheus-io/client';
import { avroSchemas, localSchemaIds } from '@peaket/contracts/avro';
import type { ConsumedMessage, KafkaAuth } from '@peaket/platform';
import { UnknownSchemaError, createAvroReader, runBatchWorker, type BatchWorkerRun, type DecodeOutcome, type SchemaSource } from '@peaket/platform/stream-worker';
import type { ClickHouseHttp } from './clickhouse.js';
import type { EventDates } from './events.js';
import type { AsnTable } from './records.js';
import type { BatchRefResolver } from './refs.js';
import { InvSink, type DecodedInvEvent, type InvSignals } from './sink.js';

export const INV_INGEST_WORKER = 'inv-ingest';
/** 거래·제어 클러스터에서 읽는 토픽(§6.4 표) */
export const INV_TRADE_TOPICS = ['trade.purchase-sessions', 'trade.seats', 'trade.orders', 'trade.payments', 'trade.tickets'] as const;
/** 텔레메트리 클러스터에서 읽는 토픽. investigation.requests 읽기 권한은 이 작업자만 갖는다 */
export const INV_TELEMETRY_TOPICS = ['telemetry.queue', 'telemetry.purchase', 'telemetry.behavior', 'telemetry.trust-verdicts'] as const;
export const INV_INVESTIGATION_TOPICS = ['investigation.requests'] as const;
export const INV_TOPICS = [...INV_TRADE_TOPICS, ...INV_TELEMETRY_TOPICS, ...INV_INVESTIGATION_TOPICS];

/** 묶음 10,000건 또는 1초 [가정](§2.4) */
export const INV_BATCH = { maxRecords: 10_000, maxWaitMs: 1_000 } as const;

export const READER_SCHEMAS: readonly unknown[] = Object.values(avroSchemas);

/** 레지스트리가 없는 local·ci 무대: 고정 스키마 ID(ADR-0357 결정 4)를 거꾸로 찾아 계약 판 스키마를 준다 */
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

export interface InvIngestOptions {
  readonly env: string;
  readonly pod: string;
  readonly brokers: string[];
  readonly schemas: SchemaSource;
  readonly clickhouse: Pick<ClickHouseHttp, 'insert'>;
  readonly eventDates: EventDates;
  readonly asnTable: AsnTable;
  readonly auth?: KafkaAuth;
  readonly refs?: BatchRefResolver;
  readonly clock?: () => number;
  readonly registry?: Registry;
  readonly signals?: InvSignals;
  readonly logger?: { warn(o: object, msg?: string): void };
  readonly drainTimeoutMs?: number;
  readonly maxWaitMs?: number;
}

export const invGroupId = (env: string) => `peaket.inv-ingest.${env}`;

export function startInvIngest(o: InvIngestOptions): { started: Promise<void>; stop(): Promise<void> } {
  const reader = createAvroReader({ source: o.schemas, readerSchemas: READER_SCHEMAS, keepUnknownSymbols: true });
  const decode = async (m: ConsumedMessage): Promise<DecodeOutcome> => {
    const bytes = m.value ?? new Uint8Array();
    if (m.topic === 'investigation.requests') {
      try {
        const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        const decoded: DecodedInvEvent = { record: 'InvestigationRequest', key: m.key, schemaId: null, value };
        return { kind: 'record', schemaId: 0, recordName: 'InvestigationRequest', value: decoded, unrecognized: [] };
      } catch {
        return { kind: 'rejected', schemaId: null, reason: 'DESERIALIZE' };
      }
    }
    const out = await reader.decode(m.topic, bytes);
    if (out.kind !== 'record') return out;
    const value: DecodedInvEvent = {
      record: out.recordName.slice(out.recordName.lastIndexOf('.') + 1),
      key: m.key,
      schemaId: out.schemaId,
      value: (out.value ?? {}) as Record<string, unknown>,
    };
    return { ...out, value };
  };
  const sink = new InvSink({
    clickhouse: o.clickhouse,
    clock: o.clock ?? Date.now,
    eventDates: o.eventDates,
    asnTable: o.asnTable,
    ...(o.refs ? { refs: o.refs } : {}),
    ...(o.signals ? { signals: o.signals } : {}),
  });
  const run: BatchWorkerRun = runBatchWorker<DecodedInvEvent>({
    worker: INV_INGEST_WORKER,
    env: o.env,
    pod: o.pod,
    groupId: invGroupId(o.env),
    brokers: o.brokers,
    topics: [...INV_TOPICS],
    decode,
    sink,
    maxRecords: INV_BATCH.maxRecords,
    maxWaitMs: o.maxWaitMs ?? INV_BATCH.maxWaitMs,
    startAt: 'earliest',
    ...(o.auth ? { auth: o.auth } : {}),
    ...(o.registry ? { registry: o.registry } : {}),
    ...(o.logger ? { logger: o.logger } : {}),
    ...(o.drainTimeoutMs !== undefined ? { drainTimeoutMs: o.drainTimeoutMs } : {}),
  });
  return { started: run.started, stop: () => run.stop() };
}
