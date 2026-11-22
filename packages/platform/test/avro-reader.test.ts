// Avro 읽기(createAvroReader)의 단위 시험(BAT-220 계획 §6 ST-T15 단위·ST-T16 ① 단위·OPS-150 ⑩ ID 대조, docs/streaming.md §2.6 역직렬화·모르는 열거 기호,
// docs/api/avro/README.md §3, ADR-0335 결정 3). 읽기는 진짜 레지스트리 조회(schemaRegistrySource)를 거치고, 레지스트리 HTTP만 Confluent REST 응답
// 모양의 가짜(test/schema-registry-fake.ts)로 바꾼다. 같은 흐름의 실제 Kafka·실제 HTTP 시험은 test-int/batch-worker.int.test.ts다.
// 메시지는 Confluent 형식(매직 바이트 0 + 스키마 ID 4바이트 + Avro 바이너리, avro README §3)으로 시험 안에서 avsc로 만든다.
import avsc from 'avsc';
import { describe, expect, test } from 'vitest';
import { encodeConfluent, MAX_SCHEMA_ID } from '../src/avro.js';
import { createAvroReader, SchemaUnavailableError, UNRECOGNIZED_SYMBOL, type SchemaSource } from '../src/avro-reader.js';
import { isTransientError } from '../src/keyed-consumer.js';
import { schemaRegistrySource } from '../src/schema-registry-source.js';
import { fakeRegistryFetch, registryState, type RegistryState } from './schema-registry-fake.js';

const TOPIC = 'telemetry.queue';

/** 시험 레코드: 최상위·중첩 레코드·배열 안 레코드·null 갈래에 같은 열거(State)가 있다 */
const pulse = (symbols: string[], o: { withAmount?: boolean } = {}) => ({
  type: 'record',
  name: 'Pulse',
  namespace: 'peaket.it',
  fields: [
    { name: 'id', type: 'long' },
    ...(o.withAmount === false ? [] : [{ name: 'amount', type: 'long' }]),
    { name: 'state', type: { type: 'enum', name: 'State', symbols } },
    { name: 'meta', type: { type: 'record', name: 'Meta', fields: [{ name: 'phase', type: 'State' }] } },
    { name: 'items', type: { type: 'array', items: { type: 'record', name: 'Item', fields: [{ name: 'kind', type: 'State' }] } } },
    { name: 'maybe', type: ['null', 'State'], default: null },
  ],
});
/** 작업자가 빌드된 계약 판(옛 판): 기호 둘 */
const V1 = pulse(['OPEN', 'CLOSED']);
/** 생산자의 새 판: 기호 PAUSED가 늘었다 */
const V2 = pulse(['OPEN', 'CLOSED', 'PAUSED']);
/** 필수 필드 amount(기본값 없음)가 없는 쓴 쪽 판 */
const NO_AMOUNT = pulse(['OPEN', 'CLOSED'], { withAmount: false });
const OTHER = { type: 'record', name: 'Beat', namespace: 'peaket.it', fields: [{ name: 'seq', type: 'int' }, { name: 'note', type: 'string' }] };

const bytesOf = (schemaId: number, schema: unknown, value: unknown) => encodeConfluent(schemaId, avsc.Type.forSchema(schema as avsc.Schema).toBuffer(value));

function reader(state: RegistryState, o: { down?: () => boolean; keepUnknownSymbols?: boolean } = {}) {
  const calls: { topic: string; record: string; field: string }[] = [];
  const source = schemaRegistrySource({ url: 'https://registry.peaket.example', env: 'prod', fetch: fakeRegistryFetch(state, { down: o.down }) });
  const r = createAvroReader({ source, readerSchemas: [V1, OTHER], keepUnknownSymbols: o.keepUnknownSymbols, onUnrecognized: (u) => calls.push(u) });
  return { r, calls };
}

const NEW_VALUE = { id: 41, amount: 1_250, state: 'PAUSED', meta: { phase: 'PAUSED' }, items: [{ kind: 'OPEN' }, { kind: 'PAUSED' }, { kind: 'CLOSED' }], maybe: 'PAUSED' };

describe('ST-T15 모르는 열거 기호', () => {
  test('ST-T15 ① 옛 판 읽기 스키마에 없는 기호가 최상위·중첩 레코드·배열·null 갈래 모두에서 UNRECOGNIZED가 되고, 아는 기호는 그대로다. 거절하지 않는다', async () => {
    const { r, calls } = reader(registryState({ 1: V1, 2: V2 }));
    const out = await r.decode(TOPIC, bytesOf(2, V2, NEW_VALUE));
    expect(out).toEqual({
      kind: 'record',
      schemaId: 2,
      recordName: 'peaket.it.Pulse',
      value: { id: 41, amount: 1_250, state: 'UNRECOGNIZED', meta: { phase: 'UNRECOGNIZED' }, items: [{ kind: 'OPEN' }, { kind: 'UNRECOGNIZED' }, { kind: 'CLOSED' }], maybe: 'UNRECOGNIZED' },
      unrecognized: [
        { field: 'state', symbol: 'PAUSED' },
        { field: 'meta.phase', symbol: 'PAUSED' },
        { field: 'items.kind', symbol: 'PAUSED' },
        { field: 'maybe', symbol: 'PAUSED' },
      ],
    });
    expect(UNRECOGNIZED_SYMBOL).toBe('UNRECOGNIZED');
    // 모르는 기호 하나마다 한 번씩, (토픽, 레코드 전체 이름, 점으로 이은 필드 경로)로 불린다
    expect(calls).toEqual([
      { topic: TOPIC, record: 'peaket.it.Pulse', field: 'state' },
      { topic: TOPIC, record: 'peaket.it.Pulse', field: 'meta.phase' },
      { topic: TOPIC, record: 'peaket.it.Pulse', field: 'items.kind' },
      { topic: TOPIC, record: 'peaket.it.Pulse', field: 'maybe' },
    ]);
  });

  test('ST-T15 ② 원본 적재(keepUnknownSymbols)는 원래 기호를 그대로 남기고 셈은 같다', async () => {
    const { r, calls } = reader(registryState({ 2: V2 }), { keepUnknownSymbols: true });
    const out = await r.decode(TOPIC, bytesOf(2, V2, NEW_VALUE));
    expect(out).toMatchObject({ kind: 'record', schemaId: 2, recordName: 'peaket.it.Pulse', value: NEW_VALUE });
    expect(out.kind === 'record' && out.unrecognized.map((u) => u.field)).toEqual(['state', 'meta.phase', 'items.kind', 'maybe']);
    expect(calls.map((c) => c.field)).toEqual(['state', 'meta.phase', 'items.kind', 'maybe']);
  });

  test('ST-T15 ③ 새 판으로 낸 레코드라도 아는 기호만 쓰면 바꾸지 않고 세지 않는다. 옛 판 레코드도 그대로다', async () => {
    const { r, calls } = reader(registryState({ 1: V1, 2: V2 }));
    const known = { id: 1, amount: 9, state: 'CLOSED', meta: { phase: 'OPEN' }, items: [], maybe: null };
    for (const id of [1, 2]) {
      const out = await r.decode(TOPIC, bytesOf(id, id === 1 ? V1 : V2, known));
      expect(out, String(id)).toEqual({ kind: 'record', schemaId: id, recordName: 'peaket.it.Pulse', value: known, unrecognized: [] });
    }
    expect(calls).toEqual([]);
  });
});

describe('ST-T16 ① 레지스트리에 닿지 못할 때', () => {
  test('ST-T16 ① 404(레지스트리가 모르는 ID)만 UNKNOWN_SCHEMA 거절이고 그 ID를 싣는다', async () => {
    const { r } = reader(registryState({ 1: V1 }));
    await expect(r.decode(TOPIC, bytesOf(77, V1, { id: 1, amount: 1, state: 'OPEN', meta: { phase: 'OPEN' }, items: [], maybe: null }))).resolves.toEqual({ kind: 'rejected', schemaId: 77, reason: 'UNKNOWN_SCHEMA' });
  });

  test('ST-T16 ① 처음 보는 ID를 레지스트리에 닿지 못해 읽지 못하면 거절하지 않고 SchemaUnavailableError를 던진다(503·연결 거부)', async () => {
    const msg = bytesOf(2, V2, NEW_VALUE);
    const s503 = { ...registryState({ 2: V2 }), status: 503 };
    await expect(reader(s503).r.decode(TOPIC, msg)).rejects.toBeInstanceOf(SchemaUnavailableError);
    await expect(reader(registryState({ 2: V2 }), { down: () => true }).r.decode(TOPIC, msg)).rejects.toBeInstanceOf(SchemaUnavailableError);
  });

  test('ST-T16 ① 레지스트리 장애 오류는 실행기가 일시 실패로 보는 오류다(isTransientError: 그 파티션을 멈추고 다시 시도, 거절로 보내지 않음)', async () => {
    // 실행기(runBatchWorker)는 decode가 던진 오류를 isTransientError로 갈라, 참이면 멈추고 거짓이면 DESERIALIZE로 거절한다(stream-worker.ts)
    const fromSource = await reader({ ...registryState({ 2: V2 }), status: 503 }).r.decode(TOPIC, bytesOf(2, V2, NEW_VALUE)).catch((e: unknown) => e);
    expect(fromSource).toBeInstanceOf(SchemaUnavailableError);
    expect(isTransientError(fromSource)).toBe(true);
    const refused = await reader(registryState({ 2: V2 }), { down: () => true }).r.decode(TOPIC, bytesOf(2, V2, NEW_VALUE)).catch((e: unknown) => e);
    expect(isTransientError(refused)).toBe(true);
  });

  test('ST-T16 ① 실패한 조회는 캐시하지 않아 다음 풀기가 다시 원천에 가고, 성공한 ID는 원천이 닫혀도 풀린다', async () => {
    const state = registryState({ 2: V2 });
    let down = true;
    const { r } = reader(state, { down: () => down });
    const msg = bytesOf(2, V2, NEW_VALUE);
    await expect(r.decode(TOPIC, msg)).rejects.toBeInstanceOf(SchemaUnavailableError);
    down = false;
    state.status = 500;
    await expect(r.decode(TOPIC, msg)).rejects.toBeInstanceOf(SchemaUnavailableError);
    state.status = undefined;
    await expect(r.decode(TOPIC, msg)).resolves.toMatchObject({ kind: 'record', schemaId: 2 });
    down = true;
    await expect(r.decode(TOPIC, msg)).resolves.toMatchObject({ kind: 'record', schemaId: 2 });
    expect(state.requests).toEqual(['/schemas/ids/2', '/schemas/ids/2']);
  });

  test('ST-T16 ① 원천이 정한 두 오류 밖의 예외를 던지거나 Avro로 읽히지 않는 스키마를 주면 다시 시도할 장애다', async () => {
    const throwing = { byId: async () => Promise.reject(new Error('socket closed')) } satisfies SchemaSource;
    const garbage = { byId: async () => ({ type: 'nope' }) } satisfies SchemaSource;
    for (const source of [throwing, garbage]) {
      const r = createAvroReader({ source, readerSchemas: [V1] });
      await expect(r.decode(TOPIC, bytesOf(2, V2, NEW_VALUE))).rejects.toBeInstanceOf(SchemaUnavailableError);
    }
  });
});

describe('OPS-150 ⑩ 머리와 스키마 ID 대조', () => {
  const known = { id: 1, amount: 1, state: 'OPEN', meta: { phase: 'OPEN' }, items: [], maybe: null };

  test('OPS-150 ⑩ 매직 바이트가 0이 아니거나 5바이트보다 짧거나 ID가 0·MAX_SCHEMA_ID + 1이면 조회 없이 DESERIALIZE(스키마 ID 없음)로 거절한다', async () => {
    const state = registryState({ 1: V1 });
    const { r } = reader(state);
    const good = bytesOf(1, V1, known);
    const magic1 = Buffer.from(good);
    magic1[0] = 1;
    const id0 = Buffer.from(good);
    id0.writeUInt32BE(0, 1);
    const idOver = Buffer.from(good);
    idOver.writeUInt32BE(MAX_SCHEMA_ID + 1, 1);
    for (const [name, bytes] of Object.entries({ magic1, short: good.subarray(0, 4), empty: new Uint8Array(), id0, idOver })) {
      await expect(r.decode(TOPIC, bytes), name).resolves.toEqual({ kind: 'rejected', schemaId: null, reason: 'DESERIALIZE' });
    }
    expect(state.requests).toEqual([]);
  });

  test('OPS-150 ⑩ 경계 ID 1과 MAX_SCHEMA_ID는 그 ID로 조회한다', async () => {
    const state = registryState({ 1: V1, [MAX_SCHEMA_ID]: OTHER });
    const { r } = reader(state);
    await expect(r.decode(TOPIC, bytesOf(1, V1, known))).resolves.toMatchObject({ kind: 'record', schemaId: 1 });
    await expect(r.decode(TOPIC, bytesOf(MAX_SCHEMA_ID, OTHER, { seq: 3, note: 'x' }))).resolves.toMatchObject({ kind: 'record', schemaId: MAX_SCHEMA_ID, recordName: 'peaket.it.Beat', value: { seq: 3, note: 'x' } });
    expect(state.requests).toEqual(['/schemas/ids/1', '/schemas/ids/2147483647']);
  });

  test('OPS-150 ⑩ 같은 토픽에서 ID 7과 8에 다른 스키마를 두면 각 메시지가 제 ID의 스키마로 풀리고 요청 경로가 그 ID다', async () => {
    const state = registryState({ 7: V1, 8: OTHER });
    const { r } = reader(state);
    const a = bytesOf(7, V1, known);
    const b = bytesOf(8, OTHER, { seq: 12, note: '둘째' });
    await expect(r.decode(TOPIC, a)).resolves.toEqual({ kind: 'record', schemaId: 7, recordName: 'peaket.it.Pulse', value: known, unrecognized: [] });
    await expect(r.decode(TOPIC, b)).resolves.toEqual({ kind: 'record', schemaId: 8, recordName: 'peaket.it.Beat', value: { seq: 12, note: '둘째' }, unrecognized: [] });
    await expect(r.decode(TOPIC, a)).resolves.toMatchObject({ schemaId: 7, recordName: 'peaket.it.Pulse' });
    expect(state.requests).toEqual(['/schemas/ids/7', '/schemas/ids/8']);
  });

  test('OPS-150 ⑩ 같은 ID를 동시에 풀면 조회는 하나다', async () => {
    const state = registryState({ 7: V1 });
    const { r } = reader(state);
    const msg = bytesOf(7, V1, known);
    const all = await Promise.all([r.decode(TOPIC, msg), r.decode(TOPIC, msg), r.decode(TOPIC, msg)]);
    expect(all.map((o) => o.kind)).toEqual(['record', 'record', 'record']);
    expect(state.requests).toEqual(['/schemas/ids/7']);
  });
});

describe('OPS-150 ⑥ 거절 분류', () => {
  const known = { id: 1, amount: 1, state: 'OPEN', meta: { phase: 'OPEN' }, items: [], maybe: null };

  test('OPS-150 ⑥ 몸이 쓴 쪽 스키마로 풀리지 않으면(모자람·남음) 그 ID를 싣고 DESERIALIZE로 거절한다', async () => {
    const { r } = reader(registryState({ 1: V1 }));
    const good = bytesOf(1, V1, known);
    await expect(r.decode(TOPIC, good.subarray(0, good.length - 1))).resolves.toEqual({ kind: 'rejected', schemaId: 1, reason: 'DESERIALIZE' });
    await expect(r.decode(TOPIC, Buffer.concat([good, Buffer.from([0x02])]))).resolves.toEqual({ kind: 'rejected', schemaId: 1, reason: 'DESERIALIZE' });
  });

  test('OPS-150 ⑥ 빌드된 판의 기본값 없는 필드가 쓴 쪽에 없으면 MISSING_FIELD, 기본값 있는 필드가 없는 것은 받는다', async () => {
    const withoutMaybe = { ...V1, fields: V1.fields.filter((f) => f.name !== 'maybe') };
    const { r } = reader(registryState({ 3: NO_AMOUNT, 4: withoutMaybe }));
    await expect(r.decode(TOPIC, bytesOf(3, NO_AMOUNT, { id: 1, state: 'OPEN', meta: { phase: 'OPEN' }, items: [], maybe: null }))).resolves.toEqual({ kind: 'rejected', schemaId: 3, reason: 'MISSING_FIELD' });
    await expect(r.decode(TOPIC, bytesOf(4, withoutMaybe, { id: 1, amount: 2, state: 'OPEN', meta: { phase: 'OPEN' }, items: [] }))).resolves.toMatchObject({ kind: 'record', schemaId: 4 });
  });
});
