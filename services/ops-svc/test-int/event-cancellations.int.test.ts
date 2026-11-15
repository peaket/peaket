// ops-svc 회차 취소 요청·판정·2인 확정 실제 PostgreSQL 18 통합 시험(BAT-425 GAT-130 잔여, R-592).
// 0011 적용·재적용, HTTP 경로, 확정 때 purchase-svc 일괄 환불 시작기 호출, 판정자≠확정자를 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import type { EventCancellationReauth } from '../src/modules/event-cancellations/index.js';
import type { EventRefundStarter } from '../src/modules/event-cancellations/domain/ports.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-15T08:00:00.000Z');
const identity = new FakeIdentity();
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
const calls: string[] = [];

const reauth: EventCancellationReauth = {
  verify: async (token, o) => {
    if (token === undefined || !token.startsWith('APPROVAL:')) throw new Error('reauth');
    return { accountId: token.slice('APPROVAL:'.length), factors: ['password'] };
  },
};
const refunds: EventRefundStarter = {
  start: async (i) => {
    calls.push(`start:${i.requestId}:${i.fault}`);
    return { jobId: i.requestId, state: 'RUNNING' };
  },
  pause: async (i) => {
    calls.push(`pause:${i.requestId}:${i.pg ?? 'ALL'}`);
    return { jobId: i.requestId, state: 'PAUSED' };
  },
  resume: async (i) => {
    calls.push(`resume:${i.requestId}:${i.pg ?? 'ALL'}`);
    return { jobId: i.requestId, state: 'RUNNING' };
  },
};

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-event-cancellations-it' });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  svc = await createService({
    name: 'ops-svc-event-cancellations',
    module: AppModule.register({ database: db, nowMs: NOW, eventCancellations: { refunds, reauth } }),
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
const get = (url: string, headers: Record<string, string>) => svc.http.inject({ method: 'GET', url, headers });

describe('회차 취소 요청 실제 DB·HTTP [BAT-425]', () => {
  test('0011이 적용·재적용되고 요청→판정→판정자 아닌 확정이 일괄 환불을 시작한다', async () => {
    const applied = await admin.query("select name from ops_migration where name = '0011_event_cancellation_request.sql'");
    expect(applied.rowCount).toBe(1);
    const commander = identity.ops('commander');
    const operator = identity.ops('operator');
    const eventId = randomUUID();
    const created = await post('/v1/ops/event-cancellations', commander, { eventId, reason: '공연 취소' });
    expect(created.statusCode).toBe(201);
    const r = JSON.parse(created.payload) as { requestId: string; status: string };
    expect(r.status).toBe('REQUESTED');

    const list = await get(`/v1/ops/event-cancellations?eventId=${eventId}`, commander);
    expect(JSON.parse(list.payload).items).toHaveLength(1);

    expect((await post(`/v1/ops/event-cancellations/${r.requestId}/judgement`, commander, { fault: 'ORGANIZER', reason: '주최 측', fanNoticeReason: '공연이 취소되었습니다' })).statusCode).toBe(200);
    expect((await post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, commander, {})).statusCode).toBe(403);
    const approved = await post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, { ...operator, 'x-reauth-token': `APPROVAL:${operator['x-user-id']}` }, {});
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.payload)).toMatchObject({ requestId: r.requestId, status: 'RUNNING' });
    expect(calls).toEqual([`start:${r.requestId}:ORGANIZER`]);

    const row = await admin.query('select status, judged_by, approved_by, refund_job_state from event_cancellation_request where request_id = $1', [r.requestId]);
    expect(row.rows[0]).toMatchObject({ status: 'RUNNING', refund_job_state: 'RUNNING' });
    expect(row.rows[0].judged_by).not.toBe(row.rows[0].approved_by);
    const audited = await admin.query('select record_type from audit_chain where record_id = $1 order by seq', [r.requestId]);
    expect(audited.rows.map((x: { record_type: string }) => x.record_type)).toEqual(['EVENT_CANCELLATION_REQUESTED', 'EVENT_CANCELLATION_JUDGED', 'EVENT_CANCELLATION_APPROVED', 'EVENT_CANCELLATION_STARTED']);
  });

  test('판정 전 확정은 409이고, 정지·재개는 일괄 환불 실행기에 잇는다', async () => {
    const commander = identity.ops('commander');
    const operator = identity.ops('operator');
    const eventId = randomUUID();
    const created = await post('/v1/ops/event-cancellations', commander, { eventId, reason: '공연 취소' });
    const r = JSON.parse(created.payload) as { requestId: string };
    expect((await post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, operator, {})).statusCode).toBe(409);
    await post(`/v1/ops/event-cancellations/${r.requestId}/judgement`, commander, { fault: 'CONTENT_CHANGE', reason: '내용 변경', fanNoticeReason: '공연 내용이 바뀌었습니다' });
    await post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, { ...operator, 'x-reauth-token': `APPROVAL:${operator['x-user-id']}` }, {});
    expect((await post(`/v1/ops/event-cancellations/${r.requestId}/pauses`, commander, { pg: 'TOSS', reason: '수동' })).statusCode).toBe(200);
    expect((await post(`/v1/ops/event-cancellations/${r.requestId}/resumptions`, commander, { pg: 'TOSS', reason: '재개' })).statusCode).toBe(200);
    expect(calls).toContain(`pause:${r.requestId}:TOSS`);
    expect(calls).toContain(`resume:${r.requestId}:TOSS`);
  });
});
