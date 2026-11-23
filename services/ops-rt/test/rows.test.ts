// ops-rt 사건 → rt 원시 행 변환(docs/streaming.md §4.2 표, F-04-1)과 이전 문장 바꾸기(한 대짜리 ClickHouse).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BatchRecord } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { forTopology, migrationStatements, statementsOf } from '../src/migrate.js';
import { groupRows, rowsOf, type DecodedEvent } from '../src/rows.js';

const EVENT = '0b8f6f3e-1111-4c2a-9d0e-000000000001';
const KEY = '7d3c0a52-2222-4f7a-8b1c-000000000001';
const T = Date.UTC(2026, 10, 23, 1, 0, 0);
const rec = (record: string, value: Record<string, unknown>, o: { key?: string; partition?: number; offset?: string } = {}): BatchRecord<DecodedEvent> => ({
  topic: 't',
  partition: o.partition ?? 0,
  offset: o.offset ?? '10',
  timestamp: String(T),
  value: { record, key: o.key ?? null, value },
});

describe('F-04-1 §4.2 거르기와 옮기기', () => {
  test('ST-T10 ① 좌석 사건은 PENDING·SOLD·RETURNED만 싣고 홀드 쪽·AVAILABLE은 거른다', () => {
    const kinds = ['HELD', 'RELEASED', 'EXPIRED', 'PENDING', 'SOLD', 'AVAILABLE', 'RETURNED'];
    const out = kinds.flatMap((type, i) => rowsOf(rec('SeatEvent', { eventId: EVENT, seatId: 's1', tierId: 'R', sectionId: 'A', type, occurredAt: T + i, eventKey: KEY }, { offset: String(i) }), new Set()));
    expect(out.map((r) => r.row.type)).toEqual(['PENDING', 'SOLD', 'RETURNED']);
    expect(out[0]).toEqual({
      table: 'rt.sale_event',
      row: { event_id: EVENT, event_key: KEY, source: 'SEAT', type: 'PENDING', seat_id: 's1', tier_id: 'R', section_id: 'A', amount: 0, first_in_stage: false, occurred_at: new Date(T + 3).toISOString(), kafka_partition: 0, kafka_offset: '3' },
    });
  });

  test('ST-T15 모르는 열거 기호는 버리지 않고 UNRECOGNIZED로 싣는다', () => {
    const out = rowsOf(rec('OrderEvent', { eventId: EVENT, type: 'UNRECOGNIZED', firstInStage: false, occurredAt: T, eventKey: KEY }), new Set());
    expect(out).toHaveLength(1);
    expect(out[0]!.row.type).toBe('UNRECOGNIZED');
  });

  test('주문·결제·티켓 사건의 종류 거르기와 결제 금액·처음 표시', () => {
    const order = ['CREATED', 'ACCEPTED', 'APPROVED', 'CONFIRMED', 'DEPOSIT_REVERSED', 'REFUNDED'].flatMap((type) => rowsOf(rec('OrderEvent', { eventId: EVENT, type, firstInStage: true, occurredAt: T, eventKey: KEY }), new Set()));
    expect(order.map((r) => [r.row.type, r.row.first_in_stage])).toEqual([
      ['ACCEPTED', true],
      ['APPROVED', true],
      ['CONFIRMED', true],
      ['DEPOSIT_REVERSED', true],
    ]);
    const pay = ['APPROVED', 'DEPOSIT_REVERSED', 'CANCELED'].flatMap((type) => rowsOf(rec('PaymentEvent', { eventId: EVENT, type, amount: 150_000, orderKind: 'TICKET', occurredAt: T, eventKey: KEY }), new Set()));
    expect(pay.map((r) => [r.row.type, r.row.amount])).toEqual([
      ['APPROVED', 150_000],
      ['DEPOSIT_REVERSED', 150_000],
    ]);
    // 상품 결제와 회차 없는 결제는 회차 판매 금액이 아니다
    expect(rowsOf(rec('PaymentEvent', { eventId: EVENT, type: 'APPROVED', amount: 1, orderKind: 'MERCH', occurredAt: T, eventKey: KEY }), new Set())).toEqual([]);
    expect(rowsOf(rec('PaymentEvent', { eventId: null, type: 'APPROVED', amount: 1, orderKind: 'TICKET', occurredAt: T, eventKey: KEY }), new Set())).toEqual([]);
    const ticket = ['ISSUED', 'TRANSFERRED', 'VOIDED'].flatMap((type) => rowsOf(rec('TicketEvent', { eventId: EVENT, type, occurredAt: T, eventKey: KEY }), new Set()));
    expect(ticket.map((r) => r.row.type)).toEqual(['ISSUED', 'VOIDED']);
  });

  test('사람 식별값(계정·주문·구매 세션·티켓 ID)은 어떤 행에도 실리지 않는다', () => {
    const people = { accountId: 'acc-1', orderId: 'ord-1', purchaseSessionId: 'ps-1', ticketId: 'tk-1', pid: 'pid-1', journeyId: 'j-1' };
    const all = [
      rec('SeatEvent', { ...people, eventId: EVENT, seatId: 's', tierId: 'R', sectionId: 'A', type: 'SOLD', occurredAt: T, eventKey: KEY }),
      rec('OrderEvent', { ...people, eventId: EVENT, type: 'CONFIRMED', firstInStage: true, occurredAt: T, eventKey: KEY }),
      rec('PaymentEvent', { ...people, eventId: EVENT, type: 'APPROVED', amount: 1, orderKind: 'TICKET', occurredAt: T, eventKey: KEY }),
      rec('TicketEvent', { ...people, eventId: EVENT, type: 'ISSUED', occurredAt: T, eventKey: KEY }),
      rec('HoldAttempt', { ...people, eventId: EVENT, result: 'HELD', tierId: 'R', firstHeldInSession: true, occurredAt: T, eventKey: KEY }),
      rec('TrustVerdict', { ...people, eventId: EVENT, category: 'PASS', shadow: false, occurredAt: T, eventKey: KEY }),
    ].flatMap((r) => rowsOf(r, new Set()));
    expect(all).toHaveLength(6);
    const text = JSON.stringify(all);
    for (const v of Object.values(people)) expect(text).not.toContain(v);
  });

  test('대기 집계의 파드는 메시지 키 회차:파드의 뒤쪽이고, 그림자 판정은 거른다', () => {
    const q = rowsOf(rec('QueueAggregate', { eventId: EVENT, second: T, entries: 5, removed: 1, admissions: 3, soonResponses: 0, eventKey: KEY }, { key: `${EVENT}:queue-svc-7f9` }), new Set());
    expect(q).toEqual([{ table: 'rt.queue_aggregate', row: { event_id: EVENT, event_key: KEY, pod: 'queue-svc-7f9', second: new Date(T).toISOString(), entries: 5, admissions: 3, removed: 1 } }]);
    expect(rowsOf(rec('TrustVerdict', { eventId: EVENT, category: 'BLOCKED', shadow: true, occurredAt: T, eventKey: KEY }), new Set())).toEqual([]);
  });

  test('ST-T2 심장 박동은 토픽·파티션·발행 시각만 싣는다', () => {
    const p = rowsOf(rec('PipelinePulse', { kind: 'PULSE', topic: 'telemetry.queue', partition: 2, producedAt: T }), new Set());
    expect(p).toEqual([{ table: 'rt.pulse', row: { topic: 'telemetry.queue', kafka_partition: 2, produced_at: new Date(T).toISOString() } }]);
  });

  test('Q-T50 점검 회차의 사건과 같은 토픽의 다른 레코드는 싣지 않는다', () => {
    const probe = new Set([EVENT.toLowerCase()]);
    expect(rowsOf(rec('SeatEvent', { eventId: EVENT.toUpperCase(), seatId: 's', tierId: 'R', sectionId: 'A', type: 'SOLD', occurredAt: T, eventKey: KEY }), probe)).toEqual([]);
    expect(rowsOf(rec('EventSaleChanged', { eventId: EVENT, occurredAt: T, eventKey: KEY }), new Set())).toEqual([]);
    expect(rowsOf(rec('QueueEntryRecord', { eventId: EVENT, occurredAt: T, eventKey: KEY }), new Set())).toEqual([]);
  });

  test('묶음의 행을 표마다 모은다', () => {
    const g = groupRows(
      [
        rec('SeatEvent', { eventId: EVENT, seatId: 's', tierId: 'R', sectionId: 'A', type: 'SOLD', occurredAt: T, eventKey: KEY }),
        rec('PipelinePulse', { kind: 'PULSE', topic: 'telemetry.queue', partition: 0, producedAt: T }),
        rec('SeatEvent', { eventId: EVENT, seatId: 's2', tierId: 'R', sectionId: 'A', type: 'HELD', occurredAt: T, eventKey: KEY }),
      ],
      new Set(),
    );
    expect([...g.keys()]).toEqual(['rt.sale_event', 'rt.pulse']);
    expect(g.get('rt.sale_event')).toHaveLength(1);
  });
});

describe('F-04-1 rt 표·뷰 이전 파일', () => {
  const dir = fileURLToPath(new URL('../../../data/clickhouse/rt', import.meta.url));

  test('한 대짜리는 ON CLUSTER를 지우고 MergeTree와 중복 거르기 창을 쓴다', () => {
    const s = forTopology("CREATE TABLE IF NOT EXISTS rt.x ON CLUSTER '{cluster}' (a UInt8) ENGINE = ReplicatedMergeTree ORDER BY a TTL now() + INTERVAL 1 DAY", 'single');
    expect(s).toBe('CREATE TABLE IF NOT EXISTS rt.x (a UInt8) ENGINE = MergeTree ORDER BY a TTL now() + INTERVAL 1 DAY\nSETTINGS non_replicated_deduplication_window = 1000');
    expect(forTopology("CREATE VIEW rt.v ON CLUSTER '{cluster}' AS SELECT 1", 'cluster')).toContain("ON CLUSTER '{cluster}'");
  });

  test('파일에서 표 다섯·뷰 셋을 정본 이름으로 만든다', () => {
    const stmts = migrationStatements(dir, 'single');
    const names = stmts.map((s) => /(?:TABLE|VIEW|DATABASE) (?:IF NOT EXISTS )?([a-z_.]+)/.exec(s)?.[1]);
    expect(names).toEqual(['rt', 'rt.sale_event', 'rt.queue_aggregate', 'rt.hold_attempt', 'rt.verdict', 'rt.pulse', 'rt.v_cumulative', 'rt.v_bucket', 'rt.v_freshness']);
    expect(stmts.join('\n')).not.toMatch(/ON CLUSTER|Replicated/);
    // 운영 모양 그대로 남은 문장 수
    expect(statementsOf(readFileSync(`${dir}/0001_rt_tables.sql`, 'utf8'))).toHaveLength(6);
  });
});
