// 서비스 뼈대의 Drizzle 어댑터와 마이그레이션 SQL이 실제 PostgreSQL에서 맞는지 본다(결정 1·9).
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { AppModule } from '../template/src/app.module.js';
import { createDatabase, createService, fakeClock, type Database } from '../src/index.js';
import { collector } from '../test/fixture.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let pgc: PostgresContainer;
let database: Database;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  pgc = await startPostgres();
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  await admin.query(readFileSync(new URL('../template/migrations/0000_example_note.sql', import.meta.url), 'utf8'));
  await admin.end();
  database = createDatabase({ url: pgc.url, applicationName: 'example-svc' });
  svc = await createService({ name: 'example-svc', module: AppModule.register({ database }), env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream });
}, 120_000);

afterAll(async () => {
  await svc?.close();
  await database?.close();
  pgc?.stop();
});

test('낮음008_뼈대의Drizzle어댑터가_마이그레이션한표에쓰고_계정범위로읽는다', async () => {
  const me = { 'x-user-id': 'acc-1', 'x-session-id': 's-1', 'x-user-aud': 'fan', 'content-type': 'application/json' };
  const created = await svc.http.inject({ method: 'POST', url: '/v1/example/notes', headers: me, payload: JSON.stringify({ title: '디비 메모' }) });
  expect(created.statusCode).toBe(201);
  const { id } = JSON.parse(created.payload) as { id: string };
  const read = await svc.http.inject({ method: 'GET', url: `/v1/example/notes/${id}`, headers: me });
  expect(JSON.parse(read.payload)).toEqual({ id, title: '디비 메모' });
  const other = await svc.http.inject({ method: 'GET', url: `/v1/example/notes/${id}`, headers: { ...me, 'x-user-id': 'acc-2', 'x-session-id': 's-2' } });
  expect(other.statusCode).toBe(404);
});
