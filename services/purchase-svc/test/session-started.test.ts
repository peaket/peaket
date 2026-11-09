// SESSION_STARTED Stream 항목과 asyncapi PurchaseSessionStarted로 바꾸는 함수(docs/data.md §3 s:{event:E}:stream, docs/api/avro/peaket/trade/PurchaseSessionStarted.avsc,
// BUILD_ORDER PRF-136). Stream을 Kafka로 내는 릴레이는 PRF-140이다.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PurchaseSessionStarted } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import { SESSION_STARTED_TYPE, type SessionStartedEntry, sessionStartedEventKey, sessionStartedFields, toPurchaseSessionStarted } from '../src/modules/inventory/index.js';

const JNY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const entry: SessionStartedEntry = {
  eventId: 'ev-1',
  purchaseSessionId: 'jti-1',
  admissionJti: 'jti-1',
  journeyId: JNY,
  startedAtMs: Date.parse('2026-11-04T03:00:00.123Z'),
  maxStayUntilMs: Date.parse('2026-11-04T03:45:00.000Z'),
};
const asMap = (flat: string[]): Record<string, string> => {
  const m: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) m[flat[i]!] = flat[i + 1]!;
  return m;
};

describe('Stream 항목', () => {
  test('ADR0183_11_항목은 type·purchaseSessionId·admissionJti·journeyId·startedAtMs·maxStayUntilMs의 이름·값 쌍이고 값은 모두 글이다', () => {
    const flat = sessionStartedFields(entry);
    expect(flat).toEqual(['type', SESSION_STARTED_TYPE, 'purchaseSessionId', 'jti-1', 'admissionJti', 'jti-1', 'journeyId', JNY, 'startedAtMs', String(entry.startedAtMs), 'maxStayUntilMs', String(entry.maxStayUntilMs)]);
    expect(flat.every((v) => typeof v === 'string')).toBe(true);
    expect(SESSION_STARTED_TYPE).toBe('SESSION_STARTED');
  });
});

describe('PurchaseSessionStarted로 바꾸기', () => {
  test('ADR0183_11_ST35_키의 회차와 항목 칸으로 asyncapi 메시지를 만든다: 시각은 밀리초까지 쓴 ISO 8601 UTC, 여정 ID는 그대로', () => {
    const m = toPurchaseSessionStarted('ev-1', asMap(sessionStartedFields(entry)));
    expect(m).toEqual({
      eventId: 'ev-1',
      purchaseSessionId: 'jti-1',
      admissionJti: 'jti-1',
      journeyId: JNY,
      startedAt: '2026-11-04T03:00:00.123Z',
      maxStayUntil: '2026-11-04T03:45:00.000Z',
      eventKey: sessionStartedEventKey('jti-1'),
    });
  });

  test('ADR0183_11_메시지의 칸 이름은 Avro 스키마 PurchaseSessionStarted의 필드와 정확히 같다(칸이 늘거나 빠지면 계약이 깨진다)', () => {
    const avsc = JSON.parse(readFileSync(new URL('../../../docs/api/avro/peaket/trade/PurchaseSessionStarted.avsc', import.meta.url), 'utf8')) as { fields: Array<{ name: string }> };
    const m = toPurchaseSessionStarted('ev-1', asMap(sessionStartedFields(entry)));
    expect(Object.keys(m).sort()).toEqual(avsc.fields.map((f) => f.name).sort());
  });

  test('ADR0183_11_메시지는 계약에서 만든 Zod 스키마(PurchaseSessionStarted)를 그대로 통과한다: 날짜 형식·UUID 형식(eventKey는 버전 8)이 맞다', () => {
    const m = toPurchaseSessionStarted('ev-1', asMap(sessionStartedFields(entry)));
    expect(PurchaseSessionStarted.parse(m)).toEqual(m);
    for (const jti of ['a', 'jti-2', '0190f3a1-7c2e-7a00-8000-0000000000a1']) {
      const x = toPurchaseSessionStarted('ev-1', asMap(sessionStartedFields({ ...entry, purchaseSessionId: jti, admissionJti: jti })));
      expect(PurchaseSessionStarted.safeParse(x).success, jti).toBe(true);
    }
  });

  test('ADR0052_eventKey는 purchaseSessionId마다 정해진 UUID 버전 8이다: SHA-256("PurchaseSessionStarted:" + id)의 앞 16바이트, 같은 사건을 다시 보내면 같은 값', () => {
    const digest = createHash('sha256').update('PurchaseSessionStarted:jti-1').digest();
    const b = Buffer.from(digest.subarray(0, 16));
    b[6] = (b[6]! & 0x0f) | 0x80;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = b.toString('hex');
    const expected = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    expect(sessionStartedEventKey('jti-1')).toBe(expected);
    expect(sessionStartedEventKey('jti-1')).toBe(sessionStartedEventKey('jti-1'));
    expect(sessionStartedEventKey('jti-2')).not.toBe(sessionStartedEventKey('jti-1'));
    expect(sessionStartedEventKey('jti-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('ADR0183_11_항목이 틀리면 던진다: type이 다르거나 칸이 없거나 시각이 10진 정수가 아니거나 여정 ID가 UUID가 아니면 보내지 않는다', () => {
    const ok = asMap(sessionStartedFields(entry));
    const bad: Array<Record<string, string | undefined>> = [
      { ...ok, type: 'HELD' },
      { ...ok, type: undefined },
      { ...ok, purchaseSessionId: undefined },
      { ...ok, admissionJti: undefined },
      { ...ok, journeyId: 'nope' },
      { ...ok, startedAtMs: '1.5' },
      { ...ok, startedAtMs: '007' },
      { ...ok, startedAtMs: '-1' },
      { ...ok, startedAtMs: undefined },
      { ...ok, maxStayUntilMs: 'abc' },
      { ...ok, maxStayUntilMs: '99999999999999999999' },
      {},
    ];
    for (const f of bad) expect(() => toPurchaseSessionStarted('ev-1', f as Record<string, string>), JSON.stringify(f)).toThrow();
  });
});
