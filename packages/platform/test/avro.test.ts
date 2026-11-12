// Confluent Avro 껍데기와 시작 때 스키마 ID 확인(BUILD_ORDER BAS-030, D-T39 ③, ST-T15).
import { expect, test } from 'vitest';
import { assertStartupSchema, assertTopicsConfigured, checkStartupSchema, decodeConfluent, encodeConfluent, MAX_SCHEMA_ID, parseSchemaIds } from '../src/avro.js';

test('BAS-030: Confluent 값은 매직 0 + 스키마 ID 4바이트 빅 엔디언 + Avro 바이너리이고 그대로 풀린다', () => {
  const payload = Buffer.from([1, 2, 3, 250]);
  const bytes = encodeConfluent(0x01020304, payload);
  expect([...bytes.subarray(0, 5)]).toEqual([0, 1, 2, 3, 4]);
  expect([...bytes.subarray(5)]).toEqual([...payload]);
  expect(decodeConfluent(bytes)).toEqual({ schemaId: 0x01020304, payload });
  expect(() => encodeConfluent(0, payload)).toThrow(RangeError);
  expect(() => encodeConfluent(MAX_SCHEMA_ID + 1, payload)).toThrow(RangeError);
  expect(() => encodeConfluent(1.5, payload)).toThrow(RangeError);
});

test('BAS-030: 매직 바이트나 길이가 틀린 값은 풀지 않는다', () => {
  expect(() => decodeConfluent(Buffer.from([0, 0, 0]))).toThrow('짧다');
  expect(() => decodeConfluent(Buffer.from([1, 0, 0, 0, 1]))).toThrow('매직');
});

test('BAS-030: schema-ids는 주제 → 1 이상 정수 객체만 받고, 내려는 주제가 빠지면 시작을 막는다', () => {
  expect(parseSchemaIds('{"trade.orders": 7}')).toEqual({ 'trade.orders': 7 });
  for (const bad of ['[]', 'null', '{"trade.orders":"7"}', '{"trade.orders":0}', '{"":1}', '{"a b":1}']) expect(() => parseSchemaIds(bad), bad).toThrow();
  expect(() => assertTopicsConfigured(['trade.orders'], { 'trade.orders': 7 })).not.toThrow();
  expect(() => assertTopicsConfigured(['trade.orders', 'trade.payments'], { 'trade.orders': 7 })).toThrow('trade.payments');
});

test('D-T39 ③: 시작 때 레지스트리 스키마가 다르면 mismatch로 시작을 막고, 닿지 못하면 unavailable로 계속한다', async () => {
  const schema = { type: 'record', name: 'Thing' };
  await expect(checkStartupSchema({ schemaId: 1, schema, fetchById: async () => schema })).resolves.toEqual({ status: 'ok', fetched: schema });
  await expect(checkStartupSchema({ schemaId: 1, schema, fetchById: async () => ({ type: 'record', name: 'Other' }) })).resolves.toMatchObject({ status: 'mismatch' });
  await expect(checkStartupSchema({ schemaId: 1, schema, fetchById: async () => Promise.reject(new Error('down')) })).resolves.toEqual({ status: 'unavailable' });
  const warnings: string[] = [];
  await expect(assertStartupSchema({ schemaId: 1, schema, fetchById: async () => Promise.reject(new Error('down')), warn: (m) => warnings.push(m) })).resolves.toBe('unavailable');
  expect(warnings[0]).toContain('schema-ids의 1');
  await expect(assertStartupSchema({ schemaId: 1, schema, fetchById: async () => ({ type: 'record', name: 'Other' }) })).rejects.toThrow('다르다');
});
