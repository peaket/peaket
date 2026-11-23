// 브론즈 싱크(docs/streaming.md §6.1 단계 '가명 처리 → 금지 필드 제거 → 나누기 → 삽입 → 거절 기록', §2.4, OPS-200·OPS-205, F-04-3).
// 묶음 하나를 ① 사건 브론즈 표마다 ② 적재 거절 기록 brz_rejected ③ 커버리지 위치 brz_offset 차례로 쓴다. 모두 성공해야 돌아가고, 그 뒤에
// 실행기가 '끝 오프셋 + 1'을 커밋한다. 회차 키를 얻지 못하면(EventKeyUnavailable) 아무것도 쓰지 않고 던져 그 파티션을 멈추고 다시 시도한다.
// 거절 레코드는 원문 없이 위치만 남긴다(§6.3). 건너뛴 레코드(심장 박동·1초 집계·점검 회차·회차 없는 상품 결제)도 위치는 brz_offset에 남겨
// 커버리지 대조(analytics §7)가 빈 구간으로 보지 않게 한다(추천 적용 2026-11-23, F-04-3 계획).
import type { BatchSink, ClosedBatch } from '@peaket/platform';
import type { ClickHouseHttp } from './clickhouse.js';
import type { EventPseudonymizer } from './pseudonym.js';
import { BRONZE_TABLES, SKIPPED_RECORDS, bronzePayloadOf, eventIdOf, isBronzeRecord, occurredAtOf, type BronzeTable } from './records.js';

/** 실행기가 넘기는 값: 레코드 이름 마지막 조각, Kafka 키, 스키마 ID, 읽은 값 */
export interface DecodedEvent {
  readonly record: string;
  readonly key: string | null;
  readonly schemaId: number;
  readonly value: Readonly<Record<string, unknown>>;
}

export type Outcome = 'LOADED' | 'REJECTED' | 'SKIPPED';

export interface BronzeSignals {
  forbidden(record: string, field: string): void;
  loaded(table: string, n: number): void;
  rejected(n: number): void;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class BronzeSink implements BatchSink<DecodedEvent> {
  readonly table = 'bronze';

  constructor(
    private readonly ch: Pick<ClickHouseHttp, 'insert'>,
    private readonly pseudonyms: EventPseudonymizer,
    private readonly probeEvents: ReadonlySet<string>,
    private readonly o: { tokenPrefix?: string; signals?: BronzeSignals } = {},
  ) {}

  async write(batch: ClosedBatch<DecodedEvent>): Promise<void> {
    const token = this.o.tokenPrefix ? `${this.o.tokenPrefix}:${batch.dedupToken}` : batch.dedupToken;
    const offsets: Record<string, string | number>[] = [];
    const pos = (offset: string, outcome: Outcome, reason = '') => offsets.push({ topic: batch.topic, partition: batch.partition, offset, outcome, reason });

    // 회차 키를 먼저 모두 준비한다(하나라도 못 얻으면 아무것도 쓰지 않는다, fail-closed)
    const loadable = batch.records.filter((r) => isBronzeRecord(r.value.record) && !SKIPPED_RECORDS.has(r.value.record));
    const events = new Set<string>();
    for (const r of loadable) {
      const e = eventIdOf(r.value.record, r.value.value);
      if (e) events.add(e);
    }
    await Promise.all([...events].filter((e) => !this.probeEvents.has(e.toLowerCase())).map((e) => this.pseudonyms.prepare(e)));

    const rows = new Map<BronzeTable, Record<string, unknown>[]>();
    for (const r of batch.records) {
      const { record, value: v } = r.value;
      if (SKIPPED_RECORDS.has(record) || !isBronzeRecord(record)) {
        pos(r.offset, 'SKIPPED', SKIPPED_RECORDS.has(record) ? record : `UNLOADED_RECORD:${record}`);
        continue;
      }
      const eventId = eventIdOf(record, v);
      if (eventId && this.probeEvents.has(eventId.toLowerCase())) {
        pos(r.offset, 'SKIPPED', 'PROBE_EVENT');
        continue;
      }
      // 회차가 없는 상품 결제는 회차 분석 대상이 아니고 회차 가명을 만들 수 없다(추천 적용 2026-11-23)
      if (!eventId && record === 'PaymentEvent') {
        pos(r.offset, 'SKIPPED', 'NO_EVENT');
        continue;
      }
      const pseudonymize = eventId ? this.pseudonyms.forEvent(eventId) : () => '';
      const b = bronzePayloadOf(record, v, pseudonymize);
      for (const f of b.forbidden) this.o.signals?.forbidden(record, f);
      const table = BRONZE_TABLES[record];
      const list = rows.get(table) ?? [];
      list.push({
        event_id: eventId,
        event_key: typeof v.eventKey === 'string' ? v.eventKey : '00000000-0000-0000-0000-000000000000',
        record,
        occurred_at: iso(occurredAtOf(record, v, Number(r.timestamp))),
        key_version: this.pseudonyms.version,
        schema_id: r.value.schemaId,
        payload: JSON.stringify(b.payload),
        kafka_topic: batch.topic,
        kafka_partition: batch.partition,
        kafka_offset: r.offset,
        kafka_ts: iso(Number(r.timestamp)),
      });
      rows.set(table, list);
      pos(r.offset, 'LOADED');
    }
    const rejected = batch.rejected.map((x) => ({ topic: x.topic, partition: x.partition, offset: x.offset, kafka_ts: iso(Number(x.kafkaTs)), schema_id: x.schemaId, error_class: x.reason }));
    for (const x of batch.rejected) pos(x.offset, 'REJECTED', x.reason);

    for (const [table, list] of rows) {
      await this.ch.insert(table, list, token);
      this.o.signals?.loaded(table, list.length);
    }
    if (rejected.length) {
      await this.ch.insert('bronze.brz_rejected', rejected, token);
      this.o.signals?.rejected(rejected.length);
    }
    if (offsets.length) await this.ch.insert('bronze.brz_offset', offsets, token);
  }
}
