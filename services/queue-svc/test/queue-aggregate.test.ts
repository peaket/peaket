// 관제 1초 대기 집계 QueueAggregate(F-04-20, asyncapi telemetry.queue, docs/streaming.md §4.1·§4.2).
// 감독 조건(2026-11-23): A등급 경로(진입·입장 확정)에는 세는 줄만 더하고, Kafka 생산이 막혀도 진입·입장 확정이 그대로 성공해야 한다.
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { avroSchemas, localSchemaIds } from '@peaket/contracts/avro';
import { createService, decodeConfluent, systemClock, TelemetrySink } from '@peaket/platform';
import { createAvroReader } from '@peaket/platform/stream-worker';
import { createAvroEncoder } from '@peaket/platform/avro';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAdmissionStore } from '../src/modules/admission/adapters/memory-admission-store.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { QUEUE_AGGREGATE_RECORD, QueueAggregator, TELEMETRY_QUEUE_TOPIC, aggregateEventKey } from '../src/queue-aggregate.js';
import { signer } from './admission-cases.js';
import { ACCOUNT, DEVICE, JNY, newEvent, newRequest, openSchedule, PID, preverifyToken, recordingRisk, tokens } from './support.js';

const POD = 'queue-svc-7f9';
const E = '0b8f6f3e-1111-4c2a-9d0e-000000000001';
const T0 = Date.parse('2026-11-23T05:00:00.250Z');

describe('F-04-20 1초 칸 세기와 내기', () => {
  const make = (now: { t: number }, sent: { topic: string; key: string; value: Record<string, unknown> }[], dropped: number[] = []) =>
    new QueueAggregator({
      pod: POD,
      now: () => now.t,
      encode: (m) => Buffer.from(JSON.stringify(m)),
      offer: (topic, m) => void sent.push({ topic, key: m.key, value: JSON.parse(m.value.toString()) as Record<string, unknown> }),
      dropped: (n) => void dropped.push(n),
    });

  test('끝난 칸만 회차마다 한 건씩 키 회차:파드로 내고, 같은 칸의 eventKey는 늘 같다', () => {
    const now = { t: T0 };
    const sent: { topic: string; key: string; value: Record<string, unknown> }[] = [];
    const a = make(now, sent);
    a.entered(E);
    a.entered(E);
    a.removed(E);
    a.admitted(E);
    a.soon(E);
    a.entered('other');
    expect(a.flush(now.t)).toBe(0); // 아직 지금 칸
    now.t = T0 + 1_000;
    a.entered(E); // 다음 칸
    expect(a.flush(now.t)).toBe(2);
    const mine = sent.find((s) => s.key === `${E}:${POD}`)!;
    expect(mine.topic).toBe(TELEMETRY_QUEUE_TOPIC);
    expect(mine.value).toEqual({ eventId: E, second: '2026-11-23T05:00:00.000Z', entries: 2, removed: 1, admissions: 1, soonResponses: 1, eventKey: aggregateEventKey(POD, E, Date.parse('2026-11-23T05:00:00Z')) });
    expect(String(mine.value.eventKey)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(aggregateEventKey(POD, E, 1)).toBe(aggregateEventKey(POD, E, 1));
    expect(aggregateEventKey(POD, E, 1)).not.toBe(aggregateEventKey('other-pod', E, 1));
    // 멈추면 지금 칸도 낸다
    a.stop();
    expect(sent.filter((s) => s.key === `${E}:${POD}`).map((s) => s.value.entries)).toEqual([2, 1]);
  });

  test('인코딩·버퍼가 던져도 세기는 던지지 않고 버린 수로 센다', () => {
    const dropped: number[] = [];
    const offerThrows = new QueueAggregator({ pod: POD, now: () => T0, encode: (m) => Buffer.from(JSON.stringify(m)), offer: () => {
      throw new Error('kafka down');
    }, dropped: (n) => void dropped.push(n) });
    const encodeThrows = new QueueAggregator({ pod: POD, now: () => T0, encode: () => {
      throw new Error('schema-ids 없음');
    }, offer: () => undefined, dropped: (n) => void dropped.push(n) });
    for (const a of [offerThrows, encodeThrows]) {
      expect(() => a.entered(E)).not.toThrow();
      expect(() => a.flush(T0 + 1_000)).not.toThrow();
    }
    expect(dropped).toEqual([1, 1]);
  });

  test('1초 집계 비용: 세기 100만 번이 진입 처리량에 주는 영향(측정 값을 계획 파일에 남긴다)', () => {
    const a = make({ t: T0 }, []);
    const N = 1_000_000;
    const t = performance.now();
    for (let i = 0; i < N; i += 1) a.entered(E);
    const ms = performance.now() - t;
    // 한 번에 1µs를 크게 넘으면(바쁜 PC 여유 5배) 진입 경로에 보이는 비용이다
    expect(ms / N).toBeLessThan(5e-3);
    console.log(`[F-04-20 비용] 세기 ${N.toLocaleString()}번 ${ms.toFixed(1)}ms = 한 번 ${((ms / N) * 1000).toFixed(3)}µs`);
  });
});

describe('F-04-20 A-T26 ④ QueueAggregate 공통 판정(계약 판 인코더)', () => {
  test('A-T26 ④ 앞 다섯 바이트가 매직 0과 설정의 주제 ID이고 계약 판으로 풀리며, 같은 칸을 다시 만들면 eventKey가 같다', async () => {
    const subject = `${TELEMETRY_QUEUE_TOPIC}-${QUEUE_AGGREGATE_RECORD}`;
    const encoder = createAvroEncoder({ schemaIds: localSchemaIds, schemas: avroSchemas, produces: [{ topic: TELEMETRY_QUEUE_TOPIC, record: QUEUE_AGGREGATE_RECORD }] });
    const out: Buffer[] = [];
    const run = () => {
      const a = new QueueAggregator({ pod: POD, now: () => T0, encode: (m) => encoder.encode(TELEMETRY_QUEUE_TOPIC, QUEUE_AGGREGATE_RECORD, m), offer: (_t, m) => void out.push(m.value) });
      a.entered(E);
      a.admitted(E);
      a.flush(T0 + 1_000);
    };
    run();
    run();
    expect(out).toHaveLength(2);
    const { schemaId, payload } = decodeConfluent(out[0]!);
    expect(out[0]![0]).toBe(0);
    expect(schemaId).toBe(localSchemaIds[subject]);
    expect(payload.byteLength).toBeGreaterThan(0);
    const reader = createAvroReader({ source: { byId: async (id) => (id === localSchemaIds[subject] ? avroSchemas[QUEUE_AGGREGATE_RECORD] : Promise.reject(new Error('모르는 ID'))) }, readerSchemas: [avroSchemas[QUEUE_AGGREGATE_RECORD]] });
    const d = await reader.decode(TELEMETRY_QUEUE_TOPIC, out[0]!);
    expect(d.kind).toBe('record');
    const v = (d as { value: Record<string, unknown> }).value;
    expect(v).toMatchObject({ eventId: E, second: Date.parse('2026-11-23T05:00:00Z'), entries: 1, removed: 0, admissions: 1, soonResponses: 0 });
    expect((d as { unrecognized: unknown[] }).unrecognized).toEqual([]);
    expect(out[1]!.equals(out[0]!)).toBe(true);
  });
});

describe('F-04-20 Kafka 생산이 막혀도 진입·입장 확정이 그대로 성공한다(A등급 경로, 감독 조건)', () => {
  let svc: Awaited<ReturnType<typeof createService>>;
  const quiet = new Writable({ write: (_c, _e, cb) => cb() });
  const schedules = new MemoryEventSchedules();
  const store = new MemoryAdmissionStore(systemClock);
  // 끝나지 않는 보내기(브로커가 멈춘 생산자)와 쌓이는 버퍼. offer는 기다리지 않는다
  const neverSends = new TelemetrySink({ send: () => new Promise<void>(() => undefined), onDropped: () => undefined, capacity: 2 });
  let offered = 0;
  const counts = new QueueAggregator({
    pod: POD,
    now: () => systemClock.now(),
    encode: (m) => Buffer.from(JSON.stringify(m)),
    offer: (topic, m) => {
      offered += 1;
      neverSends.offer('QueueAggregate', topic, m);
    },
  });

  beforeAll(async () => {
    svc = await createService({
      name: 'queue-svc',
      module: AppModule.register({ memory: true, schedules, tokens, risk: recordingRisk(), state: { autoTick: false }, admission: { store, signer }, queueCounts: counts }),
      env: { PEAKET_ENV: 'ci' },
      clock: systemClock,
      logDestination: quiet,
    });
  });
  afterAll(async () => {
    await svc?.close();
  });

  const fan = { 'x-user-id': ACCOUNT, 'x-session-id': 's-1', 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': PID, 'content-type': 'text/plain;charset=UTF-8' };

  test('진입 201과 입장 확정 200 ADMITTED가 막힌 생산자와 상관없이 나오고, 세기는 그대로 된다', async () => {
    const eventId = newEvent();
    await schedules.set(eventId, openSchedule(Date.now(), { openBatch: false }));
    // 생산자를 먼저 막아 둔다(버퍼를 넘치게 채움)
    for (let i = 0; i < 5; i += 1) neverSends.offer('QueueAggregate', TELEMETRY_QUEUE_TOPIC, { key: 'k', value: Buffer.from('x') });
    const t = performance.now();
    const entered = await svc.http.inject({ method: 'POST', url: `/v1/queues/${eventId}/entries`, headers: fan, payload: JSON.stringify({ preverifyToken: preverifyToken(svc.clock, eventId), deviceId: DEVICE, entryRequestId: newRequest() }) });
    expect(entered.statusCode).toBe(201);
    // 입장 확정: 차례가 온 대기표(serving 200, 60초 전에 차례)
    store.db.ev(eventId).set('serving', 200);
    store.db.servingLog(eventId).set(String(Math.floor((Date.now() - 60_000) / 1000)), 200);
    const ticket = tokens.ticket({ e: eventId, a: ACCOUNT, d: DEVICE, s: 150, g: 1, seg: 0, rq: crypto.randomUUID(), jny: JNY });
    const admitted = await svc.http.inject({ method: 'POST', url: `/v1/queues/${eventId}/admission`, headers: fan, payload: JSON.stringify({ queueTicket: ticket }) });
    expect(admitted.statusCode).toBe(200);
    expect(JSON.parse(admitted.payload).status).toBe('ADMITTED');
    const elapsed = performance.now() - t;
    expect(elapsed).toBeLessThan(5_000);
    // 세기는 그 칸에 들어 있고(내기는 막힌 버퍼로 가도 던지지 않는다)
    counts.flush(Date.now() + 1_000);
    expect(offered).toBeGreaterThanOrEqual(1);
    console.log(`[F-04-20 A등급] 막힌 생산자에서 진입 201·입장 확정 200 ADMITTED, 두 요청 ${elapsed.toFixed(0)}ms, 낸 칸 ${offered}건(버퍼가 버림)`);
  });
});
