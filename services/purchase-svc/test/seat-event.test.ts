// 좌석 Redis Stream 항목 → Kafka 사건 바꾸기와 홀드 원장 사건 읽기(BUILD_ORDER PRF-141, docs/features/seat-hold.md §6 '홀드 원장 적재의 첫 구현',
// docs/data.md §3 s:{event:E}:stream의 HELD·EXPIRED 칸, asyncapi SeatEvent·PurchaseSessionStarted·PurchaseSessionEnded).
// 칸 이름은 홀드 Lua(adapters/hold-lua.ts)와 만료 Lua(adapters/expire-lua.ts)가 XADD하는 것과 같다. 값은 모두 글이다.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SeatEvent } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import {
  HOLD_EVENT_TYPES,
  PURCHASE_SESSION_TOPIC,
  SEAT_TOPIC,
  type HoldEventType,
  type LedgerHoldEvent,
  type SeatEventMessage,
  type SeatStreamEntry,
  routeStreamEntry,
  seatEventKey,
  sessionEndedFields,
  sessionStartedFields,
  toLedgerHoldEvent,
  toPurchaseSessionEnded,
  toPurchaseSessionStarted,
  toSeatEvent,
} from '../src/modules/inventory/index.js';

/** 회차·좌석·계정·홀드 ID(운영 모양: 소문자 UUID. 좌석 ID는 좌석 표 seat.id, 홀드 ID는 uuidv7) */
const EV = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const SEAT = '0190f3a1-7c2e-7a00-8000-00000000a001';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000acc01';
const HOLD = '019a4b2c-1d00-7e00-8a00-00000000b01d';
const TIER = 'tier-r';
const SECTION = 'sec-a';
const PSID = 'jti-abc-1';
const JNY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
/** 펜싱 토큰: 지금 시각의 µs라 16자리 10진 글이다(fence = max(fence + 1, µs)) */
const TOKEN = '1762225200123456';
const HELD_AT = Date.parse('2026-11-04T03:00:00.123Z');
const EXP = HELD_AT + 7 * 60_000;
const EXPIRED_AT = EXP + 250;

/** SHA-256(입력)의 앞 16바이트에 UUID 버전 8·변형 비트를 맞춘 글(정본 식을 시험 안에서 직접 계산한다) */
function uuid8Of(input: string): string {
  const b = Buffer.from(createHash('sha256').update(input).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const UUID8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 홀드 Lua가 좌석 하나에 XADD하는 HELD 칸(hold-lua.ts 269~274줄과 같은 이름·차례) */
function heldFields(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    type: 'HELD',
    seatIdx: '17',
    seatId: SEAT,
    tierId: TIER,
    sectionId: SECTION,
    holdId: HOLD,
    holdKind: 'FAN',
    purchaseSessionId: PSID,
    accountId: ACCOUNT,
    fencingToken: TOKEN,
    sectionVersion: '42',
    seatEpoch: '1762225000',
    occurredAtMs: String(HELD_AT),
    expiresAtMs: String(EXP),
    ...over,
  };
}

/** 만료 Lua가 푼 좌석에 XADD하는 EXPIRED 칸(expire-lua.ts 288~292줄): 토큰은 그 홀드의 것, occurredAtMs는 푼 시각, expiresAtMs는 Hash의 exp */
function expiredFields(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return heldFields({ type: 'EXPIRED', sectionVersion: '43', occurredAtMs: String(EXPIRED_AT), ...over });
}

/** 위 HELD 칸을 바꾼 SeatEvent(정본 식으로 손으로 쓴 기대값) */
function heldMessage(over: Partial<SeatEventMessage> = {}): SeatEventMessage {
  return {
    eventId: EV,
    seatId: SEAT,
    tierId: TIER,
    sectionId: SECTION,
    type: 'HELD',
    fencingToken: 1762225200123456,
    sectionVersion: 42,
    seatEpoch: 1762225000,
    holdId: HOLD,
    holdKind: 'FAN',
    purchaseSessionId: PSID,
    accountId: ACCOUNT,
    expiresAt: '2026-11-04T03:07:00.123Z',
    occurredAt: '2026-11-04T03:00:00.123Z',
    eventKey: uuid8Of(`SeatEvent:HELD:${EV}:${HOLD}:${SEAT}:${TOKEN}`),
    ...over,
  };
}

/** Kafka에서 읽어 JSON으로 푼 SeatEvent 값(홀드 사건) */
function seatEventValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...heldMessage(), ...over })) as Record<string, unknown>;
}

const entry = (fields: Record<string, string | undefined>, id = '1762225200123-0'): SeatStreamEntry => ({ id, fields: fields as Record<string, string> });
const asMap = (flat: string[]): Record<string, string> => {
  const m: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) m[flat[i]!] = flat[i + 1]!;
  return m;
};
const startedFields = () =>
  asMap(sessionStartedFields({ eventId: EV, purchaseSessionId: PSID, admissionJti: PSID, journeyId: JNY, startedAtMs: HELD_AT - 60_000, maxStayUntilMs: HELD_AT + 44 * 60_000 }));
const endedFields = () => asMap(sessionEndedFields({ eventId: EV, purchaseSessionId: PSID, admissionJti: PSID, reason: 'LEFT', endedAtMs: HELD_AT + 5 * 60_000 }));

describe('seatEventKey: 홀드 사건의 중복 제거 키', () => {
  test('ADR0052_UUID 버전 8 모양이다: 버전 니블 8, 변형 비트 10xx, 소문자 16진', () => {
    for (const type of HOLD_EVENT_TYPES) {
      for (const [e, h] of [
        [EV, HOLD],
        ['ev-1', 'h-1'],
        ['a', 'b'],
      ] as const) {
        expect(seatEventKey(type, e, h, SEAT, Number(TOKEN)), `${type} ${e} ${h}`).toMatch(UUID8);
      }
    }
  });

  test('ADR0052_정본 식과 같다: SHA-256("SeatEvent:" + type + ":" + 회차 ID + ":" + holdId + ":" + 좌석 ID + ":" + 펜싱 토큰)의 앞 16바이트에 버전·변형 비트', () => {
    for (const type of ['HELD', 'RELEASED', 'EXPIRED'] as const) {
      expect(seatEventKey(type, EV, HOLD, SEAT, Number(TOKEN)), type).toBe(uuid8Of(`SeatEvent:${type}:${EV}:${HOLD}:${SEAT}:${TOKEN}`));
    }
    expect(seatEventKey('HELD', 'ev-1', 'h-1', 's-1', 7)).toBe(uuid8Of('SeatEvent:HELD:ev-1:h-1:s-1:7'));
    // 같은 holdId로 다시 잡은 홀드(새 토큰)는 다른 키다(PRF-142 코드 리뷰)
    expect(seatEventKey('HELD', 'ev-1', 'h-1', 's-1', 8)).not.toBe(seatEventKey('HELD', 'ev-1', 'h-1', 's-1', 7));
  });

  test('ADR0052_같은 입력이면 같은 값(같은 항목을 다시 보내도 같다)이고, type·회차·holdId 가운데 하나만 달라도 다른 값이다', () => {
    const base = seatEventKey('HELD', EV, HOLD, SEAT, Number(TOKEN));
    expect(seatEventKey('HELD', EV, HOLD, SEAT, Number(TOKEN))).toBe(base);
    const others = [
      seatEventKey('RELEASED', EV, HOLD, SEAT, Number(TOKEN)),
      seatEventKey('EXPIRED', EV, HOLD, SEAT, Number(TOKEN)),
      seatEventKey('HELD', '0190f3a1-7c2e-7a00-8000-0000000000e2', HOLD, SEAT, Number(TOKEN)),
      seatEventKey('HELD', EV, '019a4b2c-1d00-7e00-8a00-00000000b01e', SEAT, Number(TOKEN)),
      // 한 홀드가 잡은 다른 좌석(여러 좌석 홀드의 좌석끼리 키가 겹치지 않는다, PRF-141 시험 작성에서 찾음)
      seatEventKey('HELD', EV, HOLD, '0190f3a1-7c2e-7a00-8000-00000000a002', Number(TOKEN)),
      // 같은 holdId로 다시 잡은 홀드(새 펜싱 토큰, 좌석 묶기)도 다른 키다(PRF-142 코드 리뷰)
      seatEventKey('HELD', EV, HOLD, SEAT, Number(TOKEN) + 1),
    ];
    for (const k of others) expect(k).not.toBe(base);
    expect(new Set(others).size).toBe(others.length);
  });
});

describe('toSeatEvent: Stream 홀드 사건 칸 → SeatEvent', () => {
  test('ST35_HELD 칸을 바꾼다: 숫자 칸은 number, 시각은 ISO 8601(밀리초까지, UTC), eventKey는 seatEventKey(type, 회차, holdId, 좌석), FAN이면 purchaseSessionId를 싣고 priorityGrantId·seatIdx는 없다 [ASVS v5.0.0-2.2.1]', () => {
    const m = toSeatEvent(EV, heldFields());
    expect(m).toEqual(heldMessage());
    expect(m.occurredAt).toBe(new Date(HELD_AT).toISOString());
    expect(m.expiresAt).toBe(new Date(EXP).toISOString());
    expect(m.eventKey).toBe(seatEventKey('HELD', EV, HOLD, SEAT, Number(TOKEN)));
    expect(m.priorityGrantId).toBeUndefined();
    expect(Object.keys(m)).not.toContain('seatIdx');
    for (const k of ['fencingToken', 'sectionVersion', 'seatEpoch'] as const) expect(typeof m[k], k).toBe('number');
  });

  test('ST5_EXPIRED 칸을 바꾼다: 토큰은 그 홀드의 토큰 그대로(새 토큰이 아니다), occurredAt은 푼 시각, expiresAt은 홀드 만료 시각이고 eventKey는 EXPIRED의 키다 [S-T5]', () => {
    const m = toSeatEvent(EV, expiredFields());
    expect(m).toEqual(
      heldMessage({
        type: 'EXPIRED',
        sectionVersion: 43,
        occurredAt: new Date(EXPIRED_AT).toISOString(),
        expiresAt: new Date(EXP).toISOString(),
        eventKey: uuid8Of(`SeatEvent:EXPIRED:${EV}:${HOLD}:${SEAT}:${TOKEN}`),
      }),
    );
    expect(m.fencingToken).toBe(Number(TOKEN));
    expect(m.eventKey).not.toBe(toSeatEvent(EV, heldFields()).eventKey);
  });

  test('ST5_RELEASED도 같은 칸 이름으로 바꾼다 [ASVS v5.0.0-2.2.1]', () => {
    const m = toSeatEvent(EV, heldFields({ type: 'RELEASED', occurredAtMs: String(HELD_AT + 1_000) }));
    expect(m).toEqual(heldMessage({ type: 'RELEASED', occurredAt: new Date(HELD_AT + 1_000).toISOString(), eventKey: uuid8Of(`SeatEvent:RELEASED:${EV}:${HOLD}:${SEAT}:${TOKEN}`) }));
  });

  test('ST35_바꾼 메시지는 계약 Zod 스키마(SeatEvent)를 통과하고, 칸 이름은 모두 Avro 스키마 SeatEvent의 필드다(accountId·expiresAt 포함) [ASVS v5.0.0-2.2.1]', () => {
    const avsc = JSON.parse(readFileSync(new URL('../../../docs/api/avro/peaket/trade/SeatEvent.avsc', import.meta.url), 'utf8')) as { fields: Array<{ name: string }> };
    const names = new Set(avsc.fields.map((f) => f.name));
    expect(names.has('accountId')).toBe(true);
    expect(names.has('expiresAt')).toBe(true);
    for (const f of [heldFields(), expiredFields(), heldFields({ type: 'RELEASED' })]) {
      const m = toSeatEvent(EV, f);
      expect(SeatEvent.safeParse(m).success, String(f.type)).toBe(true);
      for (const k of Object.keys(m)) expect(names.has(k), k).toBe(true);
    }
  });

  test('ST5_16자리 토큰을 자릿수 잃지 않고 옮긴다: 2^53 − 1까지는 그 값이고, 안전한 정수를 넘는 토큰은 RangeError다(반올림된 토큰은 펜싱 대조를 깨뜨린다) [S-T5]', () => {
    expect(toSeatEvent(EV, heldFields({ fencingToken: '9007199254740991' })).fencingToken).toBe(9007199254740991);
    expect(toSeatEvent(EV, heldFields({ fencingToken: '1' })).fencingToken).toBe(1);
    expect(() => toSeatEvent(EV, heldFields({ fencingToken: '9007199254740993' }))).toThrow(RangeError);
  });

  test.each([
    'type',
    'seatId',
    'tierId',
    'sectionId',
    'holdId',
    'holdKind',
    'accountId',
    'fencingToken',
    'sectionVersion',
    'seatEpoch',
    'occurredAtMs',
    'expiresAtMs',
  ])('ST35_칸 %s가 빠지면 RangeError다(잘못된 사건을 Kafka로 내지 않는다) [ASVS v5.0.0-2.2.1]', (name) => {
    expect(() => toSeatEvent(EV, heldFields({ [name]: undefined }))).toThrow(RangeError);
  });

  test('ST35_빈 seatId(좌석맵 판에 없는 좌석의 EXPIRED)와 빈 holdId·accountId는 RangeError다 [ASVS v5.0.0-2.2.1]', () => {
    expect(() => toSeatEvent(EV, expiredFields({ seatId: '', tierId: '', sectionId: '', sectionVersion: '' }))).toThrow(RangeError);
    expect(() => toSeatEvent(EV, heldFields({ seatId: '' }))).toThrow(RangeError);
    expect(() => toSeatEvent(EV, heldFields({ holdId: '' }))).toThrow(RangeError);
    expect(() => toSeatEvent(EV, heldFields({ accountId: '' }))).toThrow(RangeError);
  });

  test.each(['', 'abc', '-1', '1.5', '1e3', ' 1', '0x10', '12a'])('ST5_10진 정수 글이 아닌 토큰 %j는 RangeError다 [ASVS v5.0.0-2.2.1]', (tok) => {
    expect(() => toSeatEvent(EV, heldFields({ fencingToken: tok }))).toThrow(RangeError);
  });

  test('ST35_구역 일련번호·세대가 10진 정수 글이 아니면 RangeError다 [ASVS v5.0.0-2.2.1]', () => {
    for (const v of ['x', '-3', '1.5', '']) {
      expect(() => toSeatEvent(EV, heldFields({ sectionVersion: v })), `sectionVersion ${v}`).toThrow(RangeError);
      expect(() => toSeatEvent(EV, heldFields({ seatEpoch: v })), `seatEpoch ${v}`).toThrow(RangeError);
    }
  });

  test.each(['abc', '1.5', '-1', '9007199254740993', ''])('ST35_안전한 정수 밀리초가 아닌 시각 %j는 RangeError다(occurredAtMs·expiresAtMs 둘 다) [ASVS v5.0.0-2.2.1]', (v) => {
    expect(() => toSeatEvent(EV, heldFields({ occurredAtMs: v }))).toThrow(RangeError);
    expect(() => toSeatEvent(EV, heldFields({ expiresAtMs: v }))).toThrow(RangeError);
  });

  test.each(['VIP', 'fan', ''])('ST35_모르는 holdKind %j는 RangeError다 [ASVS v5.0.0-2.2.1]', (kind) => {
    expect(() => toSeatEvent(EV, heldFields({ holdKind: kind }))).toThrow(RangeError);
  });

  test.each(['SOLD', 'PENDING', 'SESSION_STARTED', 'held', 'BOGUS', ''])('ST35_HELD·RELEASED·EXPIRED가 아닌 type %j는 RangeError다 [ASVS v5.0.0-2.2.1]', (type) => {
    expect(() => toSeatEvent(EV, heldFields({ type }))).toThrow(RangeError);
  });
});

describe('routeStreamEntry: 항목 하나의 갈 곳', () => {
  test.each(['HELD', 'RELEASED', 'EXPIRED'] as const)('ST35_%s는 trade.seats로 보낸다(메시지는 toSeatEvent 결과) [ASVS v5.0.0-2.2.1]', (type: HoldEventType) => {
    const f = type === 'EXPIRED' ? expiredFields() : heldFields({ type });
    expect(routeStreamEntry(EV, entry(f))).toEqual({ kind: 'send', topic: SEAT_TOPIC, message: toSeatEvent(EV, f) });
    expect(SEAT_TOPIC).toBe('trade.seats');
  });

  test('ADR0183_11_SESSION_STARTED·SESSION_ENDED는 trade.purchase-sessions로 보낸다(메시지는 기존 바꾸기 함수 결과) [ASVS v5.0.0-2.2.1]', () => {
    expect(PURCHASE_SESSION_TOPIC).toBe('trade.purchase-sessions');
    expect(routeStreamEntry(EV, entry(startedFields()))).toEqual({ kind: 'send', topic: PURCHASE_SESSION_TOPIC, message: toPurchaseSessionStarted(EV, startedFields()) });
    expect(routeStreamEntry(EV, entry(endedFields()))).toEqual({ kind: 'send', topic: PURCHASE_SESSION_TOPIC, message: toPurchaseSessionEnded(EV, endedFields()) });
  });

  test.each(['BOGUS', 'SOLD', 'PENDING', 'AVAILABLE', 'held', 'toString', 'constructor', '__proto__', 'hasOwnProperty'])(
    '모르는 type %j는 보내지 않고 unknown_type으로 넘긴다(판매 사건 type은 Stream에 오지 않는다) [ASVS v5.0.0-2.2.1]',
    (type) => {
      expect(routeStreamEntry(EV, entry(heldFields({ type })))).toEqual({ kind: 'drop', reason: 'unknown_type' });
    },
  );

  test('type이 없는 항목도 보내지 않고 넘긴다(던지지 않는다) [ASVS v5.0.0-2.2.1]', () => {
    const r = routeStreamEntry(EV, entry(heldFields({ type: undefined })));
    expect(r.kind).toBe('drop');
  });

  test('ST35_좌석맵 판에 없는 좌석의 EXPIRED(seatId·tierId·sectionId·sectionVersion이 빈 글)는 unmapped_seat로 넘긴다 [ASVS v5.0.0-2.2.1]', () => {
    expect(routeStreamEntry(EV, entry(expiredFields({ seatId: '', tierId: '', sectionId: '', sectionVersion: '' })))).toEqual({ kind: 'drop', reason: 'unmapped_seat' });
  });

  test.each(['seatId', 'tierId', 'sectionId'])('ST35_홀드 사건의 %s 하나만 빈 글이어도 unmapped_seat다 [ASVS v5.0.0-2.2.1]', (name) => {
    expect(routeStreamEntry(EV, entry(heldFields({ [name]: '' })))).toEqual({ kind: 'drop', reason: 'unmapped_seat' });
    expect(routeStreamEntry(EV, entry(expiredFields({ [name]: '' })))).toEqual({ kind: 'drop', reason: 'unmapped_seat' });
  });

  test('ST35_그 밖에 모양이 틀린 홀드 사건(토큰이 10진이 아님, holdId 빠짐, 모르는 holdKind, 시각이 정수가 아님)은 malformed로 넘긴다 [ASVS v5.0.0-2.2.1]', () => {
    for (const f of [
      heldFields({ fencingToken: 'x' }),
      heldFields({ holdId: undefined }),
      heldFields({ holdKind: 'VIP' }),
      heldFields({ accountId: undefined }),
      expiredFields({ occurredAtMs: '1.5' }),
      heldFields({ expiresAtMs: 'soon' }),
    ]) {
      expect(routeStreamEntry(EV, entry(f)), JSON.stringify(f)).toEqual({ kind: 'drop', reason: 'malformed' });
    }
  });

  test('ADR0183_11_모양이 틀린 구매 세션 사건(시각이 정수가 아님, reason이 모르는 값, 여정 ID가 UUID가 아님)은 malformed로 넘긴다 [ASVS v5.0.0-2.2.1]', () => {
    for (const f of [{ ...startedFields(), startedAtMs: 'x' }, { ...startedFields(), journeyId: 'not-uuid' }, { ...endedFields(), reason: 'BORED' }, { ...endedFields(), endedAtMs: undefined }]) {
      expect(routeStreamEntry(EV, entry(f as Record<string, string | undefined>)), JSON.stringify(f)).toEqual({ kind: 'drop', reason: 'malformed' });
    }
    // 회차 ID가 키 조각 모양이 아니면 기존 바꾸기 함수가 거절한다
    expect(routeStreamEntry('ev{1}', entry(startedFields()))).toEqual({ kind: 'drop', reason: 'malformed' });
  });

  test('ST35_어떤 입력에도 던지지 않는다(빈 칸, 이상한 값, 프로토타입 이름) [ASVS v5.0.0-2.2.1]', () => {
    const weird: Array<Record<string, unknown>> = [
      {},
      Object.create(null) as Record<string, unknown>,
      { type: 'HELD' },
      { type: 'EXPIRED' },
      { type: 'RELEASED' },
      { type: 'SESSION_STARTED' },
      { type: 'SESSION_ENDED' },
      { type: '' },
      { type: 'HELD', seatId: SEAT, fencingToken: '1'.repeat(400) },
      { type: 'HELD', __proto__: { seatId: SEAT } },
      { ...heldFields(), occurredAtMs: '99999999999999999999' },
      { ...heldFields(), holdKind: 'toString' },
      { ...heldFields(), type: 'valueOf' },
      { ...heldFields(), fencingToken: 123 as unknown as string },
    ];
    for (const fields of weird) {
      for (const eventId of [EV, '', 'ev{1}']) {
        let r: ReturnType<typeof routeStreamEntry> | undefined;
        expect(() => {
          r = routeStreamEntry(eventId, { id: '1-0', fields: fields as Record<string, string> });
        }, JSON.stringify(fields)).not.toThrow();
        expect(['send', 'drop']).toContain(r!.kind);
      }
    }
    // 정상 칸이 없는 것은 모두 넘긴다
    for (const fields of weird.slice(0, 8)) expect(routeStreamEntry(EV, { id: '1-0', fields: fields as Record<string, string> }).kind, JSON.stringify(fields)).toBe('drop');
  });
});

describe('toLedgerHoldEvent: Kafka에서 읽은 SeatEvent → 원장 사건', () => {
  const ledger = (over: Partial<LedgerHoldEvent> = {}): LedgerHoldEvent => ({
    eventId: EV,
    seatId: SEAT,
    accountId: ACCOUNT,
    type: 'HELD',
    fencingToken: 1762225200123456,
    holdKind: 'FAN',
    occurredAtMs: HELD_AT,
    expiresAtMs: EXP,
    eventKey: uuid8Of(`SeatEvent:HELD:${EV}:${HOLD}:${SEAT}:${TOKEN}`),
    // 원장 칸(PRF-143): FAN은 holdId·purchaseSessionId, PRIORITY는 holdId만
    ...(over.holdKind === 'PRIORITY' ? { holdId: HOLD } : { holdId: HOLD, purchaseSessionId: PSID }),
    ...over,
  });

  test('ST35_HELD 값을 원장 사건으로 바꾼다: 시각은 유닉스 밀리초(occurredAt → occurredAtMs = held_at), 토큰·계정·eventKey는 그대로 [ASVS v5.0.0-2.2.1]', () => {
    expect(toLedgerHoldEvent(seatEventValue())).toEqual(ledger());
    expect(toLedgerHoldEvent(seatEventValue())?.priorityGrantId).toBeUndefined();
  });

  test('ST5_RELEASED·EXPIRED도 같다(EXPIRED는 홀드의 토큰과 만료 시각, 푼 시각을 싣는다) [S-T5]', () => {
    const expired = toSeatEvent(EV, expiredFields());
    expect(toLedgerHoldEvent(JSON.parse(JSON.stringify(expired)))).toEqual(ledger({ type: 'EXPIRED', occurredAtMs: EXPIRED_AT, eventKey: expired.eventKey }));
    const released = seatEventValue({ type: 'RELEASED', occurredAt: new Date(HELD_AT + 9).toISOString(), eventKey: uuid8Of(`SeatEvent:RELEASED:${EV}:${HOLD}:${SEAT}:${TOKEN}`) });
    expect(toLedgerHoldEvent(released)).toEqual(ledger({ type: 'RELEASED', occurredAtMs: HELD_AT + 9, eventKey: uuid8Of(`SeatEvent:RELEASED:${EV}:${HOLD}:${SEAT}:${TOKEN}`) }));
  });

  test('ST35_우선 구매 보류(PRIORITY)는 priorityGrantId를 싣는다(구매 세션 ID는 없다) [ASVS v5.0.0-2.2.1]', () => {
    const grant = '0190f3a1-7c2e-7a00-8000-00000000c001';
    const v = seatEventValue({ holdKind: 'PRIORITY', priorityGrantId: grant });
    delete v.purchaseSessionId;
    expect(toLedgerHoldEvent(v)).toEqual(ledger({ holdKind: 'PRIORITY', priorityGrantId: grant }));
  });

  test.each(['PENDING', 'SOLD', 'AVAILABLE', 'RETURNED'])('판매 사건 %s는 원장 사건이 아니라 null이다', (type) => {
    const sale = { eventId: EV, seatId: SEAT, tierId: TIER, sectionId: SECTION, type, occurredAt: '2026-11-04T03:01:00.000Z', eventKey: '0190f3a1-7c2e-7a00-8000-0000000000f1' };
    expect(toLedgerHoldEvent(sale)).toBeNull();
  });

  test('ST35_회차·좌석·계정이 소문자 UUID가 아니면 RangeError다(대문자, 시험용 좌석 ID A01, 하이픈 없음, 중괄호, 빈 글) [ASVS v5.0.0-2.2.1]', () => {
    const bad = [EV.toUpperCase(), 'A01', EV.replaceAll('-', ''), `{${EV}}`, '', 42];
    for (const name of ['eventId', 'seatId', 'accountId']) {
      for (const v of bad) expect(() => toLedgerHoldEvent(seatEventValue({ [name]: v })), `${name}=${String(v)}`).toThrow(RangeError);
    }
  });

  test.each(['accountId', 'expiresAt', 'fencingToken', 'holdId', 'occurredAt', 'eventKey'])('ST35_%s가 빠진 홀드 사건은 RangeError다(같은 결과일 실패라 보류된다) [ASVS v5.0.0-2.2.1]', (name) => {
    const v = seatEventValue();
    delete v[name];
    expect(() => toLedgerHoldEvent(v)).toThrow(RangeError);
  });

  test('ST5_토큰이 안전한 양의 정수 number가 아니면 RangeError다(글, 소수, 0·음수, 2^53) [S-T5]', () => {
    for (const t of [TOKEN, 1.5, 0, -1, 2 ** 53, null, true]) expect(() => toLedgerHoldEvent(seatEventValue({ fencingToken: t })), String(t)).toThrow(RangeError);
    expect(toLedgerHoldEvent(seatEventValue({ fencingToken: 9007199254740991 }))?.fencingToken).toBe(9007199254740991);
  });

  test('ST35_시각이 날짜 글이 아니면 RangeError다 [ASVS v5.0.0-2.2.1]', () => {
    for (const name of ['occurredAt', 'expiresAt']) {
      for (const v of ['yesterday', '', '2026-13-45T99:00:00Z']) expect(() => toLedgerHoldEvent(seatEventValue({ [name]: v })), `${name}=${v}`).toThrow(RangeError);
    }
  });

  test('ST35_모르는 holdKind·type, holdId가 글이 아닌 값, 객체가 아닌 값은 RangeError다 [ASVS v5.0.0-2.2.1]', () => {
    expect(() => toLedgerHoldEvent(seatEventValue({ holdKind: 'VIP' }))).toThrow(RangeError);
    expect(() => toLedgerHoldEvent(seatEventValue({ type: 'BOGUS' }))).toThrow(RangeError);
    expect(() => toLedgerHoldEvent(seatEventValue({ holdId: 42 }))).toThrow(RangeError);
    for (const v of [null, undefined, 'x', 42, [], [seatEventValue()]]) expect(() => toLedgerHoldEvent(v), JSON.stringify(v) ?? 'undefined').toThrow(RangeError);
  });

  test('ST26_원장 칸(PRF-143): FAN 홀드 사건은 SeatEvent의 holdId·purchaseSessionId를 원장 사건에 싣는다(HELD·RELEASED·EXPIRED 모두, 다시 만들기가 되살린 홀드 Hash의 holdId·psid로 쓴다) [S-T26] [ASVS v5.0.0-2.2.1]', () => {
    for (const type of HOLD_EVENT_TYPES) {
      const key = uuid8Of(`SeatEvent:${type}:${EV}:${HOLD}:${SEAT}:${TOKEN}`);
      const e = toLedgerHoldEvent(seatEventValue({ type, eventKey: key }));
      expect({ type, holdId: e?.holdId, purchaseSessionId: e?.purchaseSessionId }).toEqual({ type, holdId: HOLD, purchaseSessionId: PSID });
    }
    // Stream 칸에서 온 사건도 같다
    const m = toSeatEvent(EV, heldFields());
    expect(toLedgerHoldEvent(JSON.parse(JSON.stringify(m)))).toMatchObject({ holdId: HOLD, purchaseSessionId: PSID });
  });

  test('ST26_원장 칸(PRF-143): 우선 구매 보류(PRIORITY)는 holdId만 싣고 purchaseSessionId 칸이 없다(값이 와도 싣지 않는다) [S-T26] [ASVS v5.0.0-2.2.1]', () => {
    const grant = '0190f3a1-7c2e-7a00-8000-00000000c001';
    const v = seatEventValue({ holdKind: 'PRIORITY', priorityGrantId: grant });
    delete v.purchaseSessionId;
    const e = toLedgerHoldEvent(v)!;
    expect(e.holdId).toBe(HOLD);
    expect(e.priorityGrantId).toBe(grant);
    expect('purchaseSessionId' in e).toBe(false);
    const stray = toLedgerHoldEvent(seatEventValue({ holdKind: 'PRIORITY', priorityGrantId: grant, purchaseSessionId: PSID }))!;
    expect(stray.holdId).toBe(HOLD);
    expect('purchaseSessionId' in stray).toBe(false);
  });

  test('ST35_Stream HELD 칸 → SeatEvent → JSON → 원장 사건으로 옮겨도 시각·토큰·계정이 그대로다 [ASVS v5.0.0-2.2.1]', () => {
    const m = toSeatEvent(EV, heldFields());
    const back = toLedgerHoldEvent(JSON.parse(JSON.stringify(m)));
    expect(back).toEqual({ eventId: EV, seatId: SEAT, accountId: ACCOUNT, type: 'HELD', fencingToken: Number(TOKEN), holdKind: 'FAN', occurredAtMs: HELD_AT, expiresAtMs: EXP, eventKey: m.eventKey, holdId: HOLD, purchaseSessionId: PSID });
  });
});
