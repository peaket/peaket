// ops-rt 작업자(docs/streaming.md §1·§2·§4, OPS-160, F-04-1). 거래·제어 클러스터 토픽 넷과 텔레메트리 클러스터 토픽 셋을 각각 묶음
// 실행기(runBatchWorker, OPS-150)로 읽어 rt 원시 표에 싣는다. 집계하지 않는다. 쓰기가 성공한 뒤에만 커밋한다(§2.4).
// 다시 채우기(§4.7 1, RB-34): backfill이면 운영 그룹과 다른 버리는 그룹으로 가장 이른 곳부터 읽는다. 운영 그룹의 커밋 위치는 건드리지 않는다
// (그 그룹에는 커밋이 남지만 다시 쓰지 않는다, 추천 적용 2026-11-23, F-04-1 계획). 겹쳐 실려도 뷰가 eventKey로 지운다.
import type { Registry } from '@prometheus-io/client';
import { createAvroReader, runBatchWorker, schemaRegistrySource, type BatchWorkerRun, type DecodeOutcome, type SchemaSource } from '@peaket/platform/stream-worker';
import type { ConsumedMessage, KafkaAuth } from '@peaket/platform';
import { RtSink, type ClickHouseHttp } from './clickhouse.js';
import { recordShortName, type DecodedEvent } from './rows.js';

export const OPS_RT_WORKER = 'ops-rt';
/** 거래·제어 클러스터 토픽(§1). trade.seats의 EventSaleChanged는 행으로 바꿀 때 건너뛴다 */
export const TRADE_TOPICS = ['trade.orders', 'trade.payments', 'trade.seats', 'trade.tickets'] as const;
/** 텔레메트리 클러스터 토픽(§1) */
export const TELEMETRY_TOPICS = ['telemetry.queue', 'telemetry.purchase', 'telemetry.trust-verdicts'] as const;
/** 묶음 2,000건 또는 0.25초 [가정](§2.4) */
export const OPS_RT_BATCH = { maxRecords: 2_000, maxWaitMs: 250 } as const;

export interface OpsRtOptions {
  readonly env: string;
  readonly pod: string;
  readonly tradeBrokers: string[];
  readonly telemetryBrokers: string[];
  readonly auth?: KafkaAuth;
  readonly schemas: SchemaSource;
  readonly readerSchemas: readonly unknown[];
  readonly clickhouse: Pick<ClickHouseHttp, 'insert'>;
  readonly probeEvents: ReadonlySet<string>;
  readonly registry?: Registry;
  readonly logger?: { warn(o: object, msg?: string): void };
  /** 다시 채우기: 버리는 그룹 이름 끝말(예: 시각). 있으면 가장 이른 곳부터 읽는다 */
  readonly backfillTag?: string;
  /** 시험이 줄인다 */
  readonly drainTimeoutMs?: number;
  readonly maxWaitMs?: number;
}

export interface OpsRtRun {
  readonly started: Promise<void>;
  stop(): Promise<void>;
}

export const opsRtGroupId = (env: string, backfillTag?: string) => (backfillTag ? `peaket.ops-rt.${env}.backfill-${backfillTag}` : `peaket.ops-rt.${env}`);

export function startOpsRt(o: OpsRtOptions): OpsRtRun {
  const reader = createAvroReader({ source: o.schemas, readerSchemas: o.readerSchemas });
  const decode = async (m: ConsumedMessage): Promise<DecodeOutcome> => {
    const out = await reader.decode(m.topic, m.value ?? new Uint8Array());
    if (out.kind !== 'record') return out;
    const value: DecodedEvent = {
      record: recordShortName(out.recordName),
      key: m.key,
      value: (out.value ?? {}) as Record<string, unknown>,
    };
    return { ...out, value };
  };
  const sink = new RtSink(o.clickhouse, o.probeEvents, o.backfillTag ? `backfill-${o.backfillTag}` : undefined);
  const groupId = opsRtGroupId(o.env, o.backfillTag);
  const common = {
    worker: OPS_RT_WORKER,
    env: o.env,
    groupId,
    decode,
    sink,
    maxRecords: OPS_RT_BATCH.maxRecords,
    maxWaitMs: o.maxWaitMs ?? OPS_RT_BATCH.maxWaitMs,
    // 누적은 원시 행이 다 있어야 맞는다(§2.6 표: 가장 이른 곳)
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

export { schemaRegistrySource };
