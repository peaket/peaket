// ST-T18 키 단위 동시 처리 전체(docs/streaming.md ST-T18, ADR-0142, openspec 변경 add-foundation-poc, BUILD_ORDER FND-120).
// 실제 Kafka(컨테이너 한 대)와 PostgreSQL로 ① 처리 중 소비자 추가(재조정) ② 처리 중인 소비자 강제 종료 ③ 일시 실패로 멈춘 파티션을
// 넘긴 뒤 같은 소비자가 다시 받기 ④ 넘기기 기다림 한도(30초) 뒤 버린 파티션을 새 주인이 받기를 본다.
// 처리기는 주문 Saga처럼 자기 트랜잭션에서 eventKey로 다시 받은 사건을 거른다(st18-handler.mjs).
import { execSync, fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDatabase, drizzleHeldEventStore, systemClock, type Database } from '../src/index.js';
import { createKafkaProducer, runKeyedConsumer, type KafkaProducer } from '../src/stream-worker.js';
import { startKafka, type KafkaContainer } from './containers.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
// @ts-expect-error 시험 도우미(.mjs, 자식 프로세스와 같이 쓴다)
import { APPLIED_DDL, makeHandler } from './st18-handler.mjs';

let kafka: KafkaContainer;
let pgc: PostgresContainer;
let database: Database;
let pool: pg.Pool;
let producer: KafkaProducer;
const children: ChildProcess[] = [];

const PLATFORM = fileURLToPath(new URL('..', import.meta.url));
const migration = (f: string) => readFileSync(new URL(`../template/migrations/${f}`, import.meta.url), 'utf8');
const until = async (cond: () => boolean | Promise<boolean>, ms = 60_000, what = '조건') => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`기다린 ${what}이 오지 않았다`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const count = async (run: string, where = '', args: unknown[] = []) =>
  Number((await pool.query(`select count(*)::int as n from st18_applied where run = $1 ${where}`, [run, ...args])).rows[0].n);

beforeAll(async () => {
  // 강제 종료 시험의 자식 프로세스는 빌드한 플랫폼을 쓴다
  // 패키지 관리자 없이 컴파일러만 부른다(tsconfig.build.json, 'pnpm run build'와 같다)
  execSync('npx --no-install tsc -p tsconfig.build.json', { cwd: PLATFORM, stdio: 'ignore' });
  [kafka, pgc] = await Promise.all([startKafka(), startPostgres()]);
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  await admin.query(migration('0003_held_event_and_stat_snapshot.sql'));
  await admin.query(APPLIED_DDL);
  await admin.end();
  database = createDatabase({ url: pgc.url, applicationName: 'st18-it' });
  pool = new pg.Pool({ connectionString: pgc.url, max: 16 });
  producer = createKafkaProducer({ brokers: kafka.brokers, clientId: 'st18-producer', kind: 'default' });
  await producer.connect();
}, 300_000);

afterAll(async () => {
  for (const c of children) c.kill('SIGKILL');
  await producer?.disconnect().catch(() => {});
  await pool?.end();
  await database?.close();
  kafka?.stop();
  pgc?.stop();
});

interface Ev {
  order: string;
  seq: number;
  eventKey: string;
  partition: number;
}

/** 파티션마다 주문 orders개 × 사건 5개. 주문을 섞되 같은 주문의 사건은 순서대로, 몇은 잇달아 넣는다(한 회차 = 한 파티션) */
function plan(run: string, partitions: number, orders: number, seqs = 5): Ev[][] {
  return Array.from({ length: partitions }, (_, p) => {
    const next = new Map(Array.from({ length: orders }, (_, i) => [`${run}-p${p}-o${i}`, 1]));
    const out: Ev[] = [];
    while (next.size > 0) {
      const keys = [...next.keys()];
      const order = keys[Math.floor(Math.random() * keys.length)]!;
      const burst = Math.random() < 0.2 ? 3 : 1;
      for (let b = 0; b < burst && next.has(order); b += 1) {
        const seq = next.get(order)!;
        out.push({ order, seq, eventKey: `${order}-${seq}`, partition: p });
        if (seq === seqs) next.delete(order);
        else next.set(order, seq + 1);
      }
    }
    return out;
  });
}

/** 파티션마다 chunk개씩 everyMs마다 보낸다(처리 중에 소비자를 바꾸려고 시간을 두고 넣는다) */
async function produceOver(topic: string, perPartition: Ev[][], chunk = 20, everyMs = 100): Promise<void> {
  const cursors = perPartition.map(() => 0);
  while (cursors.some((c, p) => c < perPartition[p]!.length)) {
    const messages = perPartition.flatMap((evs, p) => {
      const part = evs.slice(cursors[p], cursors[p]! + chunk);
      cursors[p]! += part.length;
      return part.map((e) => ({ partition: p, key: `E${p}`, value: Buffer.from(JSON.stringify(e)) }));
    });
    if (messages.length) await producer.send({ topic, messages });
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

function consumer(run: string, member: string, topic: string, group: string, extra: Record<string, unknown> = {}, warnings: string[] = []) {
  const handler = makeHandler({ pool, run, member, delayMs: 30, ...extra });
  const c = runKeyedConsumer({
    brokers: kafka.brokers,
    clientId: `st18-${member}`,
    service: 'st18',
    groupId: group,
    topics: [topic],
    held: drizzleHeldEventStore(database, systemClock),
    handler,
    logger: { warn: (_o: object, msg?: string) => void warnings.push(String(msg)) },
  });
  return { c, stats: handler.stats as { maxPerPartition: number; duplicates: number; applied: number } };
}

/** 같은 주문의 사건이 넣은 순서대로 반영됐는지(반영 순 id로) */
async function inversions(run: string): Promise<number> {
  const rows = (await pool.query('select order_id, array_agg(seq order by id) as seqs from st18_applied where run = $1 group by order_id', [run])).rows as { seqs: number[] }[];
  return rows.filter((r) => r.seqs.some((s, i) => s !== i + 1)).length;
}

/**
 * 커밋 위치 C마다 그 파티션의 0..C-1이 모두 반영됐는지 본다(커밋은 '그 앞의 사건이 모두 끝난 위치' 이하).
 * 커밋 위치는 브로커 쪽 도구로 읽는다(containers.ts groupOffsets의 주석)
 */
function commitSampler(run: string, topic: string, group: string) {
  const bad: string[] = [];
  let samples = 0;
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      for (const [partition, c] of await kafka.groupOffsets(group, topic)) {
        if (c <= 0) continue;
        samples += 1;
        const done = await count(run, 'and part = $2 and kafka_offset < $3', [partition, c]);
        if (done !== c) bad.push(`p${partition}: 커밋 ${c}, 반영 ${done}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  return {
    async finish() {
      stop = true;
      await loop;
      return { samples, bad };
    },
  };
}

test('ST_T18_처리중에소비자를더띄워재조정해도_같은주문은순서대로_빠짐0_두번반영0_커밋은끝난위치이하_파티션당동시키는32이하', async () => {
  const run = 'add';
  const topic = 'st18.add';
  await kafka.createTopic(topic, 4);
  const evs = plan(run, 4, 200);
  const total = evs.flat().length;
  // 주문 열에 하나꼴로 세 번째 사건이 2초 걸린다(그 주문의 줄만 막힌다)
  const slow = { slow: (e: Ev) => e.seq === 3 && e.order.endsWith('7'), slowMs: 2_000 };
  const A = consumer(run, 'A', topic, 'st18-add', slow);
  await A.c.started;
  const sampler = commitSampler(run, topic, 'st18-add');
  const producing = produceOver(topic, evs);
  await until(async () => (await count(run)) >= total * 0.2, 60_000, '20% 반영');
  const B = consumer(run, 'B', topic, 'st18-add', slow);
  await B.c.started;
  await producing;
  await until(async () => (await count(run)) === total, 120_000, '전부 반영');
  const { samples, bad } = await sampler.finish();
  await Promise.all([A.c.stop(), B.c.stop()]);
  expect(await count(run, 'and member = $2', ['B'])).toBeGreaterThan(0); // 재조정으로 B가 받았다
  expect(await count(run)).toBe(total); // 빠짐 0, 두 번 반영 0(eventKey 하나에 한 행)
  expect(await inversions(run)).toBe(0);
  expect(samples).toBeGreaterThan(4);
  expect(bad).toEqual([]);
  expect(Math.max(A.stats.maxPerPartition, B.stats.maxPerPartition)).toBeLessThanOrEqual(32);
}, 240_000);

test('ST_T18_처리중인소비자프로세스를강제로죽여도_다른소비자가이어받아_빠짐0_두번반영0_순서뒤집힘0', async () => {
  const run = 'kill';
  const topic = 'st18.kill';
  await kafka.createTopic(topic, 2);
  const evs = plan(run, 2, 400);
  const total = evs.flat().length;
  // 시간을 두고 넣어(약 13초) 죽일 때 생산·처리·커밋이 함께 진행 중이게 한다(코드 리뷰 2026-11-01)
  const producing = produceOver(topic, evs, 15, 100);
  const child = fork(fileURLToPath(new URL('./st18-child.mjs', import.meta.url)), [kafka.brokers.join(','), pgc.url, 'st18-kill', topic, 'A', run], { stdio: 'ignore' });
  children.push(child);
  let firstApplied = 0;
  child.on('message', (m) => {
    if (typeof m === 'object' && m && (m as { applied: number }).applied > 0 && firstApplied === 0) firstApplied = Date.now();
  });
  await new Promise<void>((resolve, reject) => {
    child.on('message', (m) => m === 'started' && resolve());
    child.once('exit', (code) => reject(new Error(`자식 소비자가 끝났다(${code})`)));
  });
  // 커밋이 몇 번 돈 뒤(1초 주기) 죽인다. 커밋 위치는 죽인 뒤 확인한다(브로커 도구는 몇 초 걸려 죽이기 전에 부르면 생산이 끝날 수 있다)
  // 기준은 자식이 처음 반영한 시각이다(자식의 1초 커밋 주기는 시작한 뒤부터 돈다, 코드 리뷰 2026-11-01)
  await until(async () => firstApplied > 0 && Date.now() - firstApplied >= 2_500 && (await count(run)) >= total * 0.2, 60_000, '처음 반영 뒤 2.5초와 20% 반영');
  child.kill('SIGKILL'); // 그룹을 떠나지 않고 끊긴다: 세션 45초가 지나야 넘어간다
  const killedAt = await count(run);
  const committedAtKill = await kafka.groupOffsets('st18-kill', topic);
  await producing;
  const B = consumer(run, 'B', topic, 'st18-kill');
  await B.c.started;
  await until(async () => (await count(run)) === total, 150_000, '전부 반영');
  await B.c.stop();
  expect(killedAt).toBeLessThan(total);
  expect([...committedAtKill.values()].some((c) => c > 0)).toBe(true);
  expect(await count(run)).toBe(total);
  expect(await count(run, 'and member = $2', ['B'])).toBeGreaterThan(0);
  expect(await inversions(run)).toBe(0);
  // 죽기 전에 반영했지만 커밋하지 못한 사건은 다시 오고 eventKey로 걸러진다. 처음부터 다시 읽었다면 걸러진 수가 죽기 전 반영 수만큼이다
  expect(B.stats.duplicates).toBeGreaterThan(0);
  expect(B.stats.duplicates).toBeLessThan(killedAt);
}, 240_000);

test('ST_T18_일시실패로멈춘파티션을넘긴뒤_같은소비자가다시받으면_멈춤이풀려이어받는다', async () => {
  const run = 'pause';
  const topic = 'st18.pause';
  await kafka.createTopic(topic, 2);
  const first = plan(run, 2, 20);
  await produceOver(topic, first, 1000, 0);
  const failing = { on: true };
  const warnings: string[] = [];
  const A = consumer(run, 'A', topic, 'st18-pause', { transient: () => failing.on }, warnings);
  await A.c.started;
  await new Promise((r) => setTimeout(r, 3_000)); // 두 파티션 모두 일시 실패로 멈춘다
  expect(A.stats.applied).toBe(0);
  const B = consumer(run, 'B', topic, 'st18-pause');
  await B.c.started;
  // 한 파티션이 B로 넘어간다(A는 넘기기 기다림 한도 뒤 버리고 끝난 위치까지만 커밋한다)
  await until(async () => (await count(run, 'and member = $2', ['B'])) === 100, 120_000, 'B가 넘겨받은 파티션 반영');
  const moved = Number((await pool.query('select distinct part from st18_applied where run = $1 and member = $2', [run, 'B'])).rows[0].part);
  await B.c.stop(); // 그 파티션이 A로 돌아온다
  // 돌아온 파티션에 새 사건을 넣고 일시 실패를 끝낸다. 돌아온 파티션이 멈춘 채면 이 사건은 오지 않는다
  const more = plan(`${run}-more`, 2, 10).map((evs, p) => (p === moved ? evs : []));
  failing.on = false;
  await produceOver(topic, more, 1000, 0);
  await until(async () => (await count(run)) === 250, 120_000, '돌아온 파티션과 A에 남은 파티션 반영');
  await A.c.stop();
  expect(await count(run, 'and part = $2 and member = $3', [moved, 'A'])).toBe(50);
  expect(await inversions(run)).toBe(0);
}, 300_000);

test('ST_T18_넘기기기다림30초한도뒤_버린파티션의사건을_새주인이빠짐없이받는다', async () => {
  const run = 'drain';
  const topic = 'st18.drain';
  await kafka.createTopic(topic, 2);
  const evs = plan(run, 2, 30);
  const total = evs.flat().length;
  await produceOver(topic, evs, 1000, 0);
  // A는 파티션마다 처음 받은 사건에서 멈춘다(저장소가 멈춘 것처럼). 놓아 줄 때까지 끝나지 않는다
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const hungFirst = new Set<number>();
  const warnings: string[] = [];
  const A = consumer(
    run,
    'A',
    topic,
    'st18-drain',
    {
      hang: (m: { partition: number }) => {
        if (hungFirst.has(m.partition)) return undefined;
        hungFirst.add(m.partition);
        return gate;
      },
    },
    warnings,
  );
  await A.c.started;
  await until(() => hungFirst.size === 2, 30_000, 'A가 두 파티션에서 멈춤');
  const B = consumer(run, 'B', topic, 'st18-drain');
  const t0 = Date.now();
  await B.c.started;
  await until(() => warnings.some((w) => w.includes('넘기기 기다림이 한도를 넘어')), 90_000, '넘기기 기다림 한도');
  expect(Date.now() - t0).toBeGreaterThanOrEqual(25_000);
  // A는 멈춘 주문 하나의 줄만 막혀 그 파티션의 다른 주문은 끝냈다. 커밋 위치는 멈춘 사건 앞에 머물러, B는 거기서부터 다시 받고
  // 이미 반영한 사건은 eventKey로 거른다. 그래서 B가 새로 반영하는 것은 A가 멈춰 있던 주문의 사건 5개다
  await until(async () => (await count(run, 'and member = $2', ['B'])) >= 5, 90_000, 'B가 넘겨받은 파티션 반영');
  const movedPart = Number((await pool.query('select distinct part from st18_applied where run = $1 and member = $2', [run, 'B'])).rows[0].part);
  await until(async () => (await count(run, 'and part = $2', [movedPart])) === 150, 30_000, '넘겨받은 파티션 전부');
  expect(await count(run, 'and part = $2 and member = $3', [movedPart, 'B'])).toBe(5);
  // 버린 파티션에서 A가 멈춰 있던 첫 사건(오프셋 0)을 B가 반영했다(빠짐 0)
  expect(await count(run, 'and part = $2 and kafka_offset = 0 and member = $3', [movedPart, 'B'])).toBe(1);
  release(); // A의 다른 파티션도 끝낸다. 버린 파티션에서 늦게 끝난 A의 처리는 eventKey로 걸러진다
  await until(async () => (await count(run)) === total, 90_000, '전부 반영');
  await Promise.all([A.c.stop(), B.c.stop()]);
  expect(await count(run)).toBe(total);
  expect(await inversions(run)).toBe(0);
}, 300_000);
