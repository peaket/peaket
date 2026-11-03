// Outbox 릴레이 프로세스 두 복제의 실제 PostgreSQL 시험(openspec 변경 add-local-cluster-and-relay-deployment, ADR-0116, V-T28 로컬 부분).
// Lease는 메모리 API(겨루기는 resourceVersion), 보내기는 받은 것을 적는 포트다. 실제 쿠버네티스 Lease와 Kafka는 tools/local/e2e(kind)가 본다.
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createDatabase,
  ensureOutboxPartitions,
  startOutboxRelayProcess,
  systemClock,
  writeOutbox,
  type Database,
  type LeaseApi,
  type LeaseRecord,
  type LeaseSpec,
  type OutboxPublisher,
  type OutboxRecord,
} from '../src/index.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const MIGRATION = readFileSync(new URL('../template/migrations/0002_outbox.sql', import.meta.url), 'utf8');

let pgc: PostgresContainer;
let db: Database;

beforeAll(async () => {
  pgc = await startPostgres();
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  await admin.query(MIGRATION);
  await admin.end();
  db = createDatabase({ url: pgc.url, applicationName: 'relay-process-int' });
  await ensureOutboxPartitions(db, systemClock);
}, 120_000);

afterAll(async () => {
  await db?.close();
  pgc?.stop();
});

function memoryLease(): LeaseApi {
  let rec: LeaseRecord | undefined;
  let version = 0;
  return {
    async get() {
      return rec ? { ...rec } : undefined;
    },
    async create(spec: LeaseSpec) {
      if (rec) return 'conflict';
      rec = { ...spec, resourceVersion: String(++version) };
      return { ...rec };
    },
    async update(spec: LeaseSpec, rv: string) {
      if (!rec || rec.resourceVersion !== rv) return 'conflict';
      rec = { ...spec, resourceVersion: String(++version) };
      return { ...rec };
    },
  };
}

const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

describe('릴레이 프로세스 두 복제(V-T28 로컬 부분)', () => {
  test('FND110_리더만보내고_리더를끝내면_다른복제가이어보내며_빠짐과순서뒤집힘이없다', async () => {
    const lease = memoryLease();
    const sent: { by: string; r: OutboxRecord }[] = [];
    const publisherOf = (by: string): OutboxPublisher => ({
      async publish(records) {
        for (const r of records) sent.push({ by, r });
      },
    });
    const start = (pod: string) =>
      startOutboxRelayProcess({
        service: 'example-svc',
        env: {
          PEAKET_ENV: 'local',
          PEAKET_POD: pod,
          PEAKET_MANAGEMENT_PORT: '0',
          PEAKET_OUTBOX_DATABASE_URL: pgc.url,
          PEAKET_MAINTENANCE_DATABASE_URL: pgc.url,
          PEAKET_KAFKA_BROKERS: 'unused:9092',
        },
        database: db,
        maintenanceDatabase: db,
        publisher: publisherOf(pod),
        leaseApi: lease,
        maintenanceTasks: [],
        lease: { leaseDurationMs: 600, renewDeadlineMs: 400, retryPeriodMs: 50 },
        logDestination: quiet(),
      });
    const a = await start('relay-a');
    const b = await start('relay-b');
    const write = async (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        // 키 셋에 번호를 돌려 같은 키의 사건이 여러 번 나오게 한다
        await db.transaction((tx) => writeOutbox(tx, systemClock, [{ topic: 'test.relay', key: `k-${i % 3}`, payload: Buffer.from(String(i)) }]));
      }
    };
    const unsent = async () => Number(((await db.db.execute(sql`select count(*)::int as n from outbox where sent_at is null`)).rows[0] as { n: number }).n);
    const until = async (cond: () => Promise<boolean> | boolean, ms = 10_000) => {
      const end = Date.now() + ms;
      while (!(await cond())) {
        if (Date.now() > end) throw new Error('기다림 한도');
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await until(() => a.isLeader() || b.isLeader());
    const [first, second] = a.isLeader() ? [a, b] : [b, a];
    await write(0, 60);
    await until(async () => (await unsent()) === 0);
    await first.stop();
    await write(60, 120);
    await until(async () => (await unsent()) === 0);
    await second.stop();

    const firstPod = first.config.pod;
    const secondPod = second.config.pod;
    // 리더만 보냈다: 끝내기 전에는 첫 리더, 끝낸 뒤에는 둘째만
    expect(new Set(sent.slice(0, 60).map((s) => s.by))).toEqual(new Set([firstPod]));
    expect(new Set(sent.slice(60).map((s) => s.by))).toEqual(new Set([secondPod]));
    // 빠짐 없음·중복 없음(멈춘 것이 아니라 끝낸 것이라 다시 보낼 것이 없다)·키마다 쓴 순서
    const nums = sent.map((s) => Number(s.r.payload.toString()));
    expect([...nums].sort((x, y) => x - y)).toEqual(Array.from({ length: 120 }, (_, i) => i));
    for (const k of ['k-0', 'k-1', 'k-2']) {
      const seq = sent.filter((s) => s.r.key === k).map((s) => Number(s.r.payload.toString()));
      expect(seq).toEqual([...seq].sort((x, y) => x - y));
    }
  }, 60_000);
});
