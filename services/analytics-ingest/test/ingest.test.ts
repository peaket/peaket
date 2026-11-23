// analytics-ingest 단위 시험(docs/streaming.md §6, docs/features/analytics.md §3.3, F-04-3 빠른 길).
// 가명·허용 목록·조사 칸 버리기(A-T21 브론즈 몫)·금지 칸 경보·건너뛰기·커버리지 위치·fail-closed(회차 키 실패)·읽지 않는 토픽(A-T22 적재 쪽).
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ClosedBatch } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { BronzeSink, type DecodedEvent } from '../src/bronze-sink.js';
import { coverageOf } from '../src/coverage.js';
import { migrationStatements } from '../src/migrate.js';
import { EventKeyUnavailable, EventPseudonymizer, LocalEventKeySource, PSEUDONYM_DOMAIN, eventKeySourceFromEnv, type EventKeySource } from '../src/pseudonym.js';
import { INVESTIGATION_FIELDS, allowListOf, bronzePayloadOf, eventIdOf } from '../src/records.js';
import { NEVER_TOPICS, TELEMETRY_TOPICS, TRADE_TOPICS, localSchemaSource } from '../src/worker.js';

const KEY = Buffer.alloc(32, 7);
const E1 = '0b8f6f3e-1111-4c2a-9d0e-000000000001';
const E2 = '0b8f6f3e-1111-4c2a-9d0e-000000000002';
const ref = (eventId: string, value: string) => {
  const ek = createHmac('sha256', KEY).update(`${PSEUDONYM_DOMAIN}${eventId}`, 'utf8').digest();
  return createHmac('sha256', ek).update(value, 'utf8').digest('hex');
};

class FakeCh {
  readonly inserts: { table: string; rows: Record<string, unknown>[]; token: string }[] = [];
  async insert(table: string, rows: readonly Record<string, unknown>[], token: string) {
    this.inserts.push({ table, rows: rows.map((r) => ({ ...r })), token });
  }
  rows(table: string) {
    return this.inserts.filter((i) => i.table === table).flatMap((i) => i.rows);
  }
}

const rec = (record: string, value: Record<string, unknown>, offset: string): ClosedBatch<DecodedEvent>['records'][number] => ({
  topic: 't',
  partition: 0,
  offset,
  timestamp: '1700000000000',
  value: { record, key: null, schemaId: 1, value },
});
const batch = (records: ClosedBatch<DecodedEvent>['records'], rejected: ClosedBatch<DecodedEvent>['rejected'] = []): ClosedBatch<DecodedEvent> => ({
  topic: 't',
  partition: 0,
  firstOffset: records[0]?.offset ?? rejected[0]!.offset,
  lastOffset: '99',
  dedupToken: 't:0:0:99',
  records,
  rejected,
});

const investigation = { journeyId: 'j-123', deviceRef: 'dev-9', contactRef: 'c-7', paymentMethodRef: 'pm-5', cardBin: '123456', holdKind: 'PRIORITY', priorityGrantId: 'pg-1' };

describe('F-04-3 가명·허용 목록(analytics §3.3)', () => {
  test('A-T21 조사 칸 일곱은 버리고 식별값은 회차 가명(HMAC-SHA256 256비트)으로 바꾼다', () => {
    const pseudo = (v: string) => ref(E1, v);
    const b = bronzePayloadOf('OrderEvent', { eventId: E1, orderId: 'ord-1', accountId: 'acc-1', purchaseSessionId: 'ps-1', type: 'CREATED', amount: 1000, refMissing: false, items: [], seatIds: ['s1'], seatAssignment: 'PICK', firstInStage: true, occurredAt: 1, eventKey: 'k', ...investigation }, pseudo);
    for (const f of INVESTIGATION_FIELDS) expect(b.payload).not.toHaveProperty(f);
    const text = JSON.stringify(b.payload);
    for (const v of Object.values(investigation)) expect(text).not.toContain(v);
    for (const raw of ['ord-1', 'acc-1', 'ps-1']) expect(text).not.toContain(raw);
    expect(b.payload.orderId).toBe(ref(E1, 'ord-1'));
    expect(String(b.payload.accountId)).toMatch(/^[0-9a-f]{64}$/);
    expect(b.forbidden).toEqual([]);
    // 같은 계정이라도 회차가 다르면 가명이 다르다(회차를 넘는 연결 없음)
    expect(ref(E1, 'acc-1')).not.toBe(ref(E2, 'acc-1'));
  });

  test('허용 목록은 계약 판 칸 − 조사 칸이고, 새 판 칸·SettingChanged.actor는 싣지 않는다', () => {
    expect(allowListOf('HoldAttempt').has('seatIds')).toBe(true);
    expect(allowListOf('HoldAttempt').has('heldAt')).toBe(true);
    expect(allowListOf('HoldAttempt').has('journeyId')).toBe(false);
    expect(allowListOf('SettingChanged').has('actor')).toBe(false);
    const b = bronzePayloadOf('SeatEvent', { eventId: E1, seatId: 's', type: 'SOLD', occurredAt: 1, eventKey: 'k', brandNewField: 'x', holdKind: 'PRIORITY' }, (v) => v);
    expect(b.payload).not.toHaveProperty('brandNewField');
    expect(b.payload).not.toHaveProperty('holdKind');
    expect(b.droppedFields).toEqual(['brandNewField', 'holdKind']);
  });

  test('금지 칸(이메일·IP·결제 토큰)은 중첩까지 버리고 스키마 위반으로 센다', () => {
    const b = bronzePayloadOf('OrderEvent', { eventId: E1, orderId: 'o', items: [{ seatId: 's', email: 'a@b.c' }], email: 'a@b.c', paymentKey: 'pk_live_1', occurredAt: 1, eventKey: 'k' }, (v) => `p:${v}`);
    expect([...b.forbidden].sort()).toEqual(['email', 'items[0].email', 'paymentKey']);
    expect(JSON.stringify(b.payload)).not.toMatch(/a@b\.c|pk_live_1/);
  });

  test('회차 ID: 설정 사건은 scope가 회차 UUID일 때만, 상품 정산서는 빈 글', () => {
    expect(eventIdOf('SettingChanged', { scope: E1.toUpperCase() })).toBe(E1);
    expect(eventIdOf('SettingChanged', { scope: 'PLATFORM' })).toBe('');
    expect(eventIdOf('SettlementEvent', { eventId: null })).toBe('');
  });
});

describe('F-04-3 브론즈 싱크(streaming §6.1)', () => {
  const seat = (offset: string, o: Record<string, unknown> = {}) => rec('SeatEvent', { eventId: E1, seatId: 's1', tierId: 'R', sectionId: 'A', type: 'HELD', accountId: 'acc-1', holdId: 'h-1', purchaseSessionId: 'ps-1', occurredAt: 1_700_000_000_500, eventKey: '7d3c0a52-2222-4f7a-8b1c-000000000001', ...investigation, ...o }, offset);

  test('적재·건너뜀·거절 위치가 모두 커버리지 표에 남고, 사건 행에는 가명만 있다', async () => {
    const ch = new FakeCh();
    const sink = new BronzeSink(ch, new EventPseudonymizer(new LocalEventKeySource(KEY, 'local-v1')), new Set([E2]));
    await sink.write(
      batch(
        [
          seat('10'),
          rec('PipelinePulse', { kind: 'PULSE', topic: 'telemetry.queue', partition: 0, producedAt: 1 }, '11'),
          rec('QueueAggregate', { eventId: E1, second: 1, entries: 1, removed: 0, admissions: 0, eventKey: 'x' }, '12'),
          seat('13', { eventId: E2 }),
          rec('PaymentEvent', { eventId: null, orderId: 'merch-1', type: 'APPROVED', amount: 10, orderKind: 'MERCH', occurredAt: 1, eventKey: 'y' }, '15'),
        ],
        [{ topic: 't', partition: 0, offset: '14', kafkaTs: '1700000000000', schemaId: 99, reason: 'UNKNOWN_SCHEMA' }],
      ),
    );
    const rows = ch.rows('bronze.brz_seat_event');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: E1, record: 'SeatEvent', key_version: 'local-v1', kafka_partition: 0, kafka_offset: '10', occurred_at: '2023-11-14T22:13:20.500Z' });
    const payload = JSON.parse(String(rows[0]!.payload)) as Record<string, unknown>;
    expect(payload.accountId).toBe(ref(E1, 'acc-1'));
    expect(payload.holdId).toBe(ref(E1, 'h-1'));
    expect(String(rows[0]!.payload)).not.toMatch(/acc-1|h-1|ps-1|j-123|dev-9|pg-1|PRIORITY/);
    expect(ch.rows('bronze.brz_rejected')).toEqual([{ topic: 't', partition: 0, offset: '14', kafka_ts: '2023-11-14T22:13:20.000Z', schema_id: 99, error_class: 'UNKNOWN_SCHEMA' }]);
    expect(ch.rows('bronze.brz_offset').map((r) => [r.offset, r.outcome, r.reason])).toEqual([
      ['10', 'LOADED', ''],
      ['11', 'SKIPPED', 'PipelinePulse'],
      ['12', 'SKIPPED', 'QueueAggregate'],
      ['13', 'SKIPPED', 'PROBE_EVENT'],
      ['15', 'SKIPPED', 'NO_EVENT'],
      ['14', 'REJECTED', 'UNKNOWN_SCHEMA'],
    ]);
    // 표마다 같은 중복 거르기 표시
    expect(new Set(ch.inserts.map((i) => i.token))).toEqual(new Set(['t:0:0:99']));
  });

  test('ST-T22 회차 키를 얻지 못하면 아무것도 쓰지 않고 던진다(원문을 쓰지 않는다, fail-closed)', async () => {
    let fail = true;
    const src: EventKeySource = { version: 'v1', eventKey: async (e) => (fail ? Promise.reject(new Error('kms down')) : new LocalEventKeySource(KEY, 'v1').eventKey(e)) };
    const ch = new FakeCh();
    const sink = new BronzeSink(ch, new EventPseudonymizer(src), new Set());
    await expect(sink.write(batch([seat('1')]))).rejects.toBeInstanceOf(EventKeyUnavailable);
    expect(ch.inserts).toEqual([]);
    fail = false;
    await sink.write(batch([seat('1')]));
    expect(JSON.parse(String(ch.rows('bronze.brz_seat_event')[0]!.payload)).accountId).toBe(ref(E1, 'acc-1'));
  });

  test('다시 적재는 중복 거르기 표시 앞에 끝말을 붙인다', async () => {
    const ch = new FakeCh();
    await new BronzeSink(ch, new EventPseudonymizer(new LocalEventKeySource(KEY, 'v1')), new Set(), { tokenPrefix: 'backfill-x' }).write(batch([seat('1')]));
    expect(ch.inserts.every((i) => i.token === 'backfill-x:t:0:0:99')).toBe(true);
  });
});

describe('F-04-3 설정·토픽·이전 파일', () => {
  test('A-T22 적재 설정에 investigation.requests·행동 신호가 없다', () => {
    const all = [...TRADE_TOPICS, ...TELEMETRY_TOPICS] as string[];
    for (const t of NEVER_TOPICS) expect(all).not.toContain(t);
    expect(all).toHaveLength(10);
  });

  test('운영 환경은 KMS 키 ID가 있어야 하고, local은 32바이트 키를 받는다', () => {
    expect(() => eventKeySourceFromEnv({ PEAKET_ENV: 'prod' })).toThrow(/KMS_KEY_ID/);
    expect(() => eventKeySourceFromEnv({ PEAKET_ENV: 'local', PEAKET_ANALYTICS_PSEUDONYM_KEY: Buffer.alloc(8).toString('base64') })).toThrow(/32바이트/);
    expect(eventKeySourceFromEnv({ PEAKET_ENV: 'ci', PEAKET_ANALYTICS_PSEUDONYM_KEY: KEY.toString('base64') }).version).toBe('local-v1');
    expect(JSON.stringify({ k: new LocalEventKeySource(KEY, 'v1') })).not.toContain(KEY.toString('hex'));
  });

  test('고정 스키마 ID 원천은 계약 판 스키마를 주고 모르는 ID는 UNKNOWN_SCHEMA다', async () => {
    const s = localSchemaSource({ 'trade.seats-peaket.trade.SeatEvent': 22 });
    expect(((await s.byId(22)) as { name: string }).name).toBe('SeatEvent');
    await expect(s.byId(5)).rejects.toMatchObject({ name: 'UnknownSchemaError' });
  });

  test('이전 파일: 사건 브론즈 열한 표·거절·커버리지·기준 자료 둘, 조사 칸 열 없음', () => {
    const stmts = migrationStatements(fileURLToPath(new URL('../../../data/clickhouse/bronze', import.meta.url)), 'single');
    const tables = stmts.flatMap((s) => /CREATE TABLE IF NOT EXISTS ([a-z_.]+)/.exec(s)?.[1] ?? []);
    expect(tables).toHaveLength(15);
    expect(tables).toEqual(expect.arrayContaining(['bronze.brz_rejected', 'bronze.brz_offset', 'bronze.brz_ref_seat_map', 'bronze.brz_order_event', 'bronze.brz_hold_attempt']));
    expect(stmts.join('\n')).not.toMatch(/journey_id|device_ref|contact_ref|payment_method_ref|card_bin|ON CLUSTER|Replicated/);
  });

  test('커버리지: 구간 길이와 고유 위치 수가 같으면 빈 곳 없음, 모자라면 앞·안·뒤 빈 구간', async () => {
    const offsets = [3n, 4n, 6n, 7n];
    const rows = async <T>(sql: string, p: Record<string, string>): Promise<T[]> => {
      const inRange = offsets.filter((o) => o >= BigInt(p.from!) && o <= BigInt(p.to!));
      if (sql.includes('uniqExact')) return [{ n: String(inRange.length), lo: String(inRange[0] ?? 0), hi: String(inRange.at(-1) ?? 0) }] as T[];
      const gaps = inRange.slice(0, -1).flatMap((o, i) => (inRange[i + 1]! > o + 1n ? [{ a: String(o + 1n), b: String(inRange[i + 1]! - 1n) }] : []));
      return gaps as T[];
    };
    expect((await coverageOf({ rows }, { topic: 't', partition: 0, from: 6n, to: 7n })).gaps).toEqual([]);
    const r = await coverageOf({ rows }, { topic: 't', partition: 0, from: 2n, to: 9n });
    expect([r.expected, r.present]).toEqual([8n, 4n]);
    expect(r.gaps).toEqual([
      { from: 2n, to: 2n },
      { from: 5n, to: 5n },
      { from: 8n, to: 9n },
    ]);
  });
});
