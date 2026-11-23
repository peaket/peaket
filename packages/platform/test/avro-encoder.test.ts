// 생산자 공용 Avro 인코더(createAvroEncoder)의 단위 시험(F-04-2 계획 §6 A-T26 ⑤, ADR-0357 결정 3·8, ADR-0150 결정 5, docs/api/avro/README.md §3).
// 계약 판 스키마는 생성물(@peaket/contracts/avro, docs/api/avro의 .avsc 그대로)을 쓰고, 낸 바이트는 제품 인코더가 아니라 시험 도구(test/produced-avro.ts, avsc)로 푼다.
// 단언 값은 정본에서 적는다: 필수 칸·x-present-when·UNRECOGNIZED 금지(결정 3), 오류에 값을 싣지 않음(결정 3·8), timestamp-millis(HoldAttempt.avsc),
// 주제 이름 <토픽>-<네임스페이스.레코드>(README §3 TopicRecordNameStrategy). 스키마 ID는 코드 상수와 겹치지 않게 101로 고른다.
import { avroSchemas } from '@peaket/contracts/avro';
import { describe, expect, test } from 'vitest';
import { AvroEncodeError, createAvroEncoder } from '../src/avro-encoder.js';
import { PlatformConfigError } from '../src/config.js';
import { countUtf8, decodeProduced } from './produced-avro.js';

const TOPIC = 'telemetry.purchase';
const RECORD = 'peaket.telemetry.HoldAttempt';
const SUBJECT = `${TOPIC}-${RECORD}`;
const SCHEMA_ID = 101;
/** 오류 글·칸에 나오면 안 되는 표지 값(사건의 값 자리에 넣는다) */
const SECRET = 'secret-marker-7f3a';
const JOURNEY = '0190f3a1-7c2e-7a00-8000-0000000000aa';
const EVENT_KEY = '0190f3a1-7c2e-7a00-8000-0000000000ee';

const encoder = () => createAvroEncoder({ schemaIds: { [SUBJECT]: SCHEMA_ID }, schemas: avroSchemas, produces: [{ topic: TOPIC, record: RECORD }] });

/** 계약(asyncapi HoldAttempt)을 채운 직접 선택 HELD 시도. 값 자리 여럿에 표지 값을 넣는다 */
const held = (): Record<string, unknown> => ({
  eventId: `ev-${SECRET}`,
  purchaseSessionId: `ps-${SECRET}`,
  journeyId: JOURNEY,
  mode: 'PICK',
  tierId: `tier-${SECRET}`,
  sectionId: 'sec-a',
  seatIds: [`seat-${SECRET}`, 'A02'],
  result: 'HELD',
  heldAt: '2026-11-23T01:02:03.456Z',
  firstHeldInSession: true,
  retryNo: 2,
  latencyMs: 31,
  occurredAt: '2026-11-23T01:02:03.789+09:00',
  eventKey: EVENT_KEY,
});

const without = (m: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(m).filter(([k]) => !keys.includes(k)));

/** 던진 오류를 받아 낸다(던지지 않으면 실패) */
function thrown(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error('던지지 않았다');
}
const errorText = (e: unknown): string => [String(e), String((e as Error).stack ?? ''), JSON.stringify(e, Object.getOwnPropertyNames(e))].join('\n');

describe('A-T26 ⑤ 인코딩 오류(ADR-0357 결정 3·8)', () => {
  test('A-T26 ⑤ 필수 칸·조건부 칸이 빈 사건은 AvroEncodeError이고 글에 값이 없다', () => {
    const enc = encoder();
    // 계약을 채운 값은 낸다(아래 거절이 '무엇이든 거절'로 통과하지 않게). 표지 값이 바이트에 실제로 있다
    const ok = enc.encode(TOPIC, RECORD, held());
    expect(decodeProduced(ok, RECORD).violations).toEqual([]);
    expect(countUtf8(ok, SECRET)).toBe(4);

    const cases: { name: string; message: Record<string, unknown>; fields: string[] }[] = [
      // 필수 칸(기본값 없음) tierId가 빔: 좌석맵 판에서 첫 좌석을 찾기 전에 거절한 시도(결정 7)
      { name: 'tierId 빔', message: without(held(), 'tierId'), fields: ['tierId'] },
      { name: 'tierId null', message: { ...held(), tierId: null }, fields: ['tierId'] },
      // x-present-when [{result: [HELD]}]
      { name: 'HELD인데 heldAt 빔', message: without(held(), 'heldAt'), fields: ['heldAt'] },
      // x-present-when [{mode: [PICK]}, {result: [HELD]}]: 경합에서 진 직접 선택도 좌석이 있어야 한다
      { name: 'PICK CONFLICT인데 seatIds 빔', message: { ...without(held(), 'seatIds', 'heldAt'), result: 'CONFLICT' }, fields: ['seatIds'] },
      // x-present-when [{mode: [AUTO]}]
      { name: 'AUTO인데 autoResult 빔', message: { ...held(), mode: 'AUTO' }, fields: ['autoResult'] },
      // 열거: 읽는 쪽 전용 기호와 목록 밖 값
      { name: 'mode UNRECOGNIZED', message: { ...held(), mode: 'UNRECOGNIZED' }, fields: ['mode'] },
      { name: 'result 목록 밖', message: { ...held(), result: `BOGUS_${SECRET}` }, fields: ['result'] },
      { name: 'AUTO autoResult UNRECOGNIZED', message: { ...held(), mode: 'AUTO', autoResult: 'UNRECOGNIZED' }, fields: ['autoResult'] },
      // 시간대 없는 시각 글은 RFC 3339 date-time이 아니다
      { name: 'occurredAt 시간대 없음', message: { ...held(), occurredAt: '2026-11-23T01:02:03' }, fields: ['occurredAt'] },
    ];
    for (const c of cases) {
      const e = thrown(() => enc.encode(TOPIC, RECORD, c.message));
      expect(e, c.name).toBeInstanceOf(AvroEncodeError);
      expect((e as AvroEncodeError).record, c.name).toBe(RECORD);
      expect([...(e as AvroEncodeError).fields].sort(), c.name).toEqual(c.fields);
      // 오류 글·스택·칸 목록 어디에도 사건의 값이 없다(레코드 이름과 칸 경로만)
      expect(errorText(e).includes(SECRET), c.name).toBe(false);
    }
  });

  test('A-T26 ⑤ 낼 수 없는 주제(이 인코더가 받지 않은 토픽·레코드)도 AvroEncodeError이고 바이트를 만들지 않는다', () => {
    const enc = encoder();
    expect(thrown(() => enc.encode('telemetry.queue', RECORD, held()))).toBeInstanceOf(AvroEncodeError);
    expect(thrown(() => enc.encode(TOPIC, 'peaket.trade.OrderEvent', held()))).toBeInstanceOf(AvroEncodeError);
  });
});

describe('A-T26 ⑤ 바이트 모양(ADR-0357 결정 3, README §3)', () => {
  test('A-T26 ⑤ 날짜·시각 칸은 밀리초로, 계약에 없는 칸은 바이트에 없다', () => {
    const enc = encoder();
    const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000acc77';
    const bytes = enc.encode(TOPIC, RECORD, { ...held(), accountId: ACCOUNT, holderPhone: '010-5555-0199' });
    const p = decodeProduced(bytes, RECORD);
    // 앞 다섯 바이트: 매직 바이트 0과 설정의 그 주제 ID(빅 엔디언 4바이트)
    expect([...bytes.subarray(0, 5)]).toEqual([0, 0, 0, 0, SCHEMA_ID]);
    expect(p.schemaId).toBe(SCHEMA_ID);
    expect(p.violations).toEqual([]);
    // timestamp-millis: ISO 글 → 유닉스 밀리초(+09:00은 UTC로 9시간 앞)
    expect(p.value.heldAt).toBe(Date.UTC(2026, 10, 23, 1, 2, 3, 456));
    expect(p.value.occurredAt).toBe(Date.UTC(2026, 10, 22, 16, 2, 3, 789));
    // 계약에 없는 칸은 쓰지 않는다: 계정 ID·연락처 글이 바이트에 0번, 계약의 칸 값은 그대로 1번
    expect(countUtf8(bytes, ACCOUNT)).toBe(0);
    expect(countUtf8(bytes, '010-5555-0199')).toBe(0);
    expect(countUtf8(bytes, `ps-${SECRET}`)).toBe(1);
    expect(Object.keys(p.value).sort()).toEqual(((avroSchemas[RECORD] as { fields: { name: string }[] }).fields.map((f) => f.name)).sort());
    // 비운 선택 칸은 null(기본값), 그 밖은 넣은 값 그대로
    expect(p.value).toMatchObject({ mode: 'PICK', result: 'HELD', seatIds: [`seat-${SECRET}`, 'A02'], retryNo: 2, latencyMs: 31, firstHeldInSession: true, autoResult: null, eventKey: EVENT_KEY });
  });

  test('A-T26 ⑤ 내는 주제가 설정(schema-ids)에 없으면 createAvroEncoder가 던진다(주제 이름은 <토픽>-<레코드 전체 이름>)', () => {
    const both = [
      { topic: TOPIC, record: RECORD },
      { topic: 'trade.orders', record: 'peaket.trade.OrderEvent' },
    ];
    const e = thrown(() => createAvroEncoder({ schemaIds: { [SUBJECT]: SCHEMA_ID }, schemas: avroSchemas, produces: both }));
    expect(e).toBeInstanceOf(PlatformConfigError);
    expect((e as Error).message).toContain('trade.orders-peaket.trade.OrderEvent');
    // 토픽 이름 전략(<토픽>-value)의 키로는 찾지 않는다
    expect(thrown(() => createAvroEncoder({ schemaIds: { [`${TOPIC}-value`]: SCHEMA_ID }, schemas: avroSchemas, produces: [{ topic: TOPIC, record: RECORD }] }))).toBeInstanceOf(PlatformConfigError);
    // 둘 다 있으면 만든다. 주제 목록은 그 둘이다
    const ok = createAvroEncoder({ schemaIds: { [SUBJECT]: SCHEMA_ID, 'trade.orders-peaket.trade.OrderEvent': 17 }, schemas: avroSchemas, produces: both });
    expect([...ok.subjects].sort()).toEqual(['telemetry.purchase-peaket.telemetry.HoldAttempt', 'trade.orders-peaket.trade.OrderEvent']);
  });
});
