// ops-svc 실제 PostgreSQL 18 통합 시험(BAT-425 GAT-120): EVENT_CANCEL 2인 승인·요청자≠승인자,
// 승인 뒤 purchase-svc 내부 HTTP 전달, DISPATCHED/FAILED와 감사 사건을 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabase, createExternalHttpClient, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { HttpCommandExecutor } from '../src/adapters/http-command-executor.js';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-14T08:00:00.000Z');
const identity = new FakeIdentity();
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
let server: Server;
let failDispatch = false;
const received: Array<{ url: string; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-event-cancel-it' });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      res.statusCode = failDispatch ? 503 : 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const executor = new HttpCommandExecutor({ purchase: createExternalHttpClient({ provider: 'purchase-svc', baseUrl: `http://127.0.0.1:${port}`, timeoutCapMs: 5_000 }) });
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db, executor, nowMs: NOW }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await svc?.close();
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

const post = (url: string, headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

const createEventCancel = async (operator: Record<string, string>, eventId: string) => {
  const r = await post('/v1/ops/commands', operator, { type: 'EVENT_CANCEL', reason: '회차 취소', params: { eventId, fault: 'ORGANIZER', fanNoticeReason: '공연 취소' } });
  expect(r.statusCode).toBe(201);
  return JSON.parse(r.payload) as { commandId: string; state: string };
};

describe('EVENT_CANCEL 실제 DB·내부 HTTP', () => {
  test('BAT425_2인_승인_뒤_purchase로_전달하고_SUCCEEDED_사건·감사를_남긴다', async () => {
    const operator = identity.ops('operator');
    const commander = identity.ops('commander');
    const eventId = randomUUID();
    const created = await createEventCancel(operator, eventId);
    expect(created.state).toBe('PENDING_APPROVAL');

    expect((await post(`/v1/ops/commands/${created.commandId}/approvals`, operator, {})).statusCode).toBe(403);
    const approved = await post(`/v1/ops/commands/${created.commandId}/approvals`, commander, {});
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.payload)).toMatchObject({ commandId: created.commandId, state: 'SUCCEEDED' });

    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/internal/v1/event-refunds');
    expect(received[0]!.body).toMatchObject({
      eventId,
      requestId: created.commandId,
      fault: 'ORGANIZER',
      ruledBy: operator['x-user-id'],
      confirmedBy: commander['x-user-id'],
      fanNoticeReason: '공연 취소',
    });

    const row = await admin.query("select state from ops_command where id = $1::uuid", [created.commandId]);
    expect(row.rows[0]).toEqual({ state: 'SUCCEEDED' });
    const events = await admin.query('select type from command_event where command_id = $1::uuid order by seq', [created.commandId]);
    expect(events.rows.map((r: { type: string }) => r.type)).toEqual(['CREATED', 'PENDING_APPROVAL', 'APPROVED', 'DISPATCHED', 'SUCCEEDED']);
    const audit = await admin.query('select record_type from audit_chain where record_id = $1::uuid order by seq', [created.commandId]);
    expect(audit.rows.map((r: { record_type: string }) => r.record_type)).toEqual(['COMMAND_CREATED', 'COMMAND_APPROVED', 'COMMAND_EXECUTION_STARTED', 'COMMAND_SUCCEEDED']);
  });

  test('BAT425_전달이_실패하면_FAILED_사건·감사를_남긴다', async () => {
    failDispatch = true;
    const operator = identity.ops('operator');
    const commander = identity.ops('commander');
    const created = await createEventCancel(operator, randomUUID());
    const rejected = await post(`/v1/ops/commands/${created.commandId}/approvals`, commander, {});
    expect(rejected.statusCode).toBe(200);
    expect(JSON.parse(rejected.payload)).toMatchObject({ commandId: created.commandId, state: 'FAILED' });
    const row = await admin.query("select state from ops_command where id = $1::uuid", [created.commandId]);
    expect(row.rows[0]).toEqual({ state: 'FAILED' });
    const events = await admin.query('select type from command_event where command_id = $1::uuid order by seq', [created.commandId]);
    expect(events.rows.map((r: { type: string }) => r.type)).toEqual(['CREATED', 'PENDING_APPROVAL', 'APPROVED', 'DISPATCHED', 'FAILED']);
    const audit = await admin.query('select record_type from audit_chain where record_id = $1::uuid order by seq', [created.commandId]);
    expect(audit.rows.map((r: { record_type: string }) => r.record_type)).toEqual(['COMMAND_CREATED', 'COMMAND_APPROVED', 'COMMAND_EXECUTION_STARTED', 'COMMAND_EXECUTION_FAILED']);
    failDispatch = false;
  });
});
