// 주문 애그리거트의 DB 없는 규칙: 전이 표·번호 찾기·사건 종류·eventKey·사건 만들기·행위자 모양(BUILD_ORDER PRF-160,
// docs/features/payment.md §3 전이 표와 '주문 저장소의 첫 구현', docs/data.md §2 purchase_order·order_event·order_item, ADR-0113·0052·0099·0150·0171).
// 만든 사건은 asyncapi OrderEvent(packages/contracts zod)를 통과하고 칸 이름이 Avro OrderEvent.avsc의 필드여야 한다.
// 사건 만들기 시험은 전이를 transitionById가 아니라 ORDER_TRANSITIONS에서 직접 꺼내고, 기대 eventKey도 시험 안에서 계산한다(실패 이유가 섞이지 않게).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OrderEvent } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import {
  ACTOR_PATTERN,
  type BuildOrderEventInput,
  buildOrderEvent,
  type CreatedExtras,
  FIRST_IN_STAGE_STATUSES,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  type OrderEventType,
  type OrderItem,
  type OrderRow,
  type OrderStatus,
  type OrderTransition,
  orderEventKey,
  orderEventType,
  PAYMENT_RESULT_TRANSITIONS,
  type SeatAssignment,
  transitionById,
} from '../src/modules/booking/index.js';
import { uuid8 } from '../src/modules/inventory/domain/purchase-session.js';

/** 회차·주문·계정·좌석(운영 모양: 소문자 UUID, 주문 ID는 UUIDv7) */
const EV = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const ORDER = '0190f3a1-7c2e-7a00-8000-0000000000d1';
const OTHER_ORDER = '0190f3a1-7c2e-7a00-8000-0000000000d2';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000acc01';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-00000000a001';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-00000000a002';
const PSID = 'jti-abc-1';
const JNY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const CONTACT = 'v1.c0ntactRefAbC123';
const AT = Date.parse('2026-11-05T03:00:00.123Z');

/** 주문 항목(줄 번호 차례). 좌석 ID가 정렬 차례가 아니게 두어 seatIds가 항목 차례를 따르는지 본다. 등급 이름에 한글을 넣는다 */
const ITEMS: readonly OrderItem[] = [
  { seatId: SEAT_B, tierId: '일반석-R', sectionId: 'sec-b', unitPrice: 99_000 },
  { seatId: SEAT_A, tierId: 'tier-s', sectionId: 'sec-a', unitPrice: 55_000 },
];
const AMOUNT = 154_000;
const MESSAGE_ITEMS = [
  { seatId: SEAT_B, tierId: '일반석-R', sectionId: 'sec-b', price: 99_000 },
  { seatId: SEAT_A, tierId: 'tier-s', sectionId: 'sec-a', price: 55_000 },
];
const CREATED_EXTRAS: CreatedExtras = { purchaseSessionId: PSID, journeyId: JNY, contactRef: CONTACT, refMissing: false };

const UUID8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** SHA-256(입력)의 앞 16바이트에 UUID 버전 8·변형 비트를 맞춘 글(정본 식을 시험 안에서 직접 계산한다) */
function uuid8Of(input: string): string {
  const b = Buffer.from(createHash('sha256').update(input).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** payment §3 전이 표를 손으로 옮긴 것(번호·출발·도착, 번호 차례). (시작)은 null */
const CANON_TABLE: readonly (readonly [string, OrderStatus | null, OrderStatus])[] = [
  ['T1', null, 'CREATED'],
  ['T2', 'CREATED', 'CREATED'],
  ['T3', 'CREATED', 'AUTHENTICATED'],
  ['T4', 'AUTHENTICATED', 'ACCEPTED'],
  ['T5', 'CREATED', 'EXPIRED'],
  ['T6', 'AUTHENTICATED', 'EXPIRED'],
  ['T7', 'ACCEPTED', 'RESERVED'],
  ['T8', 'ACCEPTED', 'FAILED'],
  ['T9', 'RESERVED', 'APPROVED'],
  ['T10', 'RESERVED', 'AWAITING_DEPOSIT'],
  ['T11', 'RESERVED', 'FAILED'],
  ['T12', 'RESERVED', 'UNKNOWN'],
  ['T13', 'UNKNOWN', 'APPROVED'],
  ['T14', 'UNKNOWN', 'AWAITING_DEPOSIT'],
  ['T15', 'UNKNOWN', 'FAILED'],
  ['T16', 'AWAITING_DEPOSIT', 'APPROVED'],
  ['T17', 'AWAITING_DEPOSIT', 'FAILED'],
  ['T18', 'APPROVED', 'CONFIRMED'],
  ['T19', 'APPROVED', 'APPROVED'],
  ['T20', 'APPROVED', 'COMPENSATED'],
  ['T21', 'CONFIRMED', 'AWAITING_DEPOSIT'],
  ['T22', 'CONFIRMED', 'PARTIALLY_REFUNDED'],
  ['T23', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  ['T24', 'CONFIRMED', 'REFUNDED'],
  ['T25', 'PARTIALLY_REFUNDED', 'PARTIALLY_REFUNDED'],
  ['T26', 'REFUNDED', 'REFUNDED'],
];

/**
 * 전이마다 기대하는 사건 종류(payment §3 '주문 저장소의 첫 구현'): 도착 상태와 같은 이름, T21만 DEPOSIT_REVERSED,
 * 도착이 AUTHENTICATED(T3)·UNKNOWN(T12)인 전이와 같은 상태로 도는 T2·T19는 사건 없음(undefined), T25·T26은 그 상태 이름
 */
const EXPECTED_TYPE: readonly (readonly [string, OrderEventType | undefined])[] = [
  ['T1', 'CREATED'],
  ['T2', undefined],
  ['T3', undefined],
  ['T4', 'ACCEPTED'],
  ['T5', 'EXPIRED'],
  ['T6', 'EXPIRED'],
  ['T7', 'RESERVED'],
  ['T8', 'FAILED'],
  ['T9', 'APPROVED'],
  ['T10', 'AWAITING_DEPOSIT'],
  ['T11', 'FAILED'],
  ['T12', undefined],
  ['T13', 'APPROVED'],
  ['T14', 'AWAITING_DEPOSIT'],
  ['T15', 'FAILED'],
  ['T16', 'APPROVED'],
  ['T17', 'FAILED'],
  ['T18', 'CONFIRMED'],
  ['T19', undefined],
  ['T20', 'COMPENSATED'],
  ['T21', 'DEPOSIT_REVERSED'],
  ['T22', 'PARTIALLY_REFUNDED'],
  ['T23', 'REFUNDED'],
  ['T24', 'REFUNDED'],
  ['T25', 'PARTIALLY_REFUNDED'],
  ['T26', 'REFUNDED'],
];
const EVENT_TRANSITIONS = EXPECTED_TYPE.filter(([, type]) => type !== undefined) as readonly (readonly [string, OrderEventType])[];
const SILENT_TRANSITIONS = EXPECTED_TYPE.filter(([, type]) => type === undefined).map(([id]) => id);

/** 표에서 직접 꺼낸 전이(transitionById를 거치지 않는다) */
function T(id: string): OrderTransition {
  const t = ORDER_TRANSITIONS.find((x) => x.id === id);
  if (!t) throw new Error(`표에 없는 번호 ${id}`);
  return t;
}

/** 전이 뒤의 주문 행(status = 도착, event_seq = 이번 이력 번호) */
function rowAfter(t: OrderTransition, seq: number, over: Partial<OrderRow> = {}): OrderRow {
  return { id: ORDER, accountId: ACCOUNT, eventId: EV, status: t.to, amount: AMOUNT, eventSeq: seq, paymentEventSeq: t.id === 'T1' ? 0 : 2, seatAssignment: 'PICK', ...over };
}

interface InputOptions {
  seq?: number;
  reachedBefore?: boolean;
  items?: readonly OrderItem[];
  /** 주지 않으면 T1만 CREATED_EXTRAS, 그 밖은 칸을 두지 않는다. null이면 T1에도 두지 않는다 */
  created?: CreatedExtras | null;
  seatAssignment?: SeatAssignment;
}

function inputFor(id: string, o: InputOptions = {}): BuildOrderEventInput {
  const t = T(id);
  const seq = o.seq ?? (id === 'T1' ? 1 : 5);
  const created = o.created === undefined ? (id === 'T1' ? CREATED_EXTRAS : undefined) : (o.created ?? undefined);
  const base = {
    order: rowAfter(t, seq, o.seatAssignment ? { seatAssignment: o.seatAssignment } : {}),
    items: o.items ?? ITEMS,
    transition: t,
    seq,
    occurredAtMs: AT,
    reachedBefore: o.reachedBefore ?? false,
  };
  return created ? { ...base, created } : base;
}

/** JSON으로 내보냈을 때 남는 칸 이름(undefined 칸은 빠진다) */
const jsonKeys = (m: object): string[] => Object.keys(JSON.parse(JSON.stringify(m)) as object);

describe('ORDER_TRANSITIONS: payment §3 전이 표와 같다', () => {
  test('ADR0113_전이 26개가 번호 차례(T1~T26)이고 칸마다(번호·출발·도착) 정본 표와 같다 [ASVS v5.0.0-2.3.1]', () => {
    expect(ORDER_TRANSITIONS).toHaveLength(26);
    expect(ORDER_TRANSITIONS.map((t) => [t.id, t.from, t.to])).toEqual(CANON_TABLE.map((r) => [...r]));
    expect(ORDER_TRANSITIONS.map((t) => t.id)).toEqual(Array.from({ length: 26 }, (_, i) => `T${i + 1}`));
    // 출발이 비는 것은 주문 생성(T1)뿐이다
    expect(ORDER_TRANSITIONS.filter((t) => t.from === null).map((t) => t.id)).toEqual(['T1']);
  });

  test('ADR0113_손으로 옮긴 표가 정본 문서(docs/features/payment.md §3 전이 표)의 행과 같다(문서가 바뀌면 여기서 먼저 깨진다) [ASVS v5.0.0-2.3.1]', () => {
    const md = readFileSync(new URL('../../../docs/features/payment.md', import.meta.url), 'utf8');
    const start = md.indexOf('## 3. 상태 전이');
    const end = md.indexOf('\n## 4.', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const rows = [...md.slice(start, end).matchAll(/^\| (T\d+) \| ([^|]+?) \| ([^|]+?) \|/gm)].map((m) => [m[1], m[2] === '(시작)' ? null : m[2], m[3]]);
    expect(rows).toEqual(CANON_TABLE.map((r) => [...r]));
  });

  test('ADR0113_출발·도착은 모두 저장 값 열세 개(docs/data.md purchase_order.status) 가운데 하나다', () => {
    // data.md §2 purchase_order.status를 손으로 옮긴 것
    expect([...ORDER_STATUSES].sort()).toEqual(
      ['CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED'].sort(),
    );
    const statuses = new Set<string>(ORDER_STATUSES);
    for (const t of ORDER_TRANSITIONS) {
      expect(statuses.has(t.to), `${t.id} 도착`).toBe(true);
      if (t.from !== null) expect(statuses.has(t.from), `${t.id} 출발`).toBe(true);
    }
  });

  // T11은 이 목록에 남는다: 순번을 주면 다른 결제 결과 전이처럼 payment_event_seq 조건을 걸고, Saga가 승인 기한을 넘겨 결제 사건 없이 끝낼 때는
  // 순번 없이 상태 조건만으로 받는다(payment §3 '주문 저장소의 첫 구현', PRF-165). 순번 없는 T11을 주문 전이 함수가 받는지는 test-int(주문 저장소 통합 시험)가 본다
  test('ADR0113_결제 결과 반영 전이(PAYMENT_RESULT_TRANSITIONS)는 정확히 T9~T17과 T21(입금 되돌림, 결제사 사건으로 온다)이다', () => {
    const num = (id: string) => Number(id.slice(1));
    expect([...PAYMENT_RESULT_TRANSITIONS].sort((a, b) => num(a) - num(b))).toEqual(['T9', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15', 'T16', 'T17', 'T21']);
  });

  test('ADR0099_firstInStage를 셀 수 있는 도착 상태(FIRST_IN_STAGE_STATUSES)는 정확히 ACCEPTED·APPROVED·CONFIRMED다', () => {
    expect([...FIRST_IN_STAGE_STATUSES].sort()).toEqual(['ACCEPTED', 'APPROVED', 'CONFIRMED']);
  });
});

describe('transitionById: 번호로 전이 찾기', () => {
  test.each(CANON_TABLE.map((r) => [...r] as const))('ADR0113_%s는 표의 그 전이(출발 %s, 도착 %s)다 [ASVS v5.0.0-2.3.1]', (id, from, to) => {
    expect(transitionById(id)).toEqual({ id, from, to });
  });

  test.each(['T0', 'T27', 'x', '', 't1', 'T01', ' T1', 'T1 ', 'T-1', 'T1.0', 'toString', '__proto__', 'constructor', 'hasOwnProperty'])(
    'ADR0113_표에 없는 번호 %j는 undefined다(던지지 않는다) [ASVS v5.0.0-2.3.1]',
    (id) => {
      expect(transitionById(id)).toBeUndefined();
    },
  );
});

describe('orderEventType: 전이가 내는 사건 종류', () => {
  test.each(EXPECTED_TYPE.map((r) => [...r] as const))('ADR0113_%s의 사건 종류는 %s다', (id, type) => {
    expect(orderEventType(T(id))).toBe(type);
  });

  test('ADR0113_사건 없는 전이는 정확히 T2·T3·T12·T19이고, 사건 종류는 모두 계약 OrderEvent.type 값이다 [ASVS v5.0.0-2.2.1]', () => {
    expect(SILENT_TRANSITIONS).toEqual(['T2', 'T3', 'T12', 'T19']);
    const contractTypes = new Set<string>(OrderEvent.shape.type.options);
    for (const [id] of EVENT_TRANSITIONS) {
      const type = orderEventType(T(id));
      expect(type, id).toBeDefined();
      expect(contractTypes.has(type!), `${id} ${type}`).toBe(true);
    }
  });
});

describe('orderEventKey: 주문 사건의 중복 제거 키', () => {
  const pairs: readonly (readonly [string, number])[] = [
    [ORDER, 1],
    [ORDER, 2],
    [ORDER, 10],
    [ORDER, 26],
    [OTHER_ORDER, 1],
    ['o-1', 7],
  ];

  test('ADR0052_UUID 버전 8 모양이고(버전 니블 8, 변형 비트 10xx, 소문자 16진) 정본 식 SHA-256("OrderEvent:" + 주문 ID + ":" + 이력 번호)의 앞 16바이트와 같다', () => {
    for (const [id, seq] of pairs) {
      const k = orderEventKey(id, seq);
      expect(k, `${id}:${seq}`).toMatch(UUID8);
      expect(k, `${id}:${seq}`).toBe(uuid8Of(`OrderEvent:${id}:${seq}`));
    }
  });

  test('ADR0052_inventory의 uuid8("OrderEvent:<주문 ID>:<번호>")와 같은 값이다(좌석·구매 세션 사건과 같은 계산법)', () => {
    for (const [id, seq] of pairs) expect(orderEventKey(id, seq), `${id}:${seq}`).toBe(uuid8(`OrderEvent:${id}:${seq}`));
  });

  test('ADR0052_같은 입력이면 같은 값(같은 전이를 다시 보내도 같다)이고, 주문이나 번호가 다르면 다른 값이다', () => {
    expect(orderEventKey(ORDER, 3)).toBe(orderEventKey(ORDER, 3));
    const keys = pairs.map(([id, seq]) => orderEventKey(id, seq));
    expect(new Set(keys).size).toBe(keys.length);
    expect(orderEventKey(ORDER, 1)).not.toBe(orderEventKey(OTHER_ORDER, 1));
    expect(orderEventKey(ORDER, 1)).not.toBe(orderEventKey(ORDER, 11));
  });
});

describe('buildOrderEvent: 전이 하나의 OrderEvent', () => {
  test('ADR0150_ADR0171_T1(CREATED)은 주문 행·항목과 CREATED 칸(purchaseSessionId·journeyId·contactRef·refMissing)을 싣는다: price = unitPrice, seatIds는 항목 차례, occurredAt은 ISO 8601(UTC, 밀리초), eventKey는 이력 번호 1의 키 [ASVS v5.0.0-2.2.1]', () => {
    const m = buildOrderEvent(inputFor('T1'));
    expect(m).toEqual({
      eventId: EV,
      orderId: ORDER,
      accountId: ACCOUNT,
      type: 'CREATED',
      amount: AMOUNT,
      seatIds: [SEAT_B, SEAT_A],
      purchaseSessionId: PSID,
      journeyId: JNY,
      contactRef: CONTACT,
      refMissing: false,
      items: MESSAGE_ITEMS,
      seatAssignment: 'PICK',
      firstInStage: false,
      occurredAt: '2026-11-05T03:00:00.123Z',
      eventKey: uuid8Of(`OrderEvent:${ORDER}:1`),
    });
    // 항목 칸은 정확히 넷(unitPrice는 price로 바뀌고 남지 않는다)
    for (const item of m!.items) expect(Object.keys(item).sort()).toEqual(['price', 'seatId', 'sectionId', 'tierId']);
    expect(m!.occurredAt).toBe(new Date(AT).toISOString());
  });

  test('ADR0171_T1에서 contactRef를 계산하지 못했으면(refMissing true) contactRef 없이 refMissing true를 싣는다. 구매 세션·여정 ID를 주지 않았으면 그 칸도 없다 [ASVS v5.0.0-2.2.1]', () => {
    const m = buildOrderEvent(inputFor('T1', { created: { purchaseSessionId: PSID, journeyId: JNY, refMissing: true } }))!;
    expect(m.refMissing).toBe(true);
    expect(m.contactRef).toBeUndefined();
    expect(m.purchaseSessionId).toBe(PSID);
    expect(m.journeyId).toBe(JNY);
    expect(jsonKeys(m)).not.toContain('contactRef');
    const bare = buildOrderEvent(inputFor('T1', { created: { refMissing: true } }))!;
    expect(bare.type).toBe('CREATED');
    for (const k of ['purchaseSessionId', 'journeyId', 'contactRef']) expect(jsonKeys(bare), k).not.toContain(k);
  });

  test('ADR0150_T1 밖 전이(T4 ACCEPTED)는 주문 행·항목만 싣고 purchaseSessionId·journeyId·contactRef가 없다(refMissing은 계약 기본값 false), eventKey는 그 이력 번호의 키다 [ASVS v5.0.0-2.2.1]', () => {
    // 정본 모호: refMissing도 'CREATED에만 싣는다'고 했지만 OrderEventMessage 형은 refMissing이 필수 boolean이다. 뒤 사건은 계약(asyncapi·avsc) 기본값 false라고 가정한다
    const m = buildOrderEvent(inputFor('T4', { seq: 3 }));
    expect(m).toEqual({
      eventId: EV,
      orderId: ORDER,
      accountId: ACCOUNT,
      type: 'ACCEPTED',
      amount: AMOUNT,
      seatIds: [SEAT_B, SEAT_A],
      refMissing: false,
      items: MESSAGE_ITEMS,
      seatAssignment: 'PICK',
      firstInStage: true,
      occurredAt: '2026-11-05T03:00:00.123Z',
      eventKey: uuid8Of(`OrderEvent:${ORDER}:3`),
    });
    for (const k of ['purchaseSessionId', 'journeyId', 'contactRef']) expect(jsonKeys(m!), k).not.toContain(k);
  });

  test.each(EVENT_TRANSITIONS.filter(([id]) => id !== 'T1').map((r) => [...r] as const))(
    'ADR0150_%s는 사건 종류 %s이고 CREATED 칸(purchaseSessionId·journeyId·contactRef)이 없으며 주문 행·항목 칸과 그 이력 번호의 eventKey를 싣는다',
    (id, type) => {
      const m = buildOrderEvent(inputFor(id, { seq: 7 }))!;
      expect(m).toBeDefined();
      expect(m.type).toBe(type);
      expect(m.orderId).toBe(ORDER);
      expect(m.eventId).toBe(EV);
      expect(m.accountId).toBe(ACCOUNT);
      expect(m.amount).toBe(AMOUNT);
      expect(m.seatIds).toEqual([SEAT_B, SEAT_A]);
      expect(m.items).toEqual(MESSAGE_ITEMS);
      expect(m.seatAssignment).toBe('PICK');
      expect(m.refMissing).toBe(false);
      expect(m.occurredAt).toBe(new Date(AT).toISOString());
      expect(m.eventKey).toBe(uuid8Of(`OrderEvent:${ORDER}:7`));
      for (const k of ['purchaseSessionId', 'journeyId', 'contactRef']) expect(jsonKeys(m), k).not.toContain(k);
    },
  );

  test('ADR0150_좌석 고르기 방식은 주문 행의 seat_assignment를 그대로 싣는다(AUTO) [ASVS v5.0.0-2.2.1]', () => {
    expect(buildOrderEvent(inputFor('T1', { seatAssignment: 'AUTO' }))!.seatAssignment).toBe('AUTO');
    expect(buildOrderEvent(inputFor('T18', { seatAssignment: 'AUTO' }))!.seatAssignment).toBe('AUTO');
  });

  test.each(SILENT_TRANSITIONS)('ADR0113_사건이 없는 전이 %s는 undefined다(이력만 쓰고 Outbox 행을 넣지 않는다)', (id) => {
    expect(buildOrderEvent(inputFor(id))).toBeUndefined();
    expect(buildOrderEvent(inputFor(id, { reachedBefore: true }))).toBeUndefined();
  });

  test('ADR0099_firstInStage는 도착이 ACCEPTED·APPROVED·CONFIRMED이고 그 주문 이력에 같은 도착이 앞에 없을 때(reachedBefore 거짓)만 참이고, 다른 도착은 늘 거짓이다', () => {
    const first = new Set<string>(['ACCEPTED', 'APPROVED', 'CONFIRMED']);
    const seen: string[] = [];
    for (const [id] of EVENT_TRANSITIONS) {
      for (const reachedBefore of [false, true]) {
        const m = buildOrderEvent(inputFor(id, { reachedBefore }))!;
        const want = first.has(T(id).to) && !reachedBefore;
        expect({ id, reachedBefore, firstInStage: m.firstInStage }).toEqual({ id, reachedBefore, firstInStage: want });
        if (want) seen.push(id);
      }
    }
    // 참이 될 수 있는 전이: 접수(T4), 승인(T9·T13·T16), 확정(T18)
    expect(seen).toEqual(['T4', 'T9', 'T13', 'T16', 'T18']);
  });

  test('ADR0099_입금 되돌림(T21) 뒤 다시 승인(T16)·확정(T18)하면 firstInStage는 거짓이다(퍼널을 주문마다 한 번 센다)', () => {
    expect(buildOrderEvent(inputFor('T21', { seq: 4 }))!.firstInStage).toBe(false);
    expect(buildOrderEvent(inputFor('T16', { seq: 5, reachedBefore: true }))!.firstInStage).toBe(false);
    expect(buildOrderEvent(inputFor('T18', { seq: 6, reachedBefore: true }))!.firstInStage).toBe(false);
  });

  test('ADR0052_만든 사건은 모두 계약 Zod 스키마(OrderEvent)를 통과하고, 칸 이름은 모두 계약과 Avro 스키마 OrderEvent의 필드다 [ASVS v5.0.0-2.2.1]', () => {
    const avsc = JSON.parse(readFileSync(new URL('../../../docs/api/avro/peaket/trade/OrderEvent.avsc', import.meta.url), 'utf8')) as { fields: { name: string }[] };
    const avroNames = new Set(avsc.fields.map((f) => f.name));
    const zodNames = new Set(Object.keys(OrderEvent.shape));
    const inputs: BuildOrderEventInput[] = [
      inputFor('T1'),
      inputFor('T1', { created: { purchaseSessionId: PSID, journeyId: JNY, refMissing: true } }),
      inputFor('T1', { created: { refMissing: true }, seatAssignment: 'AUTO' }),
    ];
    for (const [id] of EVENT_TRANSITIONS) for (const reachedBefore of [false, true]) inputs.push(inputFor(id, { reachedBefore }));
    for (const input of inputs) {
      const m = buildOrderEvent(input)!;
      const label = `${input.transition.id} ${JSON.stringify(input.created ?? null)}`;
      const r = OrderEvent.safeParse(m);
      expect(r.success, `${label} ${JSON.stringify(r.error?.issues ?? [])}`).toBe(true);
      // JSON으로 오가도(대역 값) 통과한다
      expect(OrderEvent.safeParse(JSON.parse(JSON.stringify(m))).success, label).toBe(true);
      for (const k of Object.keys(m)) {
        expect(zodNames.has(k), `${label} 계약에 없는 칸 ${k}`).toBe(true);
        expect(avroNames.has(k), `${label} Avro에 없는 칸 ${k}`).toBe(true);
      }
    }
  });

  test('ADR0113_T1인데 created가 없으면 RangeError다 [ASVS v5.0.0-2.2.1]', () => {
    expect(() => buildOrderEvent(inputFor('T1', { created: null }))).toThrow(RangeError);
  });

  test.each(EVENT_TRANSITIONS.filter(([id]) => id !== 'T1').map(([id]) => id))('ADR0150_T1 밖 전이 %s에 created를 주면 RangeError다(CREATED 칸은 CREATED에만) [ASVS v5.0.0-2.2.1]', (id) => {
    expect(() => buildOrderEvent(inputFor(id, { created: CREATED_EXTRAS }))).toThrow(RangeError);
  });

  test.each(['T1', 'T4', 'T18', 'T21', 'T24'])('ADR0113_%s의 항목이 비었으면 RangeError다 [ASVS v5.0.0-2.2.1]', (id) => {
    expect(() => buildOrderEvent(inputFor(id, { items: [] }))).toThrow(RangeError);
  });
});

describe('ACTOR_PATTERN: order_event.actor 모양', () => {
  const UUID = '0190f3a1-7c2e-7a00-8000-0000000acc01';

  test.each([
    `account:${UUID}`,
    `admin:${UUID}`,
    'admin:9a1f0c3e-4b2d-4c8e-9f00-000000000001',
    'system:order-expiry',
    'system:payment-saga',
    'system:order-history-check',
    'system:a',
    'system:t2',
    // 작업 이름 63자(뼈대 주석의 한도 1~63자)
    `system:${'a'.repeat(63)}`,
  ])('ADR0113_%j는 통과한다', (actor) => {
    expect(ACTOR_PATTERN.test(actor)).toBe(true);
  });

  test.each([
    // 대문자 UUID
    `account:${UUID.toUpperCase()}`,
    `admin:${UUID.toUpperCase()}`,
    // 빈 이름·빈 ID
    'system:',
    'account:',
    'admin:',
    '',
    // 다른 접두어
    `user:${UUID}`,
    `fan:${UUID}`,
    `ACCOUNT:${UUID}`,
    'System:order-expiry',
    `${UUID}`,
    // 작업 이름 64자·65자(뼈대 주석의 한도 63자를 넘음)
    `system:${'a'.repeat(64)}`,
    `system:${'a'.repeat(65)}`,
    // UUID 모양이 아님
    `account:${UUID.replaceAll('-', '')}`,
    `account:{${UUID}}`,
    'account:A01',
    // 앞뒤 공백·줄바꿈, 두 행위자 이어 붙임
    ` account:${UUID}`,
    `account:${UUID}\n`,
    `account:${UUID}\nsystem:x`,
    // 작업 이름에 대문자·밑줄·공백(뼈대 주석: 소문자·숫자·하이픈)
    'system:OrderExpiry',
    'system:order_expiry',
    'system:order expiry',
  ])('ADR0113_%j는 거절한다', (actor) => {
    expect(ACTOR_PATTERN.test(actor)).toBe(false);
  });
});
