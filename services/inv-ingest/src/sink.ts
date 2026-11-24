// inv 싱크(docs/streaming.md §6.4 단계 '나누기 → 삽입 → 진행 위치', §2.4, LCH-240, F-04-10).
// 묶음 하나를 표마다 INSERT 한 번으로 쓴 뒤 적재 진행 표를 쓴다. 모두 성공해야 돌아가고, 그 뒤 실행기가 '끝 오프셋 + 1'을 커밋한다.
// 적어도 한 번 전달로 같은 사건이 다시 와도 표의 ReplacingMergeTree 정렬 키가 같아 늘지 않는다.
import type { BatchSink, ClosedBatch } from '@peaket/platform';
import type { ClickHouseHttp } from './clickhouse.js';
import { accountIdsOf, INV_TABLES, invRowKey, mapEvent, type AsnTable, type InvRow, type InvTable } from './records.js';
import type { BatchRefResolver } from './refs.js';

/** 실행기가 넘기는 값: 레코드 이름 마지막 조각, Kafka 키, 스키마 ID(JSON은 null), 읽은 값 */
export interface DecodedInvEvent {
  readonly record: string;
  readonly key: string | null;
  readonly schemaId: number | null;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface InvSignals {
  loaded(table: string, n: number): void;
  skipped(reason: string): void;
  rejected(reason: string): void;
  eventDateMissing(n: number): void;
}

export interface InvSinkOptions {
  readonly clickhouse: Pick<ClickHouseHttp, 'insert'>;
  readonly clock: () => number;
  readonly eventDates: ReadonlyMap<string, string>;
  readonly asnTable: AsnTable;
  readonly refs?: BatchRefResolver;
  readonly signals?: InvSignals;
}

export class InvSink implements BatchSink<DecodedInvEvent> {
  readonly table = 'inv';

  constructor(private readonly o: InvSinkOptions) {}

  async write(batch: ClosedBatch<DecodedInvEvent>): Promise<void> {
    const ingestedAt = this.o.clock();
    // 계정 연결 값은 묶음의 계정을 모아 한 번에 묻는다(500개 묶음·10분 캐시는 BatchRefResolver가 맡는다)
    const accounts = [...new Set(batch.records.flatMap((r) => accountIdsOf(r.value.record, r.value.value)))];
    const resolved = this.o.refs && accounts.length ? await this.o.refs.resolve(accounts) : new Map();
    const rows = new Map<InvTable, InvRow[]>();
    const seen = new Set<string>();
    for (const r of batch.records) {
      const mapped = mapEvent(r.value.record, r.value.value, {
        ingestedAt,
        eventDates: this.o.eventDates,
        asnTable: this.o.asnTable,
        ...(resolved.size ? { refs: resolved } : {}),
      });
      if (mapped.outcome === 'REJECTED') {
        this.o.signals?.rejected(mapped.reason ?? 'REJECTED');
        if (mapped.reason === 'EVENT_DATE_MISSING') this.o.signals?.eventDateMissing(1);
        continue;
      }
      if (mapped.outcome === 'SKIPPED') {
        this.o.signals?.skipped(mapped.reason ?? 'SKIPPED');
        continue;
      }
      for (const item of mapped.rows) {
        const key = `${item.table}|${invRowKey(item.table, item.row)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const list = rows.get(item.table) ?? [];
        list.push(item);
        rows.set(item.table, list);
      }
    }
    for (const table of INV_TABLES) {
      const list = rows.get(table);
      if (!list?.length) continue;
      await this.o.clickhouse.insert(table, list.map((x) => x.row), batch.dedupToken);
      this.o.signals?.loaded(table, list.length);
    }
    const progress = {
      topic: batch.topic,
      partition: batch.partition,
      offset: String(BigInt(batch.lastOffset) + 1n),
      ingested_at: new Date(ingestedAt).toISOString(),
    };
    await this.o.clickhouse.insert('inv.inv_ingest_progress', [progress], `${batch.dedupToken}:progress`);
  }
}
