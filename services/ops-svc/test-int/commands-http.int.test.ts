// ops-svc 실제 PostgreSQL 18 위 HTTP 통합 시험(GAT-110 첫 몫, R-552): 역할 가드·접수·상세·2인 승인·거부.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-14T01:00:00.000Z');
const identity = new FakeIdentity();
let container: PostgresContainer | undefined;
let db: Database;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-http-it' });
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await svc?.close();
  await db?.close();
  container?.stop();
});

const post = (url: string, headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (url: string, headers: Record<string, string>) => svc.http.inject({ method: 'GET', url, headers });

describe('/v1/ops/commands 실제 DB HTTP', () => {
  test('GAT110_viewer는_목록만_보고_접수·상세·승인은_못_한다', async () => {
    const viewer = identity.ops('viewer');
    expect((await get('/v1/ops/commands', viewer)).statusCode).toBe(200);
    expect((await post('/v1/ops/commands', viewer, { type: 'LOG_LEVEL', reason: 'x' })).statusCode).toBe(403);
    const created = await post('/v1/ops/commands', identity.ops('operator'), { type: 'BOT_LEVEL', reason: '권한 확인' });
    const commandId = (JSON.parse(created.payload) as { commandId: string }).commandId;
    expect((await get(`/v1/ops/commands/${commandId}`, viewer)).statusCode).toBe(403);
    expect((await post(`/v1/ops/commands/${commandId}/approvals`, viewer, {})).statusCode).toBe(403);
  });

  test('GAT110_operator_접수와_commander_승인은_실제_DB에_남고_목록에는_params가_없다', async () => {
    const operator = identity.ops('operator');
    const created = await post('/v1/ops/commands', operator, { type: 'BOT_LEVEL', reason: '봇 급증', params: { level: 'AGGRESSIVE' } });
    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.payload) as { commandId: string; state: string; requestedBy: { adminAccountId: string; displayName: null; role: string } };
    expect(body).toMatchObject({ state: 'PENDING_APPROVAL', requestedBy: { adminAccountId: operator['x-user-id'], displayName: null, role: 'operator' } });

    const detail = await get(`/v1/ops/commands/${body.commandId}`, operator);
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.payload)).toMatchObject({ commandId: body.commandId, params: { level: 'AGGRESSIVE' } });
    const list = await get('/v1/ops/commands?type=BOT_LEVEL&limit=100', operator);
    const item = (JSON.parse(list.payload) as { items: Array<Record<string, unknown>> }).items.find((i) => i.commandId === body.commandId);
    expect(item).toBeTruthy();
    expect(item).not.toHaveProperty('params');

    expect((await post(`/v1/ops/commands/${body.commandId}/approvals`, operator, {})).statusCode).toBe(403);
    const commander = identity.ops('commander');
    const approved = await post(`/v1/ops/commands/${body.commandId}/approvals`, commander, {});
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.payload)).toMatchObject({ commandId: body.commandId, state: 'APPROVED', approvals: [commander['x-user-id']] });

    const row = await db.db.execute(sql`select state from ops_command where id = ${body.commandId}::uuid`);
    expect((row.rows[0] as { state: string }).state).toBe('APPROVED');
  });

  test('GAT110_거부와_모르는_명령_유형·빈_사유는_계약대로_응답한다', async () => {
    const operator = identity.ops('operator');
    const created = await post('/v1/ops/commands', operator, { type: 'BLOCK_ASN_IP', reason: '대역 차단', params: { asn: 1234 } });
    const commandId = (JSON.parse(created.payload) as { commandId: string }).commandId;
    const commander = identity.ops('commander');
    const rejected = await post(`/v1/ops/commands/${commandId}/rejections`, commander, { reason: '근거 부족' });
    expect(rejected.statusCode).toBe(200);
    expect(JSON.parse(rejected.payload)).toMatchObject({ commandId, state: 'REJECTED' });

    expect((await post('/v1/ops/commands', operator, { type: 'NOPE', reason: 'x' })).statusCode).toBe(400);
    expect((await post('/v1/ops/commands', operator, { type: 'LOG_LEVEL', reason: '' })).statusCode).toBe(400);
    expect((await get(`/v1/ops/commands/${randomUUID()}`, operator)).statusCode).toBe(404);
  });
});
