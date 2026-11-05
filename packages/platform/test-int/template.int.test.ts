// 서비스 뼈대의 Drizzle 어댑터와 마이그레이션 SQL이 실제 PostgreSQL에서 맞는지 본다(결정 1·9).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { AppModule } from '../template/src/app.module.js';
import { sql } from 'drizzle-orm';
import { createDatabase, createService, ensureOutboxPartitions, fakeClock, type Database } from '../src/index.js';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { heldEvent, statSnapshot } from '../template/src/modules/example/adapters/db/schema.js';
import { collector } from '../test/fixture.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let pgc: PostgresContainer;
let database: Database;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  pgc = await startPostgres();
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  for (const f of ['0000_example_note.sql', '0001_idempotency_record.sql', '0002_outbox.sql', '0003_held_event_and_stat_snapshot.sql']) {
    await admin.query(readFileSync(new URL(`../template/migrations/${f}`, import.meta.url), 'utf8'));
  }
  await admin.end();
  database = createDatabase({ url: pgc.url, applicationName: 'example-svc' });
  const clock = fakeClock();
  // 첫 파티션도 정비 함수가 만든다(마이그레이션 직후, add-idempotency-and-outbox 결정 8)
  await ensureOutboxPartitions(database, clock);
  svc = await createService({ name: 'example-svc', module: AppModule.register({ database }), env: { PEAKET_ENV: 'ci' }, clock, logDestination: collector().stream });
}, 120_000);

afterAll(async () => {
  await svc?.close();
  await database?.close();
  pgc?.stop();
});

test('낮음008_뼈대의Drizzle어댑터가_마이그레이션한표에쓰고_계정범위로읽는다', async () => {
  const me = { 'x-user-id': 'acc-1', 'x-session-id': 's-1', 'x-user-aud': 'fan', 'content-type': 'application/json' };
  const created = await svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: { ...me, 'idempotency-key': randomUUID() }, payload: JSON.stringify({ title: '디비 메모' }) });
  expect(created.statusCode).toBe(201);
  const { id } = JSON.parse(created.payload) as { id: string };
  const read = await svc.http.inject({ method: 'GET', url: `/v1/example/notes/${id}`, headers: me });
  expect(JSON.parse(read.payload)).toEqual({ id, title: '디비 메모' });
  const other = await svc.http.inject({ method: 'GET', url: `/v1/example/notes/${id}`, headers: { ...me, 'x-user-id': 'acc-2', 'x-session-id': 's-2' } });
  expect(other.statusCode).toBe(404);
});

test('FND080_뼈대의쓰기는_멱등기록과메모와Outbox를한트랜잭션에쓰고_다시보내면같은메모다 [ASVS v5.0.0-2.3.4]', async () => {
  const me = { 'x-user-id': 'acc-7', 'x-session-id': 's-7', 'x-user-aud': 'fan', 'content-type': 'application/json', 'idempotency-key': randomUUID() };
  const body = JSON.stringify({ title: '한 번만' });
  const [a, b] = await Promise.all([
    svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: me, payload: body }),
    svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: me, payload: body }),
  ]);
  expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
  const id = (JSON.parse(a.payload) as { id: string }).id;
  expect((JSON.parse(b.payload) as { id: string }).id).toBe(id);
  const count = async (q: ReturnType<typeof sql>) => ((await database.db.execute(q)).rows[0] as { n: number }).n;
  expect(await count(sql`select count(*)::int as n from example_note where owner_account_id = 'acc-7'`)).toBe(1);
  expect(await count(sql`select count(*)::int as n from outbox where topic = 'example.notes' and msg_key = ${id}`)).toBe(1);
  expect(await count(sql`select count(*)::int as n from idempotency_record where account_ref = 'acc-7' and result_ref = ${id}`)).toBe(1);
  const other = await svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: me, payload: JSON.stringify({ title: '다른 본문' }) });
  expect(other.statusCode).toBe(422);
});

test('ADR0142_ADR0086_뼈대마이그레이션0003의보류표와통계스냅샷표가_플랫폼표정의와같은칸과인덱스다', async () => {
  for (const table of [heldEvent, statSnapshot]) {
    const cfg = getTableConfig(table);
    const cols = (await database.db.execute(sql`select column_name as c, data_type as t, is_nullable as n from information_schema.columns where table_name = ${cfg.name} order by ordinal_position`)).rows as { c: string; t: string; n: string }[];
    expect(cols.map((r) => r.c)).toEqual(cfg.columns.map((c) => c.name));
    for (const c of cfg.columns) expect(cols.find((r) => r.c === c.name)!.n, `${cfg.name}.${c.name}`).toBe(c.notNull ? 'NO' : 'YES');
    const idx = (await database.db.execute(sql`select indexname as i from pg_indexes where tablename = ${cfg.name}`)).rows.map((r) => (r as { i: string }).i);
    for (const i of cfg.indexes) expect(idx).toContain(i.config.name);
  }
});
