// ops-svc 회차 취소 요청·판정·2인 확정 실제 PostgreSQL 18 통합 시험(BAT-425 GAT-130 잔여, R-592).
// 0011 적용·재적용, HTTP 경로, 확정 때 purchase-svc 일괄 환불 시작기 호출, 판정자≠확정자를 본다.
// BAT-420(2026-11-16, 시험 담당, 구현 전에 씀): 요청은 판매 중지(실제 SALE_STOP 명령 기록)·재인증·Idempotency-Key를 거치고,
// 판정은 미리보기를 dry_run에 저장해 PENDING_APPROVAL로 두며, 확정은 판매 중지 집행(작은 HTTP 서버 둘, purchase → queue)을 먼저 부른다.
// 파트너 요청(R-T36)·멱등 기록(0014)·0013 제약(P3)을 실제 DB로 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabase, createExternalHttpClient, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { HttpEventSaleStopper } from '../src/adapters/event-sale-stopper.js';
import { HttpCommandExecutor } from '../src/adapters/http-command-executor.js';
import { AppModule } from '../src/app.module.js';
import type { CommandExecutor } from '../src/modules/commands/index.js';
import type { EventOwnerLookup, EventRefundReader, EventRefundStartInput, EventRefundStarter } from '../src/modules/event-cancellations/index.js';
import { DRY_RUN, JOB, fakeReauth, tokenFor } from '../test/event-cancellation-fixtures.js';
import type { EventRefundHolds } from '../src/modules/event-cancellations/index.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
// BAT-420-rest R-T41 ③(시험 담당 l3-b420-test)
import { DrizzleEventCancellationStore, EventCancellations } from '../src/modules/event-cancellations/index.js';

const NOW = Date.parse('2026-11-15T08:00:00.000Z');
/** 공연 시각은 실제 시계로 끝나지 않을 먼 미래로 둔다(요청 시각 셈이 Date.now든 CLOCK이든 같게) */
const FAR_STARTS_AT = Date.parse('2099-03-01T10:00:00.000Z');
const TENANT = '0194b000-0000-7000-8000-00000000f101';
const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
const calls: string[] = [];
const starts: EventRefundStartInput[] = [];
/** 판매 멈춤 HTTP 서버와 일괄 환불 시작의 호출 차례 */
const order: string[] = [];
const saleCalls: Array<{ target: string; path: string; token: string | undefined; body: Record<string, unknown> }> = [];
const sale = { purchaseFails: false };
const servers: Server[] = [];
const owners = new Map<string, { promoterId: string; startsAtMs: number; endsAtMs?: number }>();

const commandExecutor: CommandExecutor = { execute: async () => ({ status: 'SUCCEEDED' }) };
const refunds: EventRefundStarter = {
  start: async (i) => {
    calls.push(`start:${i.requestId}:${i.fault}`);
    starts.push(i);
    order.push(`start:${i.requestId}`);
    return { jobId: i.requestId, state: i.kind === 'POSTPONE' ? 'REFUND_WINDOW' : 'RUNNING' };
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
const reader: EventRefundReader = { preview: async () => DRY_RUN, job: async () => JOB };
const ownerLookup: EventOwnerLookup = { find: async (eventId) => owners.get(eventId) };
/** BAT-420 몫 D: purchase-svc SetEventRefundHold 대역. holdFails면 걸기가 UNAVAILABLE로 던진다 */
const holdState = { holdFails: false, calls: [] as Array<{ eventId: string; requestId: string; held: boolean; expiresAtMs?: number }> };
const intHolds: EventRefundHolds = {
  hold: async (q) => {
    holdState.calls.push({ ...q });
    if (q.held && holdState.holdFails) throw Object.assign(new Error('14 UNAVAILABLE: purchase-svc'), { code: 14 });
    return { held: q.held };
  },
};

/** purchase-svc·queue-svc 판매 중지 경로를 받는 작은 HTTP 서버 */
const listen = (target: 'purchase-svc' | 'queue-svc') =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
        const token = req.headers['x-peaket-internal-token'];
        saleCalls.push({ target, path: req.url ?? '', token: typeof token === 'string' ? token : undefined, body });
        order.push(`${target}:${String(body.action)}`);
        if (target === 'purchase-svc' && sale.purchaseFails) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ suspended: true, revision: 2 }));
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-event-cancellations-it' });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  const purchaseUrl = await listen('purchase-svc');
  const queueUrl = await listen('queue-svc');
  const stopper = new HttpEventSaleStopper(
    new HttpCommandExecutor({
      purchase: createExternalHttpClient({ provider: 'purchase-svc', baseUrl: purchaseUrl, timeoutCapMs: 5_000 }),
      queue: createExternalHttpClient({ provider: 'queue-svc', baseUrl: queueUrl, timeoutCapMs: 5_000 }),
      internalToken: 'it-token',
    }),
  );
  svc = await createService({
    name: 'ops-svc-event-cancellations',
    module: AppModule.register({ database: db, nowMs: NOW, executor: commandExecutor, eventCancellations: { refunds, reauth: fakeReauth(), reader, stopper, owners: ownerLookup, holds: intHolds } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
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
  for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
  container?.stop();
});

type Headers = Record<string, string>;
const post = (url: string, headers: Headers, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (url: string, headers: Headers) => svc.http.inject({ method: 'GET', url, headers });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
/** 재인증 토큰(act APPROVAL·패스키)과 새 멱등 키를 붙인다 */
const signed = (who: Headers, key: string = randomUUID()): Headers => ({ ...who, 'idempotency-key': key, 'x-reauth-token': tokenFor(who['x-user-id']!) });
const reauthed = (who: Headers): Headers => ({ ...who, 'x-reauth-token': tokenFor(who['x-user-id']!) });
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
const count = async (q: string, args: unknown[]): Promise<number> => Number((await admin.query<{ n: string }>(q, args)).rows[0]!.n);

/** 실제 운영 명령(2인 승인 뒤 실행 SUCCEEDED)으로 판매 중지·재개를 남긴다. 명령 시각이 겹치지 않게 시계를 1초 민다 */
async function saleCommand(type: 'SALE_STOP' | 'SALE_RESUME', eventId: string): Promise<void> {
  clock.advance(1_000);
  const created = await post('/v1/ops/commands', identity.ops('commander'), { type, reason: '판매 중지 대응', params: { eventId, reasonCode: 'LEGAL_REQUEST' } });
  expect(created.statusCode).toBe(201);
  const approved = await post(`/v1/ops/commands/${json(created).commandId as string}/approvals`, identity.ops('commander'), {});
  expect(json(approved).state).toBe('SUCCEEDED');
}
const suspend = (eventId: string) => saleCommand('SALE_STOP', eventId);

/** 판매 중지 → commander 요청 → 판정(미리보기) */
async function pendingApproval(eventId: string, commander: Headers = identity.ops('commander')): Promise<string> {
  await suspend(eventId);
  const created = await post('/v1/ops/event-cancellations', signed(commander), { eventId, reason: '공연 취소' });
  expect(created.statusCode).toBe(201);
  const requestId = json(created).requestId as string;
  const judged = await post(`/v1/ops/event-cancellations/${requestId}/judgement`, commander, { fault: 'ORGANIZER', reason: '주최 측', fanNoticeReason: '공연이 취소되었습니다' });
  expect(json(judged).status).toBe('PENDING_APPROVAL');
  return requestId;
}

describe('회차 취소 요청 실제 DB·HTTP [BAT-425]', () => {
  test('0011이 적용·재적용되고 요청→판정→판정자 아닌 확정이 일괄 환불을 시작한다', async () => {
    const applied = await admin.query("select name from ops_migration where name in ('0011_event_cancellation_request.sql') or name like '0013_%' or name like '0014_%' order by name");
    expect(applied.rows.map((r: { name: string }) => r.name.slice(0, 4))).toEqual(['0011', '0013', '0014']);
    const commander = identity.ops('commander');
    const operator = identity.ops('operator');
    const eventId = randomUUID();
    await suspend(eventId);
    const created = await post('/v1/ops/event-cancellations', signed(commander), { eventId, reason: '공연 취소' });
    expect(created.statusCode).toBe(201);
    const r = JSON.parse(created.payload) as { requestId: string; status: string };
    expect(r.status).toBe('REQUESTED');

    const list = await get(`/v1/ops/event-cancellations?eventId=${eventId}`, commander);
    expect(JSON.parse(list.payload).items).toHaveLength(1);

    expect((await post(`/v1/ops/event-cancellations/${r.requestId}/judgement`, commander, { fault: 'ORGANIZER', reason: '주최 측', fanNoticeReason: '공연이 취소되었습니다' })).statusCode).toBe(200);
    expect((await post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, reauthed(commander), {})).statusCode).toBe(403);
    const approved = await post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, reauthed(operator), {});
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.payload)).toMatchObject({ requestId: r.requestId, status: 'RUNNING' });
    expect(calls).toContain(`start:${r.requestId}:ORGANIZER`);

    const row = await admin.query('select status, judged_by, approved_by, refund_job_state from event_cancellation_request where request_id = $1', [r.requestId]);
    expect(row.rows[0]).toMatchObject({ status: 'RUNNING', refund_job_state: 'RUNNING' });
    expect(row.rows[0].judged_by).not.toBe(row.rows[0].approved_by);
    const audited = await admin.query('select record_type from audit_chain where record_id = $1 order by seq', [r.requestId]);
    expect(audited.rows.map((x: { record_type: string }) => x.record_type)).toEqual([
      'EVENT_CANCELLATION_REQUESTED',
      'EVENT_CANCELLATION_JUDGED',
      'EVENT_CANCELLATION_PREVIEWED',
      'EVENT_CANCELLATION_APPROVED',
      'EVENT_CANCELLATION_STARTED',
    ]);
  });

  test('OPSV01_감사_append가_실패하면_RUNNING_저장이_롤백되고_PENDING_APPROVAL로_남는다', async () => {
    const operator = identity.ops('operator');
    const requestId = await pendingApproval(randomUUID());
    await failAudit('EVENT_CANCELLATION_APPROVED');
    try {
      const failed = await post(`/v1/ops/event-cancellations/${requestId}/approvals`, reauthed(operator), {});
      expect(failed.statusCode).toBe(500);
    } finally {
      await clearAuditFailure();
    }
    const row = await admin.query('select status, version, approved_by from event_cancellation_request where request_id = $1', [requestId]);
    expect(row.rows[0]).toMatchObject({ status: 'PENDING_APPROVAL', approved_by: null });
    expect(Number(row.rows[0].version)).toBe(3);
    const retried = await post(`/v1/ops/event-cancellations/${requestId}/approvals`, reauthed(operator), {});
    expect(retried.statusCode).toBe(200);
    expect(JSON.parse(retried.payload)).toMatchObject({ status: 'RUNNING' });
  });

  test('OPSV02_동시_확정은_version_조건으로_한_번만_성공한다', async () => {
    const a = identity.ops('operator');
    const b = identity.ops('operator');
    const requestId = await pendingApproval(randomUUID());
    const [x, y] = await Promise.all([
      post(`/v1/ops/event-cancellations/${requestId}/approvals`, reauthed(a), {}),
      post(`/v1/ops/event-cancellations/${requestId}/approvals`, reauthed(b), {}),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    const row = await admin.query('select status, version, approved_by from event_cancellation_request where request_id = $1', [requestId]);
    expect(row.rows[0]).toMatchObject({ status: 'RUNNING' });
    expect(Number(row.rows[0].version)).toBe(5);
    expect([a['x-user-id'], b['x-user-id']]).toContain(row.rows[0].approved_by);
    expect(starts.filter((s) => s.requestId === requestId)).toHaveLength(1);
  });

  test('OPSV04_정지·재개·반려_사유와_pg가_감사_payload에_남고_검증이_통과한다', async () => {
    const commander = identity.ops('commander');
    const operator = identity.ops('operator');
    const requestId = await pendingApproval(randomUUID(), commander);
    await post(`/v1/ops/event-cancellations/${requestId}/approvals`, reauthed(operator), {});
    await post(`/v1/ops/event-cancellations/${requestId}/pauses`, commander, { pg: 'TOSS', reason: '수동 정지' });
    await post(`/v1/ops/event-cancellations/${requestId}/resumptions`, commander, { pg: 'TOSS', reason: '수동 재개' });
    const paused = await admin.query("select record_json from audit_chain where record_type = 'EVENT_CANCELLATION_PAUSED' and record_id = $1", [requestId]);
    expect(paused.rows[0]!.record_json).toMatchObject({ payload: { status: 'PAUSED', pg: 'TOSS', reason: '수동 정지' } });
    const resumed = await admin.query("select record_json from audit_chain where record_type = 'EVENT_CANCELLATION_RESUMED' and record_id = $1", [requestId]);
    expect(resumed.rows[0]!.record_json).toMatchObject({ payload: { status: 'RUNNING', pg: 'TOSS', reason: '수동 재개' } });

    const rr = await pendingApproval(randomUUID(), commander);
    await post(`/v1/ops/event-cancellations/${rr}/rejections`, operator, { reason: '증빙 부족' });
    const rejected = await admin.query("select record_json from audit_chain where record_type = 'EVENT_CANCELLATION_REJECTED' and record_id = $1", [rr]);
    expect(rejected.rows[0]!.record_json).toMatchObject({ payload: { status: 'JUDGED', reason: '증빙 부족' } });
    const back = await admin.query('select status, dry_run from event_cancellation_request where request_id = $1', [rr]);
    expect(back.rows[0]).toMatchObject({ status: 'JUDGED', dry_run: null });

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
    await suspend(eventId);
    const created = await post('/v1/ops/event-cancellations', signed(commander), { eventId, reason: '공연 취소' });
    const r = JSON.parse(created.payload) as { requestId: string };
    expect((await post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, reauthed(operator), {})).statusCode).toBe(409);
    await post(`/v1/ops/event-cancellations/${r.requestId}/judgement`, commander, { fault: 'CONTENT_CHANGE', reason: '내용 변경', fanNoticeReason: '공연 내용이 바뀌었습니다' });
    await post(`/v1/ops/event-cancellations/${r.requestId}/approvals`, reauthed(operator), {});
    expect((await post(`/v1/ops/event-cancellations/${r.requestId}/pauses`, commander, { pg: 'TOSS', reason: '수동' })).statusCode).toBe(200);
    expect((await post(`/v1/ops/event-cancellations/${r.requestId}/resumptions`, commander, { pg: 'TOSS', reason: '재개' })).statusCode).toBe(200);
    expect(calls).toContain(`pause:${r.requestId}:TOSS`);
    expect(calls).toContain(`resume:${r.requestId}:TOSS`);
  });
});

describe('commander 요청·판정·확정 실제 DB [BAT-420 GAT-110]', () => {
  test('R-T23 ⑤ 실제 명령 기록에서 마지막 SUCCEEDED가 판매 재개면 409 sale-not-suspended이고 다시 판매 중지하면 받는다', async () => {
    const eventId = randomUUID();
    const commander = identity.ops('commander');
    const none = await post('/v1/ops/event-cancellations', signed(commander), { eventId, reason: '공연 취소' });
    expect(none.statusCode).toBe(409);
    expect(json(none).type).toMatch(/sale-not-suspended$/);
    await saleCommand('SALE_STOP', eventId);
    await saleCommand('SALE_RESUME', eventId);
    const resumed = await post('/v1/ops/event-cancellations', signed(commander), { eventId, reason: '공연 취소' });
    expect(resumed.statusCode).toBe(409);
    expect(json(resumed).type).toMatch(/sale-not-suspended$/);
    expect(await count('select count(*) as n from event_cancellation_request where event_id = $1', [eventId])).toBe(0);
    await saleCommand('SALE_STOP', eventId);
    expect((await post('/v1/ops/event-cancellations', signed(commander), { eventId, reason: '공연 취소' })).statusCode).toBe(201);
  });

  test('R-T23 ⑥ R-T37 ① 판매 중지된 회차의 commander 요청은 판정(미리보기 저장)·판정자 외 1인 확정(판매 멈춤)을 거쳐 일괄 환불로 이어진다', async () => {
    const commanderA = identity.ops('commander');
    const operatorB = identity.ops('operator');
    const eventId = randomUUID();
    await suspend(eventId);
    const created = await post('/v1/ops/event-cancellations', signed(commanderA), { eventId, reason: '공연 취소' });
    expect(created.statusCode).toBe(201);
    const requestId = json(created).requestId as string;
    const judged = await post(`/v1/ops/event-cancellations/${requestId}/judgement`, commanderA, { fault: 'ORGANIZER', reason: '주최 측', fanNoticeReason: '공연이 취소되었습니다' });
    expect(json(judged)).toMatchObject({ status: 'PENDING_APPROVAL', dryRun: DRY_RUN });
    const stored = await admin.query('select status, dry_run, requested_via, promoter_id from event_cancellation_request where request_id = $1', [requestId]);
    expect(stored.rows[0]).toMatchObject({ status: 'PENDING_APPROVAL', requested_via: 'COMMANDER', promoter_id: null });
    expect(stored.rows[0].dry_run).toEqual(DRY_RUN);
    const before = order.length;
    const approved = await post(`/v1/ops/event-cancellations/${requestId}/approvals`, reauthed(operatorB), {});
    expect(json(approved).status).toBe('RUNNING');
    expect(order.slice(before)).toEqual(['purchase-svc:SUSPEND', 'queue-svc:SUSPEND', `start:${requestId}`]);
    expect(starts.find((s) => s.requestId === requestId)).toMatchObject({ eventId, fault: 'ORGANIZER', ruledBy: commanderA['x-user-id'], confirmedBy: operatorB['x-user-id'], kind: 'CANCEL' });
    const audited = await admin.query('select record_type from audit_chain where record_id = $1 order by seq', [requestId]);
    expect(audited.rows.map((x: { record_type: string }) => x.record_type)).toEqual([
      'EVENT_CANCELLATION_REQUESTED',
      'EVENT_CANCELLATION_JUDGED',
      'EVENT_CANCELLATION_PREVIEWED',
      'EVENT_CANCELLATION_APPROVED',
      'EVENT_CANCELLATION_STARTED',
    ]);
    expect(await count("select count(*) as n from cs_case where kind = 'JUDGEMENT_PENDING' and target_ref = $1", [requestId])).toBe(1);
  });

  test('R-T37 ④ 판매 멈춤이 실패하면 확정하지 않고 다시 확정하면 판매가 멈춘 뒤에 일괄 환불이 시작된다(작은 HTTP 서버 둘)', async () => {
    const operator = identity.ops('operator');
    const eventId = randomUUID();
    const requestId = await pendingApproval(eventId);
    sale.purchaseFails = true;
    let first;
    try {
      first = await post(`/v1/ops/event-cancellations/${requestId}/approvals`, reauthed(operator), {});
    } finally {
      sale.purchaseFails = false;
    }
    expect(first.statusCode).toBe(503);
    expect(json(first).type).toMatch(/sale-stop-unavailable$/);
    const row = await admin.query('select status, dry_run, approved_by from event_cancellation_request where request_id = $1', [requestId]);
    expect(row.rows[0]).toMatchObject({ status: 'PENDING_APPROVAL', approved_by: null });
    expect(row.rows[0].dry_run).toEqual(DRY_RUN);
    expect(starts.filter((s) => s.requestId === requestId)).toHaveLength(0);
    expect(saleCalls.filter((c) => c.body.commandId === requestId).map((c) => c.target)).toEqual(['purchase-svc']);

    const before = order.length;
    const second = await post(`/v1/ops/event-cancellations/${requestId}/approvals`, reauthed(operator), {});
    expect(json(second).status).toBe('RUNNING');
    expect(order.slice(before)).toEqual(['purchase-svc:SUSPEND', 'queue-svc:SUSPEND', `start:${requestId}`]);
    const mine = saleCalls.filter((c) => c.body.commandId === requestId);
    expect(mine.at(-2)).toMatchObject({ target: 'purchase-svc', path: `/internal/v1/event-sales/${eventId}/suspensions`, token: 'it-token' });
    expect(mine.at(-2)!.body).toEqual({ action: 'SUSPEND', commandId: requestId, reason: 'EVENT_CANCELLATION', suspensionRef: requestId });
    expect(mine.at(-1)).toMatchObject({ target: 'queue-svc', body: { action: 'SUSPEND', commandId: requestId } });
  });

  test('R-T37 ⑤ 실제 DB에서 회차 취소가 확정된 회차의 판매 재개 명령은 만들 때 409 event-cancelled다', async () => {
    const eventId = randomUUID();
    const requestId = await pendingApproval(eventId);
    expect(json(await post(`/v1/ops/event-cancellations/${requestId}/approvals`, reauthed(identity.ops('operator')), {})).status).toBe('RUNNING');
    const resume = await post('/v1/ops/commands', identity.ops('commander'), { type: 'SALE_RESUME', reason: '판매 재개', params: { eventId } });
    expect(resume.statusCode).toBe(409);
    expect(json(resume).type).toMatch(/event-cancelled$/);
    expect(await count("select count(*) as n from ops_command where type = 'SALE_RESUME' and event_id = $1", [eventId])).toBe(0);
  });

  test('GAT-110 Q2 같은 Idempotency-Key·같은 본문은 같은 요청 ID와 행·CS 건·멱등 기록 하나이고 다른 본문은 422, 키가 없으면 400이다', async () => {
    const commander = identity.ops('commander');
    const eventId = randomUUID();
    await suspend(eventId);
    const key = randomUUID();
    const a = await post('/v1/ops/event-cancellations', signed(commander, key), { eventId, reason: '공연 취소' });
    const b = await post('/v1/ops/event-cancellations', signed(commander, key), { eventId, reason: '공연 취소' });
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(json(b).requestId).toBe(json(a).requestId);
    expect(await count('select count(*) as n from event_cancellation_request where event_id = $1', [eventId])).toBe(1);
    expect(await count("select count(*) as n from cs_case where kind = 'JUDGEMENT_PENDING' and target_ref = $1", [json(a).requestId])).toBe(1);
    expect(await count("select count(*) as n from idempotency_record where account_ref = $1 and operation = 'CREATE_EVENT_CANCELLATION' and idempotency_key = $2", [commander['x-user-id'], key])).toBe(1);
    const c = await post('/v1/ops/event-cancellations', signed(commander, key), { eventId, reason: '다른 사유' });
    expect(c.statusCode).toBe(422);
    expect(json(c).type).toMatch(/idempotency-key-reused$/);
    const missing = await post('/v1/ops/event-cancellations', reauthed(commander), { eventId, reason: '공연 취소' });
    expect(missing.statusCode).toBe(400);
    expect(json(missing).type).toMatch(/idempotency-key-invalid$/);
  });
});

describe('파트너 회차 취소·연기 요청 실제 DB [BAT-420 GAT-110 P]', () => {
  const CANCEL = { kind: 'CANCEL', reason: '공연장 대관 취소', faultOpinion: 'FORCE_MAJEURE', evidenceRef: '공연장 대관 취소 통지 제2026-118호 2026-11-15' };
  const partnerPost = (eventId: string, who: Headers, body: unknown, key: string = randomUUID()) => post(`/v1/partner/events/${eventId}/cancellation`, { ...who, 'idempotency-key': key }, body);
  const own = (): string => {
    const eventId = randomUUID();
    owners.set(eventId, { promoterId: TENANT, startsAtMs: FAR_STARTS_AT, endsAtMs: FAR_STARTS_AT + 3 * 3_600_000 });
    return eventId;
  };

  test('R-T36 ① 파트너 관리자의 요청은 202 REQUESTED이고 요청 경로 PARTNER·테넌트·귀책 의견·증빙·바뀐 일시가 저장되며 감사·판정 대기 건이 하나씩 생긴다', async () => {
    const partner = identity.partner(TENANT);
    const cancelEvent = own();
    const cancelled = await partnerPost(cancelEvent, partner, CANCEL);
    expect(cancelled.statusCode).toBe(202);
    const cancelId = json(cancelled).requestId as string;
    const row = await admin.query('select kind, status, reason, requested_via, promoter_id, fault_opinion, evidence_ref, new_starts_at, requested_by from event_cancellation_request where request_id = $1', [cancelId]);
    expect(row.rows[0]).toMatchObject({
      kind: 'CANCEL',
      status: 'REQUESTED',
      reason: '공연장 대관 취소',
      requested_via: 'PARTNER',
      promoter_id: TENANT,
      fault_opinion: 'FORCE_MAJEURE',
      evidence_ref: '공연장 대관 취소 통지 제2026-118호 2026-11-15',
      new_starts_at: null,
      requested_by: partner['x-user-id'],
    });
    expect((await admin.query('select record_type from audit_chain where record_id = $1', [cancelId])).rows.map((x: { record_type: string }) => x.record_type)).toEqual(['EVENT_CANCELLATION_REQUESTED']);
    expect(await count("select count(*) as n from cs_case where kind = 'JUDGEMENT_PENDING' and target_ref = $1", [cancelId])).toBe(1);

    const postponeEvent = own();
    const newStartsAt = new Date(FAR_STARTS_AT + 7 * 86_400_000).toISOString();
    const postponed = await partnerPost(postponeEvent, partner, { kind: 'POSTPONE', reason: '출연자 건강 문제', evidenceRef: '출연자 측 공문 2026-11-14', newStartsAt });
    expect(postponed.statusCode).toBe(202);
    const p = await admin.query('select kind, new_starts_at, requested_via from event_cancellation_request where request_id = $1', [json(postponed).requestId]);
    expect(p.rows[0]).toMatchObject({ kind: 'POSTPONE', requested_via: 'PARTNER' });
    expect(new Date(p.rows[0].new_starts_at).toISOString()).toBe(newStartsAt);
  });

  test('R-T36 ⑦ 같은 멱등 키의 같은 본문은 같은 요청 ID로 한 건, 다른 본문은 422, 같은 테넌트의 다른 관리자가 쓴 같은 키는 진행 중 409다', async () => {
    const partner = identity.partner(TENANT);
    const eventId = own();
    const key = randomUUID();
    const a = await partnerPost(eventId, partner, CANCEL, key);
    const b = await partnerPost(eventId, partner, CANCEL, key);
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(json(b).requestId).toBe(json(a).requestId);
    expect(await count('select count(*) as n from event_cancellation_request where event_id = $1', [eventId])).toBe(1);
    expect(await count("select count(*) as n from cs_case where kind = 'JUDGEMENT_PENDING' and target_ref = $1", [json(a).requestId])).toBe(1);
    expect(await count("select count(*) as n from idempotency_record where operation = 'CREATE_PARTNER_EVENT_CANCELLATION' and idempotency_key = $1", [key])).toBe(1);
    const c = await partnerPost(eventId, partner, { ...CANCEL, evidenceRef: '다른 공문 2026-11-16' }, key);
    expect(c.statusCode).toBe(422);
    expect(json(c).type).toMatch(/idempotency-key-reused$/);
    const other = await partnerPost(eventId, identity.partner(TENANT), CANCEL, key);
    expect(other.statusCode).toBe(409);
    expect(json(other)).toMatchObject({ type: expect.stringMatching(/event-cancellation-active$/), requestId: json(a).requestId });
  });

  test('GAT-110 P2 파트너 연기 요청을 확정하면 판매를 멈추지 않고 바뀐 일시로 신청 창을 연다(실제 DB)', async () => {
    const partner = identity.partner(TENANT);
    const eventId = own();
    const newStartsAtMs = FAR_STARTS_AT + 7 * 86_400_000;
    const created = await partnerPost(eventId, partner, { kind: 'POSTPONE', reason: '출연자 건강 문제', newStartsAt: new Date(newStartsAtMs).toISOString() });
    const requestId = json(created).requestId as string;
    const commander = identity.ops('commander');
    await post(`/v1/ops/event-cancellations/${requestId}/judgement`, commander, { fault: 'CONTENT_CHANGE', reason: '일정 변경', fanNoticeReason: '공연이 연기되었습니다' });
    const before = saleCalls.length;
    const approved = await post(`/v1/ops/event-cancellations/${requestId}/approvals`, reauthed(identity.ops('operator')), {});
    expect(json(approved).status).toBe('REFUND_WINDOW');
    expect(saleCalls.length).toBe(before);
    expect(starts.find((s) => s.requestId === requestId)).toMatchObject({ kind: 'POSTPONE', postponedToMs: newStartsAtMs });
  });
});

describe('0013·0014 마이그레이션 실제 PostgreSQL 18 [BAT-420 GAT-110 P3]', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    request_id: randomUUID(),
    event_id: randomUUID(),
    kind: 'CANCEL',
    status: 'REQUESTED',
    reason: '공연 취소',
    requested_by: 'commander-1',
    requested_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...over,
  });
  const insert = (row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    return admin.query(`insert into event_cancellation_request (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  };
  const rejected = async (row: Record<string, unknown>, code = '23514') => {
    await expect(insert(row)).rejects.toMatchObject({ code });
  };

  test('GAT-110 P3 0013은 요청 경로·테넌트·연기 일시·증빙 길이·귀책 의견을 묶는다(경계 양쪽)', async () => {
    const at = new Date(FAR_STARTS_AT).toISOString();
    await rejected(base({ new_starts_at: at }));
    await rejected(base({ kind: 'POSTPONE' }));
    await rejected(base({ requested_via: 'EMAIL' }));
    await rejected(base({ requested_via: 'PARTNER' }));
    // 0015(웨이브 끝 리뷰 S2)가 CHECK를 'PARTNER면 promoter_id가 있다'로 넓혔다: commander 요청도 core 판매 설정의 promoterId를 적는다(data.md, authz-matrix §5.3)
    await expect(insert(base({ requested_via: 'COMMANDER', promoter_id: randomUUID() }))).resolves.toBeTruthy();
    await rejected(base({ evidence_ref: 'x'.repeat(201) }));
    await rejected(base({ evidence_ref: '' }));
    await rejected(base({ fault_opinion: 'NOPE' }));
    await expect(insert(base({ evidence_ref: 'x'.repeat(200), fault_opinion: 'ORGANIZER' }))).resolves.toBeTruthy();
    await expect(insert(base({ kind: 'POSTPONE', new_starts_at: at, requested_via: 'PARTNER', promoter_id: randomUUID() }))).resolves.toBeTruthy();
    const defaulted = base();
    await insert(defaulted);
    const row = await admin.query('select requested_via, promoter_id, dry_run, rejection_reason from event_cancellation_request where request_id = $1', [defaulted.request_id]);
    expect(row.rows[0]).toEqual({ requested_via: 'COMMANDER', promoter_id: null, dry_run: null, rejection_reason: null });
    const types = await admin.query<{ column_name: string; data_type: string }>(
      "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'event_cancellation_request' and column_name in ('requested_via','promoter_id','fault_opinion','evidence_ref','new_starts_at','dry_run','rejection_reason') order by column_name",
    );
    expect(Object.fromEntries(types.rows.map((r) => [r.column_name, r.data_type]))).toEqual({
      dry_run: 'jsonb',
      evidence_ref: 'text',
      fault_opinion: 'text',
      new_starts_at: 'timestamp with time zone',
      promoter_id: 'uuid',
      rejection_reason: 'text',
      requested_via: 'text',
    });
  });

  test('GAT-110 P3 0014 멱등 기록 표는 (계정, 작업, 키) 중복과 목록 밖 작업을 거절한다', async () => {
    const put = (operation: string, key: string, account = 'acct-1') =>
      admin.query('insert into idempotency_record (account_ref, operation, idempotency_key, request_hash, result_ref, created_at) values ($1, $2, $3, $4, null, $5)', [account, operation, key, Buffer.alloc(32, 1), new Date(NOW)]);
    const key = randomUUID();
    await put('CREATE_EVENT_CANCELLATION', key);
    await expect(put('CREATE_EVENT_CANCELLATION', key)).rejects.toMatchObject({ code: '23505' });
    await expect(put('CREATE_PARTNER_EVENT_CANCELLATION', key)).resolves.toBeTruthy();
    await expect(put('CREATE_EVENT_CANCELLATION', key, 'acct-2')).resolves.toBeTruthy();
    await expect(put('CREATE_ORDER', randomUUID())).rejects.toMatchObject({ code: '23514' });
  });

  test('GAT-110 P3 0013 앞에 있던 회차 취소 행은 요청 경로 COMMANDER로 채워지고 0013·0014는 한 번씩 적용된다', async () => {
    const name = 'peaket_bat420_mig';
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
    const url = container!.url.replace(/\/peaket$/, `/${name}`);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const dir = new URL('../migrations/', import.meta.url);
      const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
      for (const f of files.filter((n) => n < '0013')) await c.query(readFileSync(new URL(f, dir), 'utf8'));
      const old = randomUUID();
      await c.query("insert into event_cancellation_request (request_id, event_id, kind, status, reason, requested_by, requested_at, updated_at) values ($1, $2, 'CANCEL', 'RUNNING', '옛 요청', 'commander-1', now(), now())", [old, randomUUID()]);
      for (const f of files.filter((n) => n >= '0013' && n < '0015')) await c.query(readFileSync(new URL(f, dir), 'utf8'));
      const row = await c.query('select requested_via, promoter_id, dry_run from event_cancellation_request where request_id = $1', [old]);
      expect(row.rows[0]).toEqual({ requested_via: 'COMMANDER', promoter_id: null, dry_run: null });
    } finally {
      await c.end();
    }
    const applied = await admin.query("select name from ops_migration where name like '0013_%' or name like '0014_%'");
    expect(applied.rowCount).toBe(2);
  });
});

// ---- BAT-420 몫 D(OPEN[45] 결정, 시험 담당이 구현 전에 씀): 미룸을 걸지 못하면 회차 취소 요청을 저장하지 않는다(실제 DB) ----
describe('회차 취소 요청 전 미룸 [BAT-420 몫 D]', () => {
  test('R-T38 ⑥ 미룸을 걸지 못하면 commander·파트너 취소 요청은 503 event-refund-unavailable이고 요청 행·감사·CS 건·멱등 기록이 0이며 연기 요청은 받는다', async () => {
    const eventId = randomUUID();
    await suspend(eventId);
    const commander = identity.ops('commander');
    const key = randomUUID();
    holdState.holdFails = true;
    try {
      const r = await post('/v1/ops/event-cancellations', signed(commander, key), { eventId, reason: '공연 취소' });
      expect(r.statusCode).toBe(503);
      expect(json(r).type).toMatch(/event-refund-unavailable$/);
      const partnerEvent = randomUUID();
      owners.set(partnerEvent, { promoterId: TENANT, startsAtMs: FAR_STARTS_AT, endsAtMs: FAR_STARTS_AT + 3 * 3_600_000 });
      const p = await post(`/v1/partner/events/${partnerEvent}/cancellation`, { ...identity.partner(TENANT), 'idempotency-key': randomUUID() }, { kind: 'CANCEL', reason: '대관 취소' });
      expect(p.statusCode).toBe(503);
      for (const id of [eventId, partnerEvent]) expect(await count('select count(*) as n from event_cancellation_request where event_id = $1', [id])).toBe(0);
      expect(await count("select count(*) as n from idempotency_record where account_ref = $1 and idempotency_key = $2", [commander['x-user-id'], key])).toBe(0);
      expect(await count("select count(*) as n from audit_chain where record_type = 'EVENT_CANCELLATION_REQUESTED' and record_json->'payload'->>'eventId' in ($1, $2)", [eventId, partnerEvent])).toBe(0);
      const postponeEvent = randomUUID();
      owners.set(postponeEvent, { promoterId: TENANT, startsAtMs: FAR_STARTS_AT, endsAtMs: FAR_STARTS_AT + 3 * 3_600_000 });
      const before = holdState.calls.length;
      const pp = await post(`/v1/partner/events/${postponeEvent}/cancellation`, { ...identity.partner(TENANT), 'idempotency-key': randomUUID() }, { kind: 'POSTPONE', reason: '연기', newStartsAt: new Date(FAR_STARTS_AT + 86_400_000).toISOString() });
      expect(pp.statusCode).toBe(202);
      expect(holdState.calls.length).toBe(before);
    } finally {
      holdState.holdFails = false;
    }
    // 같은 키로 다시 보내면 새 요청으로 받는다(실패한 시도는 멱등 기록을 남기지 않았다)
    const again = await post('/v1/ops/event-cancellations', signed(commander, key), { eventId, reason: '공연 취소' });
    expect(again.statusCode).toBe(201);
    const requestId = json(again).requestId as string;
    expect(holdState.calls.filter((c) => c.requestId === requestId && c.held)).toHaveLength(1);
    expect(await count("select count(*) as n from cs_case where kind = 'JUDGEMENT_PENDING' and target_ref = $1", [requestId])).toBe(1);
  });
});

// BAT-420-rest R-T41 ③(시험 담당 l3-b420-test, 2026-11-19): core 회차 상태 반영 표시(ops 0016)와 다시 하기 잡기를 실제 PostgreSQL 18로 본다.
// 정본: docs/features/transfer-refund.md §5 'core 회차 상태 반영' 둘째 줄(1분 [가정]·20건 [가정]·10분 [가정] SEV2 요청마다 한 번),
// 'core 반영의 구현에서 정한 것' ⑤(대상은 Start까지 끝낸 확정 뒤 요청, 잡을 때 다음 볼 시각을 지금 + 1분으로 미룸 FOR UPDATE SKIP LOCKED, 10분 경계 포함).
// 이 묶음은 파일 끝에서 돈다: 앞 시험이 남긴 확정 행은 반영한 것으로 표시해 잡기 결과에서 빼고, 이 묶음이 만든 요청만 센다.
describe('R-T41 ③ core 반영 표시와 다시 하기 잡기 실제 DB [BAT-420-rest GAT-110]', () => {
  const MIN = 60_000;
  const store = () => new DrizzleEventCancellationStore(db, clock);
  const coreRow = async (requestId: string) =>
    (await admin.query<{ core_applied_at: Date | null; core_apply_next_at: Date | null; core_apply_overdue_at: Date | null }>('select core_applied_at, core_apply_next_at, core_apply_overdue_at from event_cancellation_request where request_id = $1', [requestId])).rows[0]!;
  /** 요청 → 판정 → 판정자 외 확정(Start까지)까지 HTTP로 만든다(이 서비스는 core 대역이 없어 core_applied_at이 빈다) */
  const approved = async (): Promise<string> => {
    const requestId = await pendingApproval(randomUUID());
    const r = await post(`/v1/ops/event-cancellations/${requestId}/approvals`, reauthed(identity.ops('operator')), {});
    expect(json(r).status).toBe('RUNNING');
    return requestId;
  };
  let mine: string[] = [];
  let notStarted: string;
  const T0 = Date.parse('2026-11-19T00:00:00.000Z');

  beforeAll(async () => {
    mine = [await approved(), await approved(), await approved()];
    notStarted = await pendingApproval(randomUUID());
    // 앞 묶음이 남긴 확정 행은 이 묶음의 잡기 셈에서 뺀다
    await admin.query('update event_cancellation_request set core_applied_at = now() where not (request_id = any($1::uuid[]))', [[...mine, notStarted]]);
    // 확정 시각을 1ms씩 다르게 정한다(차례·10분 경계)
    for (const [i, id] of mine.entries()) await admin.query('update event_cancellation_request set approved_at = $2 where request_id = $1', [id, new Date(T0 + i)]);
  });

  test('R-T41 ③ 0016은 core_applied_at·core_apply_next_at·core_apply_overdue_at(빈 값 허용)과 반영하지 않은 확정 뒤 요청만 받치는 부분 색인을 만든다', async () => {
    const cols = await admin.query<{ column_name: string; data_type: string; is_nullable: string }>(
      "select column_name, data_type, is_nullable from information_schema.columns where table_name = 'event_cancellation_request' and column_name like 'core_%' order by column_name",
    );
    expect(cols.rows).toEqual([
      { column_name: 'core_applied_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'core_apply_next_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'core_apply_overdue_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ]);
    const idx = await admin.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'event_cancellation_request_core_apply_idx'");
    expect(idx.rows[0]!.indexdef).toMatch(/core_applied_at IS NULL/);
    expect(idx.rows[0]!.indexdef).toMatch(/refund_job_state IS NOT NULL/);
    for (const id of mine) expect(await coreRow(id), id).toEqual({ core_applied_at: null, core_apply_next_at: null, core_apply_overdue_at: null });
  });

  test('R-T41 ③ 잡기는 Start까지 끝낸 확정 뒤 요청만 확정 시각 순으로 limit건 잡고 다음 볼 시각을 지금 + 60,000ms로 쓴다: 59,999ms 뒤 0건, 60,000ms 뒤 다시 잡힌다', async () => {
    const t = T0 + 30 * MIN;
    const first = await store().claimCoreApplies(t, 2, MIN);
    // 고르는 차례는 확정 시각 순이다(돌려주는 줄의 차례는 견주지 않는다: UPDATE … RETURNING은 차례를 정하지 않는다)
    expect(first.map((d) => d.requestId).sort()).toEqual(mine.slice(0, 2).sort());
    expect(first[0]).toMatchObject({ kind: 'CANCEL' });
    for (const id of mine.slice(0, 2)) expect((await coreRow(id)).core_apply_next_at?.getTime()).toBe(t + MIN);
    const second = await store().claimCoreApplies(t, 2, MIN);
    expect(second.map((d) => d.requestId)).toEqual([mine[2]]);
    expect(await store().claimCoreApplies(t + 59_999, 20, MIN)).toEqual([]);
    expect((await store().claimCoreApplies(t + 60_000, 20, MIN)).map((d) => d.requestId).sort()).toEqual([...mine].sort());
    // 판정만 끝난 요청(Start 전)은 잡히지 않는다
    expect((await store().claimCoreApplies(t + 10 * MIN, 20, MIN)).map((d) => d.requestId)).not.toContain(notStarted);
  });

  test('R-T41 ③ 두 연결이 같은 순간에 잡아도 한 요청은 한쪽만 잡는다(SKIP LOCKED)', async () => {
    const t = T0 + 60 * MIN;
    const other = createDatabase({ url: container!.url, applicationName: 'ops-core-apply-claim-2' });
    try {
      const [a, b] = await Promise.all([store().claimCoreApplies(t, 20, MIN), new DrizzleEventCancellationStore(other, clock).claimCoreApplies(t, 20, MIN)]);
      const ids = [...a, ...b].map((d) => d.requestId);
      expect(ids.sort()).toEqual([...mine].sort());
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await other.close();
    }
  });

  test('R-T41 ③ 늦음 표시는 확정 + 600,000ms ≤ 지금(경계 포함)인 요청에 한 번만 쓴다: 경계 1ms 전 0건, 정각 1건, 다시 0건', async () => {
    expect(await store().markCoreApplyOverdue(T0 + 10 * MIN - 1, 10 * MIN, 100)).toEqual([]);
    const at = await store().markCoreApplyOverdue(T0 + 10 * MIN, 10 * MIN, 100);
    expect(at.map((o) => o.requestId)).toEqual([mine[0]]);
    expect((await coreRow(mine[0]!)).core_apply_overdue_at?.getTime()).toBe(T0 + 10 * MIN);
    expect(await store().markCoreApplyOverdue(T0 + 10 * MIN, 10 * MIN, 100)).toEqual([]);
    expect((await store().markCoreApplyOverdue(T0 + 10 * MIN + 2, 10 * MIN, 100)).map((o) => o.requestId).sort()).toEqual(mine.slice(1).sort());
    expect(await store().markCoreApplyOverdue(T0 + 20 * MIN, 10 * MIN, 100)).toEqual([]);
  });

  test('R-T41 ③ 반영 표시는 한 번만 쓰이고(두 번째는 처음 시각 그대로) 표시된 요청은 다시 잡히지도 늦음으로 표시되지도 않는다', async () => {
    const [a] = mine;
    await store().markCoreApplied(a!, T0 + 70 * MIN);
    await store().markCoreApplied(a!, T0 + 80 * MIN);
    expect((await coreRow(a!)).core_applied_at?.getTime()).toBe(T0 + 70 * MIN);
    expect((await store().claimCoreApplies(T0 + 200 * MIN, 20, MIN)).map((d) => d.requestId)).not.toContain(a);
  });

  test('R-T41 ③ core 대역을 꽂은 서비스: 확정 HTTP는 core가 내려가도 RUNNING이고 core_applied_at이 비며, core가 살아난 뒤 다시 하기 한 바퀴가 반영하고 칸을 쓴다', async () => {
    const core = { down: true, calls: [] as string[] };
    const withCore = await createService({
      name: 'ops-svc-event-cancellations-core',
      module: AppModule.register({
        database: db,
        nowMs: NOW,
        executor: commandExecutor,
        eventCancellations: {
          refunds,
          reauth: fakeReauth(),
          reader,
          // 판매 멈춤은 받는 쪽이 멱등이라 이 묶음에서는 늘 받는 대역이다(판매 멈춤 자체는 위 R-T37 ④가 본다)
          stopper: { stop: async () => undefined },
          owners: ownerLookup,
          holds: intHolds,
          core: {
            apply: async (q) => {
              core.calls.push(`${q.requestId}:${q.kind}`);
              if (core.down) throw new Error('connect ECONNREFUSED core-svc');
            },
          },
        },
      }),
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet(),
      adminAuthz: identity,
    });
    try {
      const requestId = await pendingApproval(randomUUID());
      const r = await withCore.http.inject({ method: 'POST', url: `/v1/ops/event-cancellations/${requestId}/approvals`, headers: { ...reauthed(identity.ops('operator')), 'content-type': 'application/json' }, payload: '{}' });
      expect(json(r).status).toBe('RUNNING');
      // 장애 주입이 끼어들었다: core를 한 번 불렀고 실패했다
      expect(core.calls).toEqual([`${requestId}:CANCEL`]);
      expect((await coreRow(requestId)).core_applied_at).toBeNull();
      core.down = false;
      const result = await withCore.app.get(EventCancellations).retryCoreApply(clock.now() + MIN);
      expect(result.applied).toBeGreaterThanOrEqual(1);
      expect(core.calls.filter((c) => c === `${requestId}:CANCEL`)).toHaveLength(2);
      expect((await coreRow(requestId)).core_applied_at).not.toBeNull();
      await withCore.app.get(EventCancellations).retryCoreApply(clock.now() + 3 * MIN);
      expect(core.calls.filter((c) => c === `${requestId}:CANCEL`)).toHaveLength(2);
    } finally {
      await withCore.close();
    }
  });
});
