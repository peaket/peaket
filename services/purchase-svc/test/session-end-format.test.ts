// 구매 세션 종료 Stream 항목(SESSION_ENDED)과 asyncapi PurchaseSessionEnded로 바꾸는 함수, 정리 색인의 첫 점검 시각
// (docs/data.md §3 s:{event:E}:stream·s:{event:E}:sessions, docs/features/seat-hold.md §2 '구매 세션 종료와 정리', docs/api/avro/peaket/trade/PurchaseSessionEnded.avsc,
// BUILD_ORDER PRF-138). Stream을 Kafka로 내는 릴레이는 PRF-140이고, 받는 쪽 queue-svc 처리기는 같은 Zod 스키마(PurchaseSessionEnded)로 읽는다.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PurchaseSessionEnded } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import {
  assertEndedEntry,
  SESSION_END_REASONS,
  SESSION_ENDED_TYPE,
  SESSION_IDLE_MS,
  type SessionEndedEntry,
  type SessionEndReason,
  sessionCheckAt,
  sessionEndedEventKey,
  sessionEndedFields,
  sessionStartedEventKey,
  toPurchaseSessionEnded,
} from '../src/modules/inventory/index.js';

const entry: SessionEndedEntry = {
  eventId: 'ev-1',
  purchaseSessionId: 'jti-1',
  admissionJti: 'jti-1',
  reason: 'IDLE',
  endedAtMs: Date.parse('2026-11-04T03:05:00.007Z'),
};
const asMap = (flat: string[]): Record<string, string> => {
  const m: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) m[flat[i]!] = flat[i + 1]!;
  return m;
};
/** 키 조각 모양이 아닌 글(해시 태그를 깨는 글자·빈 글·너무 긴 글·ASCII 밖) */
const BAD_PARTS = ['', 'a}b', '{x}', 'a:b', 'a b', 'x'.repeat(65), 'é'];

describe('정리 색인의 첫 점검 시각 sessionCheckAt', () => {
  const t = Date.parse('2026-11-04T03:00:00.000Z');

  test('POL009_ADR0183_11_첫 점검 시각은 min(최대 체류, 시작 + 유휴 5분)이다: 최대 체류가 멀면 시작 + 5분, 5분 안이면 최대 체류, 딱 5분이면 같은 값이다', () => {
    expect(SESSION_IDLE_MS).toBe(5 * 60_000);
    expect(sessionCheckAt(t, t + 45 * 60_000)).toBe(t + 300_000);
    expect(sessionCheckAt(t, t + 300_001)).toBe(t + 300_000);
    expect(sessionCheckAt(t, t + 300_000)).toBe(t + 300_000);
    expect(sessionCheckAt(t, t + 299_999)).toBe(t + 299_999);
    expect(sessionCheckAt(t, t + 120_000)).toBe(t + 120_000);
    expect(sessionCheckAt(t, t)).toBe(t);
  });

  test('POL009_첫 점검 시각은 정렬 집합의 점수가 되는 안전한 정수다(0에서 시작해도, 큰 값에서도 밀리초 그대로)', () => {
    expect(sessionCheckAt(0, 10 * 60_000)).toBe(300_000);
    expect(sessionCheckAt(0, 1_000)).toBe(1_000);
    const big = Date.parse('2100-01-01T00:00:00.000Z');
    const v = sessionCheckAt(big, big + 45 * 60_000);
    expect(Number.isSafeInteger(v)).toBe(true);
    expect(v).toBe(big + 300_000);
  });
});

describe('SESSION_ENDED 항목의 모양 검사 assertEndedEntry', () => {
  test('ADR0183_11_모양이 맞으면 던지지 않는다: reason 네 값 모두, 시각 0도 된다', () => {
    for (const reason of ['COMPLETED', 'LEFT', 'IDLE', 'MAX_STAY'] as const) expect(() => assertEndedEntry({ ...entry, reason }), reason).not.toThrow();
    expect(() => assertEndedEntry({ ...entry, endedAtMs: 0 })).not.toThrow();
    expect(() => assertEndedEntry({ ...entry, endedAtMs: Number.MAX_SAFE_INTEGER })).not.toThrow();
  });

  test('회차 ID·구매 세션 ID·입장 토큰 jti가 키 조각 모양이 아니면 RangeError다 [ASVS v5.0.0-1.2.4]', () => {
    for (const bad of BAD_PARTS) {
      expect(() => assertEndedEntry({ ...entry, eventId: bad }), `eventId ${bad}`).toThrow(RangeError);
      expect(() => assertEndedEntry({ ...entry, purchaseSessionId: bad }), `purchaseSessionId ${bad}`).toThrow(RangeError);
      expect(() => assertEndedEntry({ ...entry, admissionJti: bad }), `admissionJti ${bad}`).toThrow(RangeError);
    }
    expect(() => assertEndedEntry({ ...entry, eventId: undefined as unknown as string })).toThrow(RangeError);
    expect(() => assertEndedEntry({ ...entry, purchaseSessionId: 7 as unknown as string })).toThrow(RangeError);
  });

  test('reason이 네 값이 아니면 RangeError다: UNRECOGNIZED(Avro의 모르는 값 자리)도, 소문자·빈 글·빠진 값도 거절한다 [ASVS v5.0.0-1.2.4]', () => {
    for (const reason of ['UNRECOGNIZED', 'idle', 'Idle', '', ' IDLE', 'COMPLETED ', 'TIMEOUT', undefined, null, 1]) {
      expect(() => assertEndedEntry({ ...entry, reason: reason as unknown as SessionEndReason }), String(reason)).toThrow(RangeError);
    }
  });

  test('끝낸 시각이 0 이상의 안전한 정수가 아니면 RangeError다 [ASVS v5.0.0-1.2.4]', () => {
    for (const ms of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '5', undefined, null]) {
      expect(() => assertEndedEntry({ ...entry, endedAtMs: ms as unknown as number }), String(ms)).toThrow(RangeError);
    }
  });

  test('ADR0183_11_SESSION_END_REASONS는 Avro 스키마 PurchaseSessionEnded.reason의 기호에서 UNRECOGNIZED를 뺀 네 값과 같고 SESSION_ENDED_TYPE은 SESSION_ENDED다', () => {
    const avsc = JSON.parse(readFileSync(new URL('../../../docs/api/avro/peaket/trade/PurchaseSessionEnded.avsc', import.meta.url), 'utf8')) as {
      fields: Array<{ name: string; type: unknown }>;
    };
    const reason = avsc.fields.find((f) => f.name === 'reason')!.type as { symbols: string[] };
    expect([...SESSION_END_REASONS].sort()).toEqual(reason.symbols.filter((s) => s !== 'UNRECOGNIZED').sort());
    expect(SESSION_END_REASONS).toHaveLength(4);
    expect(SESSION_ENDED_TYPE).toBe('SESSION_ENDED');
  });
});

describe('Stream 항목 sessionEndedFields', () => {
  test('ADR0183_11_항목은 type·purchaseSessionId·admissionJti·reason·endedAtMs의 이름·값 쌍이고 값은 모두 글이다', () => {
    const flat = sessionEndedFields(entry);
    expect(flat).toEqual(['type', SESSION_ENDED_TYPE, 'purchaseSessionId', 'jti-1', 'admissionJti', 'jti-1', 'reason', 'IDLE', 'endedAtMs', String(entry.endedAtMs)]);
    expect(flat.every((v) => typeof v === 'string')).toBe(true);
    expect(flat).toHaveLength(10);
  });

  test('ADR0183_11_reason마다 그 글이 그대로 실리고, 입력 항목을 바꾸지 않는다', () => {
    const frozen = Object.freeze({ ...entry });
    for (const reason of SESSION_END_REASONS) {
      const f = asMap(sessionEndedFields({ ...frozen, reason }));
      expect(f.reason).toBe(reason);
      expect(f.type).toBe('SESSION_ENDED');
    }
    expect(frozen).toEqual(entry);
  });

  test('ADR0183_11_종료 항목의 칸은 다섯뿐이다: 시작 사건의 journeyId·startedAtMs·maxStayUntilMs는 싣지 않는다', () => {
    const f = asMap(sessionEndedFields(entry));
    expect(Object.keys(f)).toEqual(['type', 'purchaseSessionId', 'admissionJti', 'reason', 'endedAtMs']);
  });
});

describe('PurchaseSessionEnded로 바꾸기', () => {
  test('ADR0183_11_QT11_키의 회차와 항목 칸으로 asyncapi 메시지를 만든다: 끝낸 시각은 밀리초까지 쓴 ISO 8601 UTC, reason은 그대로', () => {
    const m = toPurchaseSessionEnded('ev-1', asMap(sessionEndedFields(entry)));
    expect(m).toEqual({
      eventId: 'ev-1',
      purchaseSessionId: 'jti-1',
      admissionJti: 'jti-1',
      reason: 'IDLE',
      endedAt: '2026-11-04T03:05:00.007Z',
      eventKey: sessionEndedEventKey('jti-1'),
    });
  });

  test('ADR0183_11_네 가지 reason이 모두 그대로 메시지에 실리고 시각은 0이어도 ISO 글이다', () => {
    for (const reason of ['COMPLETED', 'LEFT', 'IDLE', 'MAX_STAY'] as const) {
      expect(toPurchaseSessionEnded('ev-1', asMap(sessionEndedFields({ ...entry, reason }))).reason).toBe(reason);
    }
    expect(toPurchaseSessionEnded('ev-1', asMap(sessionEndedFields({ ...entry, endedAtMs: 0 }))).endedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(toPurchaseSessionEnded('ev-1', asMap(sessionEndedFields({ ...entry, endedAtMs: Date.parse('2026-11-04T03:05:00.000Z') }))).endedAt).toBe('2026-11-04T03:05:00.000Z');
  });

  test('ADR0183_11_메시지의 칸 이름은 Avro 스키마 PurchaseSessionEnded의 필드와 정확히 같다(칸이 늘거나 빠지면 계약이 깨진다)', () => {
    const avsc = JSON.parse(readFileSync(new URL('../../../docs/api/avro/peaket/trade/PurchaseSessionEnded.avsc', import.meta.url), 'utf8')) as { fields: Array<{ name: string }> };
    const m = toPurchaseSessionEnded('ev-1', asMap(sessionEndedFields(entry)));
    expect(Object.keys(m).sort()).toEqual(avsc.fields.map((f) => f.name).sort());
  });

  test('ADR0183_11_QT11_메시지는 계약에서 만든 Zod 스키마(PurchaseSessionEnded, queue-svc 처리기가 읽는 모양)를 그대로 통과한다: 날짜 형식·UUID 형식(eventKey는 버전 8)·reason 네 값이 맞다', () => {
    const m = toPurchaseSessionEnded('ev-1', asMap(sessionEndedFields(entry)));
    expect(PurchaseSessionEnded.parse(m)).toEqual(m);
    for (const reason of SESSION_END_REASONS) {
      for (const jti of ['a', 'jti-2', '0190f3a1-7c2e-7a00-8000-0000000000a1']) {
        const x = toPurchaseSessionEnded('ev-1', asMap(sessionEndedFields({ ...entry, reason, purchaseSessionId: jti, admissionJti: jti })));
        expect(PurchaseSessionEnded.safeParse(x).success, `${reason} ${jti}`).toBe(true);
      }
    }
  });

  test('ADR0052_eventKey는 purchaseSessionId마다 정해진 UUID 버전 8이다: SHA-256("PurchaseSessionEnded:" + id)의 앞 16바이트, 같은 사건을 다시 보내면 같은 값', () => {
    const digest = createHash('sha256').update('PurchaseSessionEnded:jti-1').digest();
    const b = Buffer.from(digest.subarray(0, 16));
    b[6] = (b[6]! & 0x0f) | 0x80;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = b.toString('hex');
    const expected = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    expect(sessionEndedEventKey('jti-1')).toBe(expected);
    expect(sessionEndedEventKey('jti-1')).toBe(sessionEndedEventKey('jti-1'));
    expect(sessionEndedEventKey('jti-2')).not.toBe(sessionEndedEventKey('jti-1'));
    expect(sessionEndedEventKey('jti-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('ADR0052_종료 사건 키는 같은 구매 세션의 시작 사건 키와 다르다(접두가 "PurchaseSessionEnded:"라서 받는 쪽이 둘을 같은 사건으로 거르지 않는다)', () => {
    for (const jti of ['jti-1', 'a', '0190f3a1-7c2e-7a00-8000-0000000000a1']) {
      expect(sessionEndedEventKey(jti)).not.toBe(sessionStartedEventKey(jti));
    }
  });

  test('ADR0183_11_메시지의 eventKey는 sessionEndedEventKey(purchaseSessionId)이고 reason·시각이 달라도 같은 세션이면 같다(세션 하나는 한 번 끝난다)', () => {
    const a = toPurchaseSessionEnded('ev-1', asMap(sessionEndedFields({ ...entry, reason: 'IDLE', endedAtMs: 1_000 })));
    const b = toPurchaseSessionEnded('ev-1', asMap(sessionEndedFields({ ...entry, reason: 'MAX_STAY', endedAtMs: 2_000 })));
    expect(a.eventKey).toBe(sessionEndedEventKey('jti-1'));
    expect(b.eventKey).toBe(a.eventKey);
  });

  test('ADR0183_11_항목이 틀리면 RangeError로 던진다: type이 다르거나 칸이 없거나 reason이 모르는 값이거나 시각이 10진 정수가 아니거나 ID가 키 조각 모양이 아니면 보내지 않는다', () => {
    const ok = asMap(sessionEndedFields(entry));
    const bad: Array<Record<string, string | undefined>> = [
      { ...ok, type: 'SESSION_STARTED' },
      { ...ok, type: 'HELD' },
      { ...ok, type: undefined },
      { ...ok, purchaseSessionId: undefined },
      { ...ok, admissionJti: undefined },
      { ...ok, reason: undefined },
      { ...ok, reason: 'UNRECOGNIZED' },
      { ...ok, reason: 'idle' },
      { ...ok, reason: '' },
      { ...ok, reason: 'TIMEOUT' },
      { ...ok, endedAtMs: undefined },
      { ...ok, endedAtMs: '' },
      { ...ok, endedAtMs: '1.5' },
      { ...ok, endedAtMs: '007' },
      { ...ok, endedAtMs: '-1' },
      { ...ok, endedAtMs: 'abc' },
      { ...ok, endedAtMs: '1e3' },
      { ...ok, endedAtMs: '99999999999999999999' },
      { ...ok, endedAtMs: '9007199254740992' },
      // 안전한 정수이지만 Date가 받지 못하는 시각(ISO 글로 바꿀 수 없다)
      { ...ok, endedAtMs: String(Number.MAX_SAFE_INTEGER) },
      { ...ok, purchaseSessionId: 'a}b' },
      { ...ok, admissionJti: '' },
      {},
    ];
    for (const f of bad) expect(() => toPurchaseSessionEnded('ev-1', f), JSON.stringify(f)).toThrow(RangeError);
    for (const e of BAD_PARTS) expect(() => toPurchaseSessionEnded(e, ok), `eventId ${e}`).toThrow(RangeError);
  });
});
