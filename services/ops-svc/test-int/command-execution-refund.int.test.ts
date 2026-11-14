// ops-svc 회차 취소 환불 수동 명령(BAT-425 GAT-130) 실제 PostgreSQL 통합 시험.
// EVENT_CANCEL은 gRPC Start, EVENT_REFUND_PAUSE·RESUME은 같은 작업의 멈춤·재개로 실행되고 명령 사건·감사를 남긴다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { HttpCommandExecutor } from '../src/adapters/http-command-executor.js';
import type { EventRefundStarter } from '../src/adapters/grpc-event-refunds.js';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-15T01:00:00.000Z');
const identity = new FakeIdentity();
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
const calls: Array<{ method: string; q: Record<string, unknown> }> = [];

const refunds: EventRefundStarter = {
  start: async (q) => {
    calls.push({ method: 'start', q: q as unknown as Record<string, unknown> });
    return { jobId: q.requestId, state: q.kind === 'POSTPONE' ? 'REFUND_WINDOW' : 'RUNNING' };
  },
  pause: async (q) => {
    calls.push({ method: 'pause', q: q as unknown as Record<string, unknown> });
    return { jobId: q.requestId, state: 'PAUSED' };
  },
  resume: async (q) => {
    calls.push({ method: 'resume', q: q as unknown as Record<string, unknown> });
    return { jobId: q.requestId, state: 'RUNNING' };
  },
  get: async (q) => {
    calls.push({ method: 'get', q: q as unknown as Record<string, unknown> });
    return { jobId: q.requestId, state: 'RUNNING' };
  },
};

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-refund-command-it' });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  const executor = new HttpCommandExecutor({ refunds });
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
  await svc?.close();
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

const post = (url: string, headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('BAT-425 회차 취소 환불 명령', () => {
  test('GAT130_EVENT_CANCEL_2인_승인은_gRPC_Start로_가고_SUCCEEDED다', async () => {
    const operator = identity.ops('operator');
    const commander = identity.ops('commander');
    const eventId = randomUUID();
    const created = await post('/v1/ops/commands', operator, { type: 'EVENT_CANCEL', reason: '회차 취소', params: { eventId, fault: 'ORGANIZER' } });
    expect(created.statusCode).toBe(201);
    const c = JSON.parse(created.payload) as { commandId: string; state: string };
    expect(c.state).toBe('PENDING_APPROVAL');
    const approved = await post(`/v1/ops/commands/${c.commandId}/approvals`, commander, {});
    expect(JSON.parse(approved.payload)).toMatchObject({ state: 'SUCCEEDED' });
    expect(calls[0]).toMatchObject({ method: 'start', q: { requestId: c.commandId, eventId, fault: 'ORGANIZER', kind: 'CANCEL' } });
    const events = await admin.query('select type from command_event where command_id = $1::uuid order by seq', [c.commandId]);
    expect(events.rows.map((r: { type: string }) => r.type)).toEqual(['CREATED', 'PENDING_APPROVAL', 'APPROVED', 'DISPATCHED', 'SUCCEEDED']);
  });

  test('GAT130_EVENT_REFUND_PAUSE와_RESUME은_같은_작업_ID로_바로_실행된다', async () => {
    const operator = identity.ops('operator');
    const requestId = randomUUID();
    const paused = await post('/v1/ops/commands', operator, { type: 'EVENT_REFUND_PAUSE', reason: '결제사 장애', params: { requestId, pg: 'TOSS' } });
    expect(JSON.parse(paused.payload)).toMatchObject({ state: 'SUCCEEDED' });
    expect(calls.at(-1)).toMatchObject({ method: 'pause', q: { requestId, pg: 'TOSS', reason: '결제사 장애' } });
    const resumed = await post('/v1/ops/commands', operator, { type: 'EVENT_REFUND_RESUME', reason: '정상 확인', params: { requestId, pg: 'TOSS' } });
    expect(JSON.parse(resumed.payload)).toMatchObject({ state: 'SUCCEEDED' });
    expect(calls.at(-1)).toMatchObject({ method: 'resume', q: { requestId, pg: 'TOSS', reason: '정상 확인' } });
  });

  test('GAT130_작업_ID가_없는_재개는_FAILED와_사유를_남긴다', async () => {
    const operator = identity.ops('operator');
    const r = await post('/v1/ops/commands', operator, { type: 'EVENT_REFUND_RESUME', reason: '재개', params: {} });
    expect(JSON.parse(r.payload)).toMatchObject({ state: 'FAILED', lastError: 'invalid-event-refund-params' });
  });
});
