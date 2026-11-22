// 스트림 작업자 묶음 실행기(runBatchWorker)를 실제 Kafka(컨테이너 한 대)와 시험 안 레지스트리 HTTP 서버로 본다
// (BAT-220 계획 §6 ST-T15 통합·ST-T16 ① 통합·OPS-150 ①④⑤⑥⑦⑧, docs/streaming.md §2.4·§2.6·§2.7, ADR-0335).
// 싱크는 바깥 경계(ClickHouse 자리)라 시험이 BatchSink를 구현한 기록 싱크를 준다. 읽기·실행기·레지스트리 조회는 모두 진짜다.
// 커밋 위치는 브로커 컨테이너의 도구로 읽는다(containers.ts groupOffsets). 단언 값은 정본에서 적는다: 커밋 '끝 오프셋 + 1'(§2.4),
// 지연 0.2초에서 두 배씩(§2.4 '묶음 세부'), 표시 글 `<토픽>:<파티션>:<첫>:<끝>`, client.id `<작업자>-<환경>-<파드>`(§2.6), 지표 이름·라벨(§2.7).
import { execSync, fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Registry } from '@prometheus-io/client';
import avsc from 'avsc';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { encodeConfluent } from '../src/avro.js';
import type { BatchSink, ClosedBatch } from '../src/batch-consumer.js';
import { createAvroReader, createKafkaProducer, runBatchWorker, schemaRegistrySource, type AvroReader, type BatchWorkerRun, type KafkaProducer } from '../src/stream-worker.js';
import { sample } from '../test/fixture.js';
import { registryState, type RegistryState } from '../test/schema-registry-fake.js';
import { startKafka, type KafkaContainer } from './containers.js';
import { startRegistryServer, type RegistryServer } from './registry-server.js';

const PLATFORM = fileURLToPath(new URL('..', import.meta.url));
const WORKER = 'ops-rt-it';
const ENV = 'ci';
const REGISTRY_USER = 'ops-rt-it';
const REGISTRY_PASSWORD = 'It-Reg-Pa55word';

const order = (symbols: string[], withAmount = true) => ({
  type: 'record',
  name: 'Order',
  namespace: 'peaket.it',
  fields: [{ name: 'seq', type: 'long' }, ...(withAmount ? [{ name: 'amount', type: 'long' }] : []), { name: 'state', type: { type: 'enum', name: 'OrderState', symbols } }],
});
/** 작업자가 빌드된 계약 판 */
const V1 = order(['PLACED', 'PAID']);
/** 생산자의 새 판(기호 REFUND_PENDING이 늘었다) */
const V2 = order(['PLACED', 'PAID', 'REFUND_PENDING']);
/** 필수 필드 amount가 없는 판 */
const NO_AMOUNT = order(['PLACED', 'PAID'], false);
const SCHEMAS = { 1: V1, 2: V2, 3: NO_AMOUNT };

interface Val {
  seq: number;
  amount: number;
  state: string;
}

const msg = (id: number, schema: unknown, v: Record<string, unknown>) => encodeConfluent(id, avsc.Type.forSchema(schema as avsc.Schema).toBuffer(v));
const valid = (seq: number, amount = 100 + seq) => msg(1, V1, { seq, amount, state: 'PAID' });

let kafka: KafkaContainer;
let producer: KafkaProducer;
let shared: RegistryServer;
let sharedState: RegistryState;
const runs: BatchWorkerRun[] = [];
const children: ChildProcess[] = [];
/** 끝나지 않게 붙잡은 싱크 쓰기를 시험 끝에 푼다 */
const hung: (() => void)[] = [];

beforeAll(async () => {
  // 강제 종료 시험의 자식 프로세스는 빌드한 플랫폼을 쓴다(패키지 관리자 없이 컴파일러만, 'pnpm run build'와 같다)
  execSync('npx --no-install tsc -p tsconfig.build.json', { cwd: PLATFORM, stdio: 'ignore' });
  kafka = await startKafka();
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'bat220-producer', kind: 'default' });
  await producer.connect();
  sharedState = registryState(SCHEMAS);
  shared = await startRegistryServer(sharedState);
}, 300_000);

afterAll(async () => {
  for (const c of children) c.kill('SIGKILL');
  for (const h of hung) h();
  await Promise.all(runs.map((r) => r.stop().catch(() => {})));
  await producer?.disconnect().catch(() => {});
  await shared?.close();
  kafka?.stop();
}, 120_000);

const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`기다린 ${what}이(가) ${ms}ms 안에 오지 않았다`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

async function produce(topic: string, partition: number, values: Buffer[]): Promise<void> {
  await producer.send({ topic, messages: values.map((value) => ({ partition, value })) });
}

interface Write {
  at: number;
  batch: ClosedBatch<Val>;
}

/** 기록 싱크(ClickHouse 자리). hook이 던지면 실행기가 같은 묶음을 다시 보낸다 */
class RecordingSink implements BatchSink<Val> {
  readonly table = 'it.orders';
  readonly attempts: Write[] = [];
  readonly done: Write[] = [];
  inFlight = 0;
  maxInFlight = 0;
  maxPerPartition = 0;
  readonly #perPartition = new Map<number, number>();
  constructor(private readonly hook: (b: ClosedBatch<Val>) => Promise<void> = async () => {}) {}
  async write(b: ClosedBatch<Val>): Promise<void> {
    this.attempts.push({ at: performance.now(), batch: structuredClone(b) });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const n = (this.#perPartition.get(b.partition) ?? 0) + 1;
    this.#perPartition.set(b.partition, n);
    this.maxPerPartition = Math.max(this.maxPerPartition, n);
    try {
      await this.hook(b);
      this.done.push({ at: performance.now(), batch: structuredClone(b) });
    } finally {
      this.inFlight -= 1;
      this.#perPartition.set(b.partition, (this.#perPartition.get(b.partition) ?? 1) - 1);
    }
  }
  offsets(partition: number): string[] {
    return this.done.filter((w) => w.batch.partition === partition).flatMap((w) => w.batch.records.map((r) => r.offset));
  }
  records(): Val[] {
    return this.done.flatMap((w) => w.batch.records.map((r) => r.value));
  }
}

const readerFor = (url: string, o: { auth?: boolean; keepUnknownSymbols?: boolean } = {}): AvroReader =>
  createAvroReader({
    source: schemaRegistrySource({ url, env: ENV, ...(o.auth ? { auth: { user: REGISTRY_USER, password: REGISTRY_PASSWORD } } : {}) }),
    readerSchemas: [V1],
    keepUnknownSymbols: o.keepUnknownSymbols,
  });

function startWorker(o: { topic: string; group: string; sink: RecordingSink; reader?: AvroReader; pod?: string; maxRecords?: number; maxWaitMs?: number; maxInFlight?: number; drainTimeoutMs?: number }) {
  const warnings: { o: Record<string, unknown>; msg?: string }[] = [];
  const metrics = new Registry();
  const reader = o.reader ?? readerFor(shared.url);
  const run = runBatchWorker<Val>({
    brokers: kafka.brokers,
    worker: WORKER,
    env: ENV,
    pod: o.pod ?? 'pod-a',
    groupId: o.group,
    topics: [o.topic],
    decode: (m) => reader.decode(m.topic, m.value ?? new Uint8Array()),
    sink: o.sink,
    maxRecords: o.maxRecords ?? 5,
    maxWaitMs: o.maxWaitMs ?? 200,
    ...(o.maxInFlight !== undefined ? { maxInFlight: o.maxInFlight } : {}),
    ...(o.drainTimeoutMs !== undefined ? { drainTimeoutMs: o.drainTimeoutMs } : {}),
    registry: metrics,
    logger: { warn: (x: object, m?: string) => void warnings.push({ o: x as Record<string, unknown>, msg: m }) },
  });
  runs.push(run);
  const metric = async (name: string, labels: Record<string, string> = {}) => sample(await metrics.metrics(), name, { worker: WORKER, ...labels });
  return { run, warnings, metric };
}

const range = (n: number, from = 0) => Array.from({ length: n }, (_, i) => String(from + i));

test('ST-T15 ④ 새 판 스키마의 모르는 열거 기호가 섞여도 거절 0, 싱크 건수·합계가 낸 것과 같고 stream_unrecognized_symbol_total이 넣은 수와 같다(OPS-150 ⑧ client.id·소비 밀림)', async () => {
  const topic = 'bat220.st15';
  const group = 'bat220-st15';
  await kafka.createTopic(topic, 2);
  let sum = 0;
  let unknown = 0;
  for (const p of [0, 1]) {
    const values: Buffer[] = [];
    for (let seq = 0; seq < 20; seq += 1) {
      const amount = 100 + seq * 7 + p;
      sum += amount;
      if (seq % 2 === 0) values.push(msg(1, V1, { seq, amount, state: 'PAID' }));
      else if (seq % 4 === 1) {
        unknown += 1;
        values.push(msg(2, V2, { seq, amount, state: 'REFUND_PENDING' }));
      } else values.push(msg(2, V2, { seq, amount, state: 'PLACED' }));
    }
    await produce(topic, p, values);
  }
  expect(unknown).toBe(10);
  const sink = new RecordingSink();
  const w = startWorker({ topic, group, sink });
  await w.run.started;
  await until(() => sink.records().length >= 40, '40건 싣기');
  // client.id = <작업자>-<환경>-<파드>(브로커가 보는 소비자 CLIENT-ID)
  const owners = await kafka.groupOwners(group, topic);
  expect([...owners.values()]).toEqual([`${WORKER}-${ENV}-pod-a`, `${WORKER}-${ENV}-pod-a`]);
  await until(async () => {
    const c = await kafka.groupOffsets(group, topic);
    return c.get(0) === 20 && c.get(1) === 20;
  }, '파티션마다 끝 + 1 커밋');
  await until(async () => (await w.metric('stream_consumer_lag_records', { topic, partition: '0' })) === 0 && (await w.metric('stream_consumer_lag_records', { topic, partition: '1' })) === 0, '소비 밀림 0');
  await w.run.stop();

  const records = sink.records();
  expect(records).toHaveLength(40);
  expect(sink.done.flatMap((d) => d.batch.rejected)).toEqual([]);
  expect(records.reduce((a, r) => a + r.amount, 0)).toBe(sum);
  expect(records.filter((r) => r.state === 'UNRECOGNIZED')).toHaveLength(10);
  expect(records.filter((r) => r.state === 'REFUND_PENDING')).toHaveLength(0);
  expect(sink.offsets(0)).toEqual(range(20));
  expect(sink.offsets(1)).toEqual(range(20));
  expect(await w.metric('stream_unrecognized_symbol_total', { topic, record: 'peaket.it.Order', field: 'state' })).toBe(10);
  expect(await w.metric('stream_rejected_total')).toBeUndefined();
}, 180_000);

test('ST-T16 ① 레지스트리가 닫힌 채 새 실행기(캐시 빔)를 띄우면 그 파티션을 멈추고 싣지도 거절하지도 커밋하지도 않으며, 되살리면 빠짐·겹침 없이 순서대로 싣고 끝 + 1을 커밋한다', async () => {
  const topic = 'bat220.st16';
  const group = 'bat220-st16';
  await kafka.createTopic(topic, 2);
  const state = registryState({ 5: V2 });
  const srv = await startRegistryServer(state);
  await srv.close();
  for (const p of [0, 1]) await produce(topic, p, range(6).map((s) => msg(5, V2, { seq: Number(s), amount: 10 + Number(s), state: 'PAID' })));
  const sink = new RecordingSink();
  const w = startWorker({ topic, group, sink, reader: readerFor(srv.url, { auth: true }), maxRecords: 3 });
  await w.run.started;
  const lookupFailures = () => w.warnings.filter((x) => x.o.kind === 'stream-worker' && /스키마를 읽지 못해/.test(x.msg ?? '')).length;
  // 멈춘 사례가 실제로 있었는지(조회 실패가 두 파티션에서 다시 시도까지 셋 이상) 본다. 싱크가 먼저 받으면(거절로 샜으면) 바로 실패로 넘어간다
  await until(() => lookupFailures() >= 3 || sink.attempts.length > 0, '레지스트리 조회 실패');
  expect(sink.attempts.map((a) => ({ records: a.batch.records.length, rejected: a.batch.rejected.map((r) => r.reason) }))).toEqual([]);
  expect(lookupFailures()).toBeGreaterThanOrEqual(3);
  expect(await w.metric('stream_paused_partitions')).toBeGreaterThanOrEqual(1);
  expect(await w.metric('stream_rejected_total', { topic, reason: 'DESERIALIZE' })).toBeUndefined();
  expect(await w.metric('stream_rejected_total', { topic, reason: 'UNKNOWN_SCHEMA' })).toBeUndefined();
  expect([...(await kafka.groupOffsets(group, topic)).entries()]).toEqual([]);
  expect(state.requests).toEqual([]);
  // RV220-1: 멈춘 파티션에도 소비 밀림을 고친다. 쌓인 6건이 밀림으로 보이고, 멈춘 채 4건을 더 내면 그만큼 는다(streaming §2.6 '그동안 소비 밀림이 는다',
  // 경보 '계속 늘면 SEV3'). 고치는 주기는 [가정] 값이라 고정 대기 없이 한도 있는 조건 기다림으로 본다
  const lagOf = (p: number) => w.metric('stream_consumer_lag_records', { topic, partition: String(p) });
  await until(async () => (await lagOf(0)) === 6 && (await lagOf(1)) === 6, '멈춘 파티션의 밀림 6', 60_000);
  for (const p of [0, 1]) await produce(topic, p, range(4, 6).map((s) => msg(5, V2, { seq: Number(s), amount: 10 + Number(s), state: 'PAID' })));
  await until(async () => (await lagOf(0)) === 10 && (await lagOf(1)) === 10, '멈춘 동안 더 낸 4건만큼 는 밀림 10', 60_000);
  expect(sink.attempts).toEqual([]);

  await srv.reopen();
  await until(() => sink.records().length >= 20, '되살린 뒤 20건 싣기', 90_000);
  await until(async () => {
    const c = await kafka.groupOffsets(group, topic);
    return c.get(0) === 10 && c.get(1) === 10;
  }, '되살린 뒤 끝 + 1 커밋');
  await until(async () => (await w.metric('stream_paused_partitions')) === 0, '멈춘 파티션 0');
  await until(async () => (await lagOf(0)) === 0 && (await lagOf(1)) === 0, '되살린 뒤 밀림 0');
  await w.run.stop();
  await srv.close();
  expect(sink.offsets(0)).toEqual(range(10));
  expect(sink.offsets(1)).toEqual(range(10));
  expect(sink.done.flatMap((d) => d.batch.rejected)).toEqual([]);
  expect(await w.metric('stream_rejected_total', { topic, reason: 'DESERIALIZE' })).toBeUndefined();
  // 같은 ID는 캐시해 두 파티션이 함께 쓴다. 요청마다 Basic 머리가 실리고, 자격은 어느 로그에도 없다
  expect(state.requests.length).toBeGreaterThanOrEqual(1);
  expect(new Set(state.requests)).toEqual(new Set(['/schemas/ids/5']));
  expect(new Set(state.authorization)).toEqual(new Set([`Basic ${Buffer.from(`${REGISTRY_USER}:${REGISTRY_PASSWORD}`).toString('base64')}`]));
  const logs = JSON.stringify(w.warnings);
  expect(logs).not.toContain(REGISTRY_PASSWORD);
  expect(logs).not.toContain(Buffer.from(`${REGISTRY_USER}:${REGISTRY_PASSWORD}`).toString('base64'));
}, 180_000);

test('OPS-150 ① 쓰기가 끝나기 전에는 커밋하지 않고, 끝나면 정확히 끝 + 1(9 → 10)을 커밋한다', async () => {
  const topic = 'bat220.commit';
  const group = 'bat220-commit';
  await kafka.createTopic(topic, 1);
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  hung.push(open);
  const sink = new RecordingSink(async (b) => {
    if (b.firstOffset === '0') await gate;
  });
  await produce(topic, 0, range(10).map((s) => valid(Number(s))));
  const w = startWorker({ topic, group, sink, maxRecords: 10, maxWaitMs: 60_000 });
  await w.run.started;
  await until(() => sink.attempts.length === 1, '첫 묶음 쓰기 시작');
  expect(sink.attempts[0]!.batch).toMatchObject({ firstOffset: '0', lastOffset: '9', dedupToken: 'bat220.commit:0:0:9' });
  // 쓰는 동안 여러 번 읽어도 커밋이 없다(브로커 도구 한 번에 약 0.5초)
  for (let i = 0; i < 3; i += 1) expect((await kafka.groupOffsets(group, topic)).get(0)).toBeUndefined();
  open();
  await until(async () => (await kafka.groupOffsets(group, topic)).get(0) !== undefined, '쓰기 뒤 커밋');
  expect((await kafka.groupOffsets(group, topic)).get(0)).toBe(10);
  await w.run.stop();
  expect(sink.done).toHaveLength(1);
}, 120_000);

test('OPS-150 ① 쓰기 뒤·커밋 전에 실행기 프로세스를 죽이면 다시 띄운 실행기가 그 묶음을 다시 받고 끝 + 1을 커밋한다', async () => {
  const topic = 'bat220.kill';
  const group = 'bat220-kill';
  await kafka.createTopic(topic, 1);
  await produce(topic, 0, range(6).map((s) => valid(Number(s))));
  const child = fork(fileURLToPath(new URL('./batch-worker-child.mjs', import.meta.url)), [kafka.brokers.join(','), shared.url, group, topic, JSON.stringify(V1)], { stdio: 'ignore' });
  children.push(child);
  const wrote = await new Promise<{ first: string; last: string; offsets: string[] }>((resolve, reject) => {
    child.on('message', (m) => {
      if (typeof m === 'object' && m && 'wrote' in m) resolve((m as { wrote: { first: string; last: string; offsets: string[] } }).wrote);
    });
    child.once('exit', (code) => reject(new Error(`자식 실행기가 먼저 끝났다(${code})`)));
  });
  child.kill('SIGKILL');
  expect(wrote).toEqual({ first: '0', last: '2', offsets: ['0', '1', '2'] });
  expect((await kafka.groupOffsets(group, topic)).get(0)).toBeUndefined();

  const sink = new RecordingSink();
  const w = startWorker({ topic, group, sink, maxRecords: 3, pod: 'pod-b' });
  await w.run.started;
  // 죽은 소비자의 세션(45초)이 끝나야 새 소비자가 파티션을 받는다
  await until(() => sink.offsets(0).length >= 6, '다시 띄운 실행기가 6건 싣기', 150_000);
  await until(async () => (await kafka.groupOffsets(group, topic)).get(0) === 6, '끝 + 1 커밋');
  await w.run.stop();
  const again = sink.offsets(0).filter((o) => wrote.offsets.includes(o));
  expect(again.length).toBeGreaterThan(0);
  expect(sink.offsets(0)).toEqual(range(6));
}, 240_000);

test('OPS-150 ④ 싱크가 실패하면 같은 묶음(같은 표시·같은 레코드)을 늘려 쉬며 다시 보내고, 그 파티션만 멈추며 성공 뒤 지연이 처음으로 돌아간다', async () => {
  const topic = 'bat220.retry';
  const group = 'bat220-retry';
  await kafka.createTopic(topic, 2);
  // 첫 묶음은 다섯 번 넘게, 멈춘 동안의 밀림을 본 뒤까지 실패한다(RV220-1). 둘째 묶음은 두 번 실패한다
  let firstFails = 0;
  let lagSeen = false;
  let secondFails = 2;
  const sink = new RecordingSink(async (b) => {
    if (b.dedupToken === 'bat220.retry:0:0:2' && (firstFails < 5 || !lagSeen)) {
      firstFails += 1;
      throw new Error('clickhouse 503');
    }
    if (b.dedupToken === 'bat220.retry:0:3:5' && secondFails > 0) {
      secondFails -= 1;
      throw new Error('clickhouse 503');
    }
  });
  await produce(topic, 0, range(3).map((s) => valid(Number(s))));
  const w = startWorker({ topic, group, sink, maxRecords: 3, maxWaitMs: 60_000 });
  await w.run.started;
  const lag0 = () => w.metric('stream_consumer_lag_records', { topic, partition: '0' });
  // 첫 실패로 그 파티션이 멈춘 것을 본 뒤에 더 낸다(멈추기 전에 받아 버리면 밀림이 늘지 않는다)
  await until(async () => (await w.metric('stream_paused_partitions')) === 1, '첫 실패로 멈춤');
  await until(async () => (await lag0()) === 0, '멈추기 전 밀림 0');
  // 다시 시도하는 동안 같은 파티션과 다른 파티션에 더 넣는다
  await produce(topic, 0, range(3, 3).map((s) => valid(Number(s))));
  await produce(topic, 1, range(3).map((s) => valid(Number(s))));
  await until(() => sink.done.some((d) => d.batch.partition === 1), '다른 파티션 싣기');
  // 그때 파티션 0은 아직 다시 시도 중이다(지연 합 0.2+0.4+0.8+1.6+3.2초 넘게)
  expect(sink.done.filter((d) => d.batch.partition === 0)).toEqual([]);
  expect(await w.metric('stream_paused_partitions')).toBe(1);
  // RV220-1: 쓰기 다시 시도로 멈춘 동안 더 낸 3건만큼 밀림이 는다(고치는 주기는 [가정] 값이라 한도 있는 조건 기다림)
  await until(async () => (await lag0()) === 3, '다시 시도로 멈춘 파티션 0의 밀림 3', 60_000).finally(() => (lagSeen = true));
  await until(() => sink.offsets(0).length === 6, '파티션 0 여섯 건', 90_000);
  await until(async () => {
    const c = await kafka.groupOffsets(group, topic);
    return c.get(0) === 6 && c.get(1) === 3;
  }, '커밋');
  await until(async () => (await w.metric('stream_paused_partitions')) === 0, '멈춘 파티션 0');
  await until(async () => (await lag0()) === 0, '다시 받은 뒤 밀림 0');
  await w.run.stop();

  const first = sink.attempts.filter((a) => a.batch.dedupToken === 'bat220.retry:0:0:2');
  expect(first.length).toBeGreaterThanOrEqual(6);
  for (const a of first) expect(a.batch.records.map((r) => r.offset)).toEqual(['0', '1', '2']);
  const gaps = first.slice(1).map((a, i) => a.at - first[i]!.at);
  // 실제 시간이라 아래쪽만 본다(늦게 깨어날 수는 있어도 일찍 깨어나지 않는다)
  [200, 400, 800, 1_600, 3_200].forEach((d, i) => expect(gaps[i], `지연 ${i}`).toBeGreaterThanOrEqual(d - 20));
  const second = sink.attempts.filter((a) => a.batch.dedupToken === 'bat220.retry:0:3:5');
  expect(second).toHaveLength(3);
  for (const a of second) expect(a.batch.records.map((r) => r.offset)).toEqual(['3', '4', '5']);
  const g2 = second.slice(1).map((a, i) => a.at - second[i]!.at);
  expect(g2[0]).toBeGreaterThanOrEqual(180);
  // 성공 뒤 처음(0.2초)으로 돌아갔다: 이어서 늘었다면 6.4초 이상이다
  expect(g2[0]).toBeLessThan(1_500);
  expect(g2[1]).toBeGreaterThanOrEqual(380);
  // 다른 파티션은 파티션 0의 첫 묶음이 성공하기 전에 실렸다
  const p0First = sink.done.find((d) => d.batch.dedupToken === 'bat220.retry:0:0:2')!;
  const p1 = sink.done.find((d) => d.batch.partition === 1)!;
  expect(p1.at).toBeLessThan(p0First.at);
  expect(await w.metric('stream_insert_retries_total')).toBe(first.length - 1 + 2);
}, 240_000);

test('OPS-150 ⑤ 파티션마다 쓰기 하나(순서 유지), 작업자 전체 한도(시험 값 2)에 닿으면 다른 파티션 쓰기가 시작하지 않고 하나 끝나면 다시 연다', async () => {
  const topic = 'bat220.inflight';
  const group = 'bat220-inflight';
  await kafka.createTopic(topic, 3);
  const gates = new Map<string, () => void>();
  let autoOpen = false;
  const sink = new RecordingSink(async (b) => {
    if (autoOpen) return;
    await new Promise<void>((r) => {
      gates.set(b.dedupToken, r);
      hung.push(r);
    });
  });
  // 실행기를 띄우기 전에 세 파티션에 다 넣어 둔다: 묶음 넷(파티션 0에 둘)이 한꺼번에 닫혀 한도보다 많은 쓰기가 기다리게 한다
  await produce(topic, 0, [valid(0), valid(1), valid(2), valid(3)]);
  await produce(topic, 1, [valid(0), valid(1)]);
  await produce(topic, 2, [valid(0), valid(1)]);
  const w = startWorker({ topic, group, sink, maxRecords: 2, maxWaitMs: 60_000, maxInFlight: 2 });
  await w.run.started;
  await until(() => sink.inFlight === 2, '쓰기 둘');
  // fixed-wait: 한도에 닿은 동안 다른 쓰기가 '시작하지 않음'을 보이는 시험이라 기다릴 조건이 없다(1.5초면 받기·묶음 닫기가 넉넉히 끝난다) BAT-220
  await new Promise((r) => setTimeout(r, 1_500));
  expect(sink.inFlight).toBe(2);
  expect(sink.attempts).toHaveLength(2);
  expect(new Set(sink.attempts.map((x) => x.batch.partition)).size).toBe(2);
  gates.get(sink.attempts[0]!.batch.dedupToken)!();
  await until(() => sink.attempts.length === 3, '하나 끝난 뒤 셋째 쓰기');
  expect(sink.inFlight).toBe(2);
  autoOpen = true;
  for (const open of gates.values()) open();
  await until(() => sink.done.length === 4, '네 묶음');
  await until(async () => {
    const c = await kafka.groupOffsets(group, topic);
    return c.get(0) === 4 && c.get(1) === 2 && c.get(2) === 2;
  }, '커밋');
  await w.run.stop();
  expect(sink.maxInFlight).toBe(2);
  expect(sink.maxPerPartition).toBe(1);
  expect(sink.attempts.filter((a) => a.batch.partition === 0).map((a) => a.batch.firstOffset)).toEqual(['0', '2']);
  expect(sink.offsets(0)).toEqual(range(4));
}, 120_000);

test('OPS-150 ⑥ 거절 위치는 그 묶음 쓰기와 함께 넘어가고 쓰기 성공 뒤에만 세고 커밋한다. 모두 거절이면 레코드 없는 쓰기 한 번, 로그에 원문이 없다', async () => {
  const topic = 'bat220.reject';
  const group = 'bat220-reject';
  await kafka.createTopic(topic, 1);
  const MARK = 'SECRET-PAYLOAD-7f3a';
  let failOnce = true;
  const sink = new RecordingSink(async () => {
    if (failOnce) {
      failOnce = false;
      throw new Error('clickhouse 503');
    }
  });
  await produce(topic, 0, [
    valid(0),
    Buffer.concat([Buffer.from([1, 0, 0, 0, 1]), Buffer.from(MARK)]),
    msg(99, V1, { seq: 2, amount: 2, state: 'PAID' }),
    msg(3, NO_AMOUNT, { seq: 3, state: 'PAID' }),
    valid(4),
  ]);
  const w = startWorker({ topic, group, sink, maxRecords: 5, maxWaitMs: 60_000 });
  await w.run.started;
  await until(() => sink.attempts.length === 1, '첫 쓰기(실패)');
  // 쓰기가 실패한 동안은 거절을 세지 않고 위치 로그도 남기지 않는다
  expect(await w.metric('stream_rejected_total', { topic, reason: 'DESERIALIZE' })).toBeUndefined();
  expect(w.warnings.filter((x) => x.o.kind === 'stream-rejected')).toEqual([]);
  await until(() => sink.done.length === 1, '다시 보낸 쓰기 성공');
  const b = sink.done[0]!.batch;
  expect(b.records.map((r) => r.offset)).toEqual(['0', '4']);
  expect(b.rejected.map(({ kafkaTs, ...r }) => ({ ...r, ts: /^\d+$/.test(kafkaTs) }))).toEqual([
    { topic, partition: 0, offset: '1', schemaId: null, reason: 'DESERIALIZE', ts: true },
    { topic, partition: 0, offset: '2', schemaId: 99, reason: 'UNKNOWN_SCHEMA', ts: true },
    { topic, partition: 0, offset: '3', schemaId: 3, reason: 'MISSING_FIELD', ts: true },
  ]);
  for (const r of b.rejected) expect(Object.keys(r).sort()).toEqual(['kafkaTs', 'offset', 'partition', 'reason', 'schemaId', 'topic']);
  await until(async () => (await kafka.groupOffsets(group, topic)).get(0) === 5, '커밋 5');
  for (const reason of ['DESERIALIZE', 'UNKNOWN_SCHEMA', 'MISSING_FIELD']) expect(await w.metric('stream_rejected_total', { topic, reason }), reason).toBe(1);
  const positions = w.warnings.filter((x) => x.o.kind === 'stream-rejected').map((x) => x.o);
  expect(positions.map((p) => p.offset)).toEqual(['1', '2', '3']);
  for (const p of positions) expect(Object.keys(p).sort()).toEqual(['kafkaTs', 'kind', 'offset', 'partition', 'reason', 'schemaId', 'topic', 'worker']);

  // 묶음 전체가 거절이면 레코드 없는 쓰기 한 번(건수 한도 5)
  await produce(topic, 0, range(5).map(() => Buffer.concat([Buffer.from([0, 0, 0, 0, 0]), Buffer.from(MARK)])));
  await until(() => sink.done.length === 2, '모두 거절인 묶음 쓰기');
  const allRejected = sink.done[1]!.batch;
  expect(allRejected.records).toEqual([]);
  expect(allRejected.rejected.map((r) => r.offset)).toEqual(range(5, 5));
  expect(sink.attempts.filter((a) => a.batch.dedupToken === allRejected.dedupToken)).toHaveLength(1);
  expect(allRejected.dedupToken).toBe('bat220.reject:0:5:9');
  await until(async () => (await kafka.groupOffsets(group, topic)).get(0) === 10, '커밋 10');
  await w.run.stop();
  expect(JSON.stringify(w.warnings)).not.toContain(MARK);
  expect(JSON.stringify(sink.done)).not.toContain(MARK);
}, 120_000);

test('OPS-150 ⑦ 처리 중에 둘째 소비자를 붙여 재조정해도 빠짐이 없고, 둘째가 파티션을 받아 이어 싣는다', async () => {
  const topic = 'bat220.rebalance';
  const group = 'bat220-rebalance';
  await kafka.createTopic(topic, 2);
  const slow = () => new Promise<void>((r) => setTimeout(r, 300));
  const a = new RecordingSink(slow);
  const b = new RecordingSink(slow);
  const A = startWorker({ topic, group, sink: a, maxRecords: 5, pod: 'pod-a' });
  await A.run.started;
  // 앞 30건은 시간을 두고 넣고(처리 중에 B가 붙게), 뒤 10건은 B가 파티션을 받은 것을 본 뒤에 넣는다(ST-T18과 같은 까닭: 느린 러너에서 A가 다 처리해 B가 받을 것이 없었다)
  const producing = (async () => {
    for (let i = 0; i < 30; i += 3) {
      for (const p of [0, 1]) await produce(topic, p, range(3, i).map((s) => valid(Number(s))));
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  await until(() => a.done.length >= 3, 'A가 묶음 셋 싣기');
  const B = startWorker({ topic, group, sink: b, maxRecords: 5, pod: 'pod-b' });
  await B.run.started;
  await producing;
  await until(async () => [...(await kafka.groupOwners(group, topic)).values()].includes(`${WORKER}-${ENV}-pod-b`), 'B가 파티션을 받음', 90_000);
  for (const p of [0, 1]) await produce(topic, p, range(10, 30).map((s) => valid(Number(s))));
  await until(async () => {
    const c = await kafka.groupOffsets(group, topic);
    return c.get(0) === 40 && c.get(1) === 40;
  }, '모두 커밋', 90_000).catch(async (e: Error) => {
    // 실패 때 어디서 멈췄는지 남긴다(커밋 위치·주인·두 싱크가 받은 오프셋·경고)
    const state = { commits: [...(await kafka.groupOffsets(group, topic))], owners: [...(await kafka.groupOwners(group, topic))], a: [a.offsets(0), a.offsets(1)], b: [b.offsets(0), b.offsets(1)], warnA: A.warnings.map((x) => x.msg), warnB: B.warnings.map((x) => x.msg) };
    throw new Error(`${e.message}: ${JSON.stringify(state)}`);
  });
  // RV220-4: A가 B에게 넘긴 파티션의 밀림 값은 A에서 지워지고(두 파드가 같은 파티션을 내지 않게) B가 낸다
  const movedToB = [...(await kafka.groupOwners(group, topic))].filter(([, c]) => c === `${WORKER}-${ENV}-pod-b`).map(([p]) => String(p));
  expect(movedToB.length).toBeGreaterThan(0);
  await until(async () => {
    for (const partition of movedToB) if ((await A.metric('stream_consumer_lag_records', { topic, partition })) !== undefined) return false;
    return true;
  }, 'A가 넘긴 파티션의 밀림 값 지움', 30_000);
  for (const partition of movedToB) await until(async () => (await B.metric('stream_consumer_lag_records', { topic, partition })) === 0, 'B의 밀림 0', 30_000);
  await Promise.all([A.run.stop(), B.run.stop()]);
  for (const p of [0, 1]) {
    const got = new Set([...a.offsets(p), ...b.offsets(p)]);
    expect([...got].sort((x, y) => Number(x) - Number(y)), `파티션 ${p}`).toEqual(range(40));
  }
  expect(b.done.length).toBeGreaterThan(0);
}, 180_000);

test('OPS-150 ⑦ 종료 때 처리 중 묶음이 기다림 한도 안에 끝나면 커밋하고, 한도를 넘기면 커밋하지 않아 다음 실행기가 그 묶음을 다시 받는다', async () => {
  // 한도 안: 쓰기 0.6초, 한도 3초
  const t1 = 'bat220.drain-ok';
  await kafka.createTopic(t1, 1);
  await produce(t1, 0, range(5).map((s) => valid(Number(s))));
  const s1 = new RecordingSink(() => new Promise((r) => setTimeout(r, 600)));
  const w1 = startWorker({ topic: t1, group: 'bat220-drain-ok', sink: s1, maxRecords: 5, maxWaitMs: 60_000, drainTimeoutMs: 3_000 });
  await w1.run.started;
  await until(() => s1.attempts.length === 1, '쓰기 시작');
  await w1.run.stop();
  expect(s1.done).toHaveLength(1);
  expect((await kafka.groupOffsets('bat220-drain-ok', t1)).get(0)).toBe(5);

  // 한도 넘김: 쓰기가 끝나지 않는다, 한도 1초
  const t2 = 'bat220.drain-late';
  await kafka.createTopic(t2, 1);
  await produce(t2, 0, range(5).map((s) => valid(Number(s))));
  const s2 = new RecordingSink(() => new Promise<void>((r) => hung.push(r)));
  const w2 = startWorker({ topic: t2, group: 'bat220-drain-late', sink: s2, maxRecords: 5, maxWaitMs: 60_000, drainTimeoutMs: 1_000 });
  await w2.run.started;
  await until(() => s2.attempts.length === 1, '쓰기 시작');
  const stopAt = performance.now();
  await w2.run.stop();
  expect(performance.now() - stopAt).toBeGreaterThanOrEqual(1_000 - 20);
  expect((await kafka.groupOffsets('bat220-drain-late', t2)).get(0)).toBeUndefined();
  expect(w2.warnings.some((x) => /한도를 넘어/.test(x.msg ?? ''))).toBe(true);

  const s3 = new RecordingSink();
  const w3 = startWorker({ topic: t2, group: 'bat220-drain-late', sink: s3, maxRecords: 5, maxWaitMs: 60_000, pod: 'pod-b' });
  await w3.run.started;
  await until(() => s3.done.length === 1, '다음 실행기가 같은 묶음을 받음');
  expect(s3.done[0]!.batch.dedupToken).toBe(s2.attempts[0]!.batch.dedupToken);
  await until(async () => (await kafka.groupOffsets('bat220-drain-late', t2)).get(0) === 5, '커밋 5');
  await w3.run.stop();
}, 180_000);

test('OPS-150 ⑦ 종료 중에 끝난 decode의 레코드는 버린 열린 묶음 뒤에 싣거나 커밋하지 않고, 다음 실행기가 버린 묶음부터 다시 받는다(RV220-2)', async () => {
  const topic = 'bat220.stop-race';
  const group = 'bat220-stop-race';
  await kafka.createTopic(topic, 1);
  await produce(topic, 0, range(6).map((s) => valid(Number(s))));
  // 첫 묶음(0~2) 쓰기를 붙잡아 종료가 그 쓰기를 기다리게 하고, 그동안 3·4는 열린 묶음, 5는 읽는 중에 둔다
  let openWrite!: () => void;
  const writeGate = new Promise<void>((r) => (openWrite = r));
  hung.push(openWrite);
  let openDecode!: () => void;
  const decodeGate = new Promise<void>((r) => (openDecode = r));
  hung.push(openDecode);
  let decoding5 = false;
  const base = readerFor(shared.url);
  const gated: AvroReader = {
    async decode(t, bytes) {
      const out = await base.decode(t, bytes);
      if (out.kind === 'record' && (out.value as Val).seq === 5) {
        decoding5 = true;
        await decodeGate;
      }
      return out;
    },
  };
  const sink = new RecordingSink(async (b) => {
    if (b.firstOffset === '0') await writeGate;
  });
  const w = startWorker({ topic, group, sink, reader: gated, maxRecords: 3, maxWaitMs: 200, drainTimeoutMs: 5_000 });
  await w.run.started;
  await until(() => decoding5 && sink.attempts.length === 1, '첫 묶음 쓰기 중·5 읽는 중');
  const stopping = w.run.stop();
  // fixed-wait: stop()이 열린 묶음(3·4)을 버리는 데까지 가게 한다(바깥에서 볼 신호가 없고, 버리기는 첫 틱 안에 끝난다) BAT-220 RV220-2
  await new Promise((r) => setTimeout(r, 50));
  openDecode();
  // fixed-wait: 종료 뒤에 끝난 5가 새 묶음으로 시간 한도(200ms)에 닫혀 쓰일 수 있을 만큼 둔다('쓰지 않음'을 보이는 시험) BAT-220 RV220-2
  await new Promise((r) => setTimeout(r, 600));
  openWrite();
  await stopping;
  expect(sink.done.map((d) => d.batch.records.map((r) => r.offset))).toEqual([['0', '1', '2']]);
  expect((await kafka.groupOffsets(group, topic)).get(0)).toBe(3);

  const next = new RecordingSink();
  const w2 = startWorker({ topic, group, sink: next, maxRecords: 3, pod: 'pod-b' });
  await w2.run.started;
  await until(() => next.offsets(0).length >= 3, '다음 실행기가 3~5 싣기');
  await until(async () => (await kafka.groupOffsets(group, topic)).get(0) === 6, '커밋 6');
  await w2.run.stop();
  expect(next.offsets(0)).toEqual(['3', '4', '5']);
}, 120_000);
