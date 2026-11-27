// F-07-12 RV-02: core-svc가 trade.seats의 EventSaleChanged를 읽어 회차 판매 상태 사본을 채우는지 본다.
// 정본: docs/api/asyncapi.yaml EventSaleChanged, docs/streaming.md §2.6 'core-svc 소비자'·§4 trade.seats,
// docs/data.md event_sale·search_document, ADR-0122·ADR-0219 결정 5(같은 판 다시 내기).
// 업무 키는 회차 ID, 중복 제거 키는 eventKey다. 판 번호가 지금 값보다 클 때만 쓴다(늦게 온 사건을 거른다).
// 기준 트리에는 catalog/inbound/event-sale-changed.handler.ts가 없어 이 시험이 실패한다.
import type { ConsumedMessage } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { CoreEventSaleChangedHandler, type EventSaleRecord, SEATS_TOPIC } from '../src/modules/catalog/inbound/event-sale-changed.handler.js';
import { type EventSaleStateStore, type EventSaleStatusEvent, shouldApplyEventSale } from '../src/modules/catalog/domain/event-sale-state.js';
import type { EventSaleState } from '../src/modules/catalog/domain/production.js';

const T0 = Date.parse('2026-11-27T03:00:00.000Z');
const EVENT_A = 'evt-a';
const EVENT_B = 'evt-b';
const PROD_A = 'prod-a';
const PROD_B = 'prod-b';
const EVENT_KEY = randomUUID();
const OTHER_EVENT_KEY = randomUUID();

/** 계약 모양의 판매 상태 사건(셈 칸은 core가 읽지 않지만 계약 필수라 싣는다) */
const sale = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  eventId: EVENT_A,
  status: 'ALL_HELD',
  previousStatus: 'ON_SALE',
  available: 0,
  held: 10,
  paying: 2,
  soldOutTiers: [],
  version: 3,
  changedAt: new Date(T0).toISOString(),
  eventKey: EVENT_KEY,
  ...o,
});

const message = (value: unknown, o: Partial<ConsumedMessage> = {}): ConsumedMessage => ({
  topic: SEATS_TOPIC,
  partition: 0,
  offset: 7n,
  key: EVENT_A,
  value: value === null ? null : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'),
  headers: {},
  timestamp: T0,
  ...o,
});

/** 시험용 사본 저장소: 회차→공연 지도로 모르는 회차를 가르고, 판 번호가 클 때만 쓴다 */
class MemoryEventSaleStateStore implements EventSaleStateStore {
  readonly rows = new Map<string, EventSaleStatusEvent>();
  readonly applied: EventSaleStatusEvent[] = [];
  constructor(private readonly productionOf: ReadonlyMap<string, string>) {}

  async apply(e: EventSaleStatusEvent): Promise<'applied' | 'stale' | 'unknown'> {
    if (!this.productionOf.has(e.eventId)) return 'unknown';
    const current = this.rows.get(e.eventId);
    if (current && !shouldApplyEventSale(current.version, e.version)) return 'stale';
    this.rows.set(e.eventId, { ...e });
    this.applied.push({ ...e });
    return 'applied';
  }

  statusesOf(productionId: string): EventSaleState[] {
    return [...this.rows.values()].filter((e) => this.productionOf.get(e.eventId) === productionId).map((e) => e.status);
  }
}

function setup() {
  const store = new MemoryEventSaleStateStore(
    new Map([
      [EVENT_A, PROD_A],
      [EVENT_B, PROD_B],
    ]),
  );
  const warnings: { o: object; msg?: string }[] = [];
  const handler = new CoreEventSaleChangedHandler(store, undefined, { logger: { info: () => undefined, warn: (o, msg) => void warnings.push({ o, msg }) } });
  return { store, warnings, handler };
}

/** 플랫폼 소비자처럼 decode → handle 차례로 부른다 */
async function deliver(handler: CoreEventSaleChangedHandler, m: ConsumedMessage): Promise<EventSaleRecord> {
  const record = await handler.decode(m);
  await handler.handle(record, m);
  return record;
}

describe('F-07-12 RV-02 core 회차 판매 상태 사본 소비자', () => {
  test('RV2-01 ALL_HELD 사건을 읽어 사본에 그대로 쓴다', async () => {
    const { store, handler } = setup();
    const record = await deliver(handler, message(sale()));

    expect(record).toMatchObject({ kind: 'sale' });
    expect(store.rows.get(EVENT_A)).toMatchObject({ eventId: EVENT_A, status: 'ALL_HELD', version: 3, changedAt: new Date(T0).toISOString() });
    expect(handler.keyOf(record)).toBe(EVENT_A);
    expect(handler.eventKeyOf?.(record)).toBe(EVENT_KEY);
  });

  test('RV2-02 좌석 사건(type 칸)은 건너뛰고, 모양이 틀린 값은 bad 키로 보류한다', async () => {
    const { store, handler } = setup();
    const seat = await handler.decode(message({ type: 'HOLD', eventId: EVENT_A, seatId: 's-1' }, { key: EVENT_A }));
    await handler.handle(seat, message({}));
    expect(seat).toMatchObject({ kind: 'skip', key: `skip:${EVENT_A}` });
    expect(store.rows.size).toBe(0);

    const broken = await handler.decode(message({ ...sale(), status: 'NOT_A_STATUS' }));
    expect(broken).toMatchObject({ kind: 'bad', key: `bad:${EVENT_A}` });
    await expect(handler.handle(broken, message({}))).rejects.toBeInstanceOf(RangeError);

    const empty = await handler.decode(message(null, { key: EVENT_A }));
    expect(empty).toMatchObject({ kind: 'bad', key: `bad:${EVENT_A}` });
    const notJson = await handler.decode(message('{not json', { key: EVENT_A }));
    expect(notJson).toMatchObject({ kind: 'bad', key: `bad:${EVENT_A}` });
  });

  test('RV2-03 늦게 온 작은 판은 무시하고 지금 판을 지킨다', async () => {
    const { store, handler } = setup();
    await deliver(handler, message(sale({ status: 'ON_SALE', version: 5 })));
    await deliver(handler, message(sale({ status: 'ALL_HELD', version: 4 })));
    expect(store.rows.get(EVENT_A)).toMatchObject({ status: 'ON_SALE', version: 5 });
  });

  test('RV2-04 같은 판을 다시 처리해도 결과가 같고 행은 하나다', async () => {
    const { store, handler } = setup();
    await deliver(handler, message(sale({ version: 5 })));
    await deliver(handler, message(sale({ version: 5 })));
    expect(store.rows.size).toBe(1);
    expect(store.applied).toHaveLength(1);
    expect(store.rows.get(EVENT_A)).toMatchObject({ status: 'ALL_HELD', version: 5 });
  });

  test('RV2-05 판 번호 순서대로 ON_SALE → ALL_HELD → SOLD_OUT을 반영한다', async () => {
    const { store, handler } = setup();
    for (const [version, status] of [
      [1, 'ON_SALE'],
      [2, 'ALL_HELD'],
      [3, 'SOLD_OUT'],
    ] as const) {
      await deliver(handler, message(sale({ status, version, eventKey: randomUUID() })));
    }
    expect(store.rows.get(EVENT_A)).toMatchObject({ status: 'SOLD_OUT', version: 3 });
  });

  test('RV2-06 core에 없는 회차는 쓰지 않고 경고만 남긴다', async () => {
    const { store, warnings, handler } = setup();
    const record = await handler.decode(message(sale({ eventId: 'evt-missing' }), { key: 'evt-missing' }));
    await handler.handle(record, message({}));
    expect(store.rows.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.o).toMatchObject({ kind: 'event-sale-status-unknown', eventId: 'evt-missing' });
  });

  test('RV2-09 모양이 틀린 사건 하나가 같은 회차의 뒤 정상 판을 막지 않는다', async () => {
    const { store, handler } = setup();
    // 모양이 틀린 값은 'bad:<회차 ID>' 키로 보류되고, 정상 사건의 업무 키 '<회차 ID>'와 다르다
    const broken = await handler.decode(message('{not json', { offset: 1n }));
    expect(broken).toMatchObject({ kind: 'bad', key: `bad:${EVENT_A}` });
    await expect(handler.handle(broken, message({}))).rejects.toBeInstanceOf(RangeError);
    await deliver(handler, message(sale({ status: 'ON_SALE', version: 6 }), { offset: 2n }));
    expect(store.rows.get(EVENT_A)).toMatchObject({ status: 'ON_SALE', version: 6 });
  });

  test('RV2-10 다른 공연·다른 테넌트의 회차 사본은 바꾸지 않는다', async () => {
    const { store, handler } = setup();
    await deliver(handler, message(sale({ eventId: EVENT_A, status: 'ALL_HELD', version: 1 })));
    expect(store.statusesOf(PROD_A)).toEqual(['ALL_HELD']);
    expect(store.statusesOf(PROD_B)).toEqual([]);

    await deliver(handler, message(sale({ eventId: EVENT_B, status: 'SOLD_OUT', version: 1, eventKey: OTHER_EVENT_KEY }), { key: EVENT_B }));
    expect(store.statusesOf(PROD_A)).toEqual(['ALL_HELD']);
    expect(store.statusesOf(PROD_B)).toEqual(['SOLD_OUT']);
  });
});
