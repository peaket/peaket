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
  await admin?.query('drop trigger if exists r614_fail_audit_trg on audit_chain').catch(() => undefined);
  await admin?.query('drop function if exists r614_fail_audit()').catch(() => undefined);
  await svc?.close();
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

const post = (url: string, headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (url: string, headers: Record<string, string>) => svc.http.inject({ method: 'GET', url, headers });
const failAudit = async (recordType: string): Promise<void> => {
  await admin.query(`create or replace function r614_fail_audit() returns trigger as $$
    begin
      if new.record_type = tg_argv[0] then raise exception 'injected audit failure'; end if;
      return new;
    end $$ language plpgsql`);
  await admin.query('drop trigger if exists r614_fail_audit_trg on audit_chain');
  await admin.query(`create trigger r614_fail_audit_trg before insert on audit_chain for each row execute function r614_fail_audit('${recordType}')`);
};
const clearAuditFailure = async (): Promise<void> => {
  await admin.query('drop trigger if exists r614_fail_audit_trg on audit_chain');
};

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

  test('OPSV01_감사_append가_실패하면_RUNNING_저장이_롤백되고_JUDGED로_남는다', async () => {
    const commander = identity.ops('commander');
    const operator = identity.ops('operator');
    const eventId = randomUUID();
    const created = await post('/v1/ops/event-cancellations', commander, { eventId, reason: '감사 실패 주입' });
    const r = JSON.parse(created.payload) as { requestId: string };
    await post(`/v1/ops/event-cancellations/${r.requestId}/judgement`, commander, { fault: 'ORGANIZER', reason: '주최 측', fanNoticeReason: '공연이 취소되었습니다' });
    await failAudit('EVENT_CANCELLATION_APPROVED');
    const failed = await post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, operator, {});
    expect(failed.statusCode).toBe(500);
    await clearAuditFailure();
    const row = await admin.query('select status, version, approved_by from event_cancellation_request where request_id = $1', [r.requestId]);
    expect(row.rows[0]).toMatchObject({ status: 'JUDGED', approved_by: null });
    expect(Number(row.rows[0].version)).toBe(2);
    const retried = await post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, operator, {});
    expect(retried.statusCode).toBe(200);
    expect(JSON.parse(retried.payload)).toMatchObject({ status: 'RUNNING' });
  });

  test('OPSV02_동시_확정은_version_조건으로_한_번만_성공한다', async () => {
    const commander = identity.ops('commander');
    const a = identity.ops('operator');
    const b = identity.ops('operator');
    const eventId = randomUUID();
    const created = await post('/v1/ops/event-cancellations', commander, { eventId, reason: '동시 확정' });
    const r = JSON.parse(created.payload) as { requestId: string };
    await post(`/v1/ops/event-cancellations/${r.requestId}/judgement`, commander, { fault: 'CONTENT_CHANGE', reason: '내용 변경', fanNoticeReason: '공연 내용이 바뀌었습니다' });
    const [x, y] = await Promise.all([
      post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, a, {}),
      post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, b, {}),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    const row = await admin.query('select status, version, approved_by from event_cancellation_request where request_id = $1', [r.requestId]);
    expect(row.rows[0]).toMatchObject({ status: 'RUNNING' });
    expect(Number(row.rows[0].version)).toBe(3);
    expect([a['x-user-id'], b['x-user-id']]).toContain(row.rows[0].approved_by);
  });

  test('OPSV04_정지·재개·반려_사유와_pg가_감사_payload에_남고_검증이_통과한다', async () => {
    const commander = identity.ops('commander');
    const operator = identity.ops('operator');
    const eventId = randomUUID();
    const created = await post('/v1/ops/event-cancellations', commander, { eventId, reason: '감사 payload' });
    const r = JSON.parse(created.payload) as { requestId: string };
    await post(`/v1/ops/event-cancellations/${r.requestId}/judgement`, commander, { fault: 'ORGANIZER', reason: '주최 측', fanNoticeReason: '공연이 취소되었습니다' });
    await post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, operator, {});
    await post(`/v1/ops/event-cancellations/${r.requestId}/pauses`, commander, { pg: 'TOSS', reason: '수동 정지' });
    await post(`/v1/ops/event-cancellations/${r.requestId}/resumptions`, commander, { pg: 'TOSS', reason: '수동 재개' });
    const paused = await admin.query("select record_json from audit_chain where record_type = 'EVENT_CANCELLATION_PAUSED' and record_id = $1", [r.requestId]);
    expect(paused.rows[0]!.record_json).toMatchObject({ payload: { status: 'PAUSED', pg: 'TOSS', reason: '수동 정지' } });
    const resumed = await admin.query("select record_json from audit_chain where record_type = 'EVENT_CANCELLATION_RESUMED' and record_id = $1", [r.requestId]);
    expect(resumed.rows[0]!.record_json).toMatchObject({ payload: { status: 'RUNNING', pg: 'TOSS', reason: '수동 재개' } });

    const rejectedEvent = randomUUID();
    const rejectedCreated = await post('/v1/ops/event-cancellations', commander, { eventId: rejectedEvent, reason: '반려 감사' });
    const rr = JSON.parse(rejectedCreated.payload) as { requestId: string };
    await post(`/v1/ops/event-cancellations/${rr.requestId}/judgement`, commander, { fault: 'FORCE_MAJEURE', reason: '불가항력', fanNoticeReason: '공연이 취소되었습니다' });
    await post(`/v1/ops/event-cancellations/${rr.requestId}/rejections`, operator, { reason: '증빙 부족' });
    const rejected = await admin.query("select record_json from audit_chain where record_type = 'EVENT_CANCELLATION_REJECTED' and record_id = $1", [rr.requestId]);
    expect(rejected.rows[0]!.record_json).toMatchObject({ payload: { status: 'REQUESTED', reason: '증빙 부족' } });

    const cp = await post('/v1/ops/audit-checkpoints', commander, { reason: '회차 취소 감사 검증' });
    expect(cp.statusCode).toBe(201);
    const checkpointId = (JSON.parse(cp.payload) as { checkpointId: string }).checkpointId;
    const verification = await get(`/v1/ops/audit-checkpoints/${checkpointId}/verification`, operator);
    expect(JSON.parse(verification.payload)).toMatchObject({ valid: true });
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
