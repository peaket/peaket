// BAT-465 GAT-300·GAT-310 실제 PostgreSQL 18 통합 시험.
// 0002 마이그레이션, SCALE_CHANGE→core-svc·EVENT_CANCEL→purchase-svc 실행, DISPATCHED→SUCCEEDED/FAILED,
// 재시도, 감사 체크포인트 루트·사슬·검증, 2인 승인·권한, 내부 사건 eventKey 멱등을 본다.
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
import { DrizzleCommandStore } from '../src/modules/commands/index.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-14T08:00:00.000Z');
const identity = new FakeIdentity();
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
let coreServer: Server;
let purchaseServer: Server;
let coreFail = false;
let purchaseFail = false;
const coreCalls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }> = [];
const purchaseCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

const bodyOf = (raw: string): Record<string, unknown> => (raw ? (JSON.parse(raw) as Record<string, unknown>) : {});

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-command-execution-it' });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();

  coreServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      coreCalls.push({ url: req.url ?? '', body: bodyOf(raw), headers: req.headers });
      res.statusCode = coreFail ? 409 : 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ applied: !coreFail }));
    });
  });
  purchaseServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      purchaseCalls.push({ url: req.url ?? '', body: bodyOf(raw) });
      res.statusCode = purchaseFail ? 503 : 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await Promise.all([
    new Promise<void>((resolve) => coreServer.listen(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => purchaseServer.listen(0, '127.0.0.1', resolve)),
  ]);
  const corePort = (coreServer.address() as AddressInfo).port;
  const purchasePort = (purchaseServer.address() as AddressInfo).port;
  const executor = new HttpCommandExecutor({
    core: createExternalHttpClient({ provider: 'core-svc', baseUrl: `http://127.0.0.1:${corePort}`, timeoutCapMs: 5_000 }),
    purchase: createExternalHttpClient({ provider: 'purchase-svc', baseUrl: `http://127.0.0.1:${purchasePort}`, timeoutCapMs: 5_000 }),
  });
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
  await Promise.all([
    new Promise<void>((resolve) => coreServer?.close(() => resolve())),
    new Promise<void>((resolve) => purchaseServer?.close(() => resolve())),
  ]);
  await svc?.close();
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) => admin.query<R>(text, params);
const count = async (text: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(text, params)).rows[0]!.n);
const post = (url: string, headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (url: string, headers: Record<string, string>) => svc.http.inject({ method: 'GET', url, headers });

const createScale = async (operator: Record<string, string>, eventId: string) => {
  const r = await post('/v1/ops/commands', operator, { type: 'SCALE_CHANGE', reason: '규모 올리기', params: { eventId, scale: 'LARGE' } });
  expect(r.statusCode).toBe(201);
  return JSON.parse(r.payload) as { commandId: string; state: string; attempts: number; result?: Record<string, unknown> };
};
const createEventCancel = async (operator: Record<string, string>, eventId: string) => {
  const r = await post('/v1/ops/commands', operator, { type: 'EVENT_CANCEL', reason: '회차 취소', params: { eventId, fault: 'ORGANIZER' } });
  expect(r.statusCode).toBe(201);
  return JSON.parse(r.payload) as { commandId: string; state: string };
};

describe('BAT-465 실제 PostgreSQL·대상 HTTP', () => {
  test('BAT465_0002_마이그레이션은_재적용해도_같고_실행_칸·체크포인트_표·제약을_만든다', async () => {
    const tables = async () =>
      (await q<{ relname: string }>("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname")).rows.map((r) => r.relname);
    const before = await tables();
    expect(before).toEqual(expect.arrayContaining(['ops_command', 'audit_checkpoint', 'audit_chain']));
    await migrateOps(container!.url);
    await migrateOps(container!.url);
    expect(await tables()).toEqual(before);
    expect(await count('select count(*) as n from ops_migration')).toBe(4);
    const cols = (await q<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'ops_command'")).rows.map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['attempts', 'last_error', 'executed_at', 'result']));
    const state = await q<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'ops_command_state_check'");
    expect(state.rows[0]?.def).toContain("'SUCCEEDED'");
    const type = await q<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'ops_command_type_check'");
    expect(type.rows[0]?.def).toContain("'SCALE_CHANGE'");
  });

  test('BAT425_0003은_운영_경보_표와_회차_취소_환불_수동_명령_유형을_더한다', async () => {
    const tables = (await q<{ relname: string }>("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname")).rows.map((r) => r.relname);
    expect(tables).toEqual(expect.arrayContaining(['ops_alert']));
    const cols = (await q<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'ops_alert' order by ordinal_position")).rows.map((r) => r.column_name);
    expect(cols).toEqual(['id', 'event_key', 'kind', 'severity', 'source', 'reason', 'detail', 'created_at']);
    const type = await q<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'ops_command_type_check'");
    expect(type.rows[0]?.def).toContain("'EVENT_REFUND_PAUSE'");
    expect(type.rows[0]?.def).toContain("'EVENT_REFUND_RESUME'");
  });

  test('BAT465_저장소는_실패_뒤_성공에서_lastError를_지운다', async () => {
    const store = new DrizzleCommandStore(db);
    const commandId = randomUUID();
    await store.create({
      commandId,
      type: 'SCALE_CHANGE',
      reason: '저장소 시험',
      params: {},
      requestedBy: randomUUID(),
      requestedRole: 'operator',
      nowMs: NOW,
    });
    await store.markDispatched(commandId, NOW + 1);
    await store.markDispatchFailed(commandId, 'boom', NOW + 2);
    expect((await store.find(commandId))?.lastError).toBe('boom');
    await store.markSucceeded(commandId, undefined, NOW + 3);
    expect((await store.find(commandId))?.lastError).toBeUndefined();
  });

  test('BAT465_SCALE_CHANGE는_core-svc를_불러_SUCCEEDED로_끝나고_체크포인트_두_개를_남긴다', async () => {
    const operator = identity.ops('operator');
    const eventId = randomUUID();
    const c = await createScale(operator, eventId);
    expect(c).toMatchObject({ state: 'SUCCEEDED', attempts: 1, result: { target: 'core-svc', status: 200 } });
    expect(coreCalls).toHaveLength(1);
    expect(coreCalls[0]!.url).toBe(`/v1/ops/events/${eventId}/scale-changes`);
    expect(coreCalls[0]!.body).toEqual({ scale: 'LARGE', reason: '규모 올리기', intervalException: false });
    expect(coreCalls[0]!.headers['x-user-id']).toBe(operator['x-user-id']);
    expect(coreCalls[0]!.headers['x-user-aud']).toBe('ops');
    const row = await q<{ state: string; attempts: number; result: Record<string, unknown> }>('select state, attempts, result from ops_command where id = $1::uuid', [c.commandId]);
    expect(row.rows[0]).toMatchObject({ state: 'SUCCEEDED', attempts: 1, result: { target: 'core-svc' } });
    expect(await count("select count(*) as n from audit_checkpoint where reason like $1", [`COMMAND_EXECUTION%:${c.commandId}`])).toBe(2);
    const events = await q<{ type: string }>('select type from command_event where command_id = $1::uuid order by seq', [c.commandId]);
    expect(events.rows.map((r) => r.type)).toEqual(['CREATED', 'APPROVED', 'DISPATCHED', 'SUCCEEDED']);
  });

  test('BAT465_EVENT_CANCEL은_요청자_본인이_승인할_수_없고_commander_승인_뒤_purchase로_간다', async () => {
    const operator = identity.ops('operator');
    const commander = identity.ops('commander');
    const eventId = randomUUID();
    const c = await createEventCancel(operator, eventId);
    expect(c.state).toBe('PENDING_APPROVAL');
    expect((await post(`/v1/ops/commands/${c.commandId}/approvals`, operator, {})).statusCode).toBe(403);
    const approved = await post(`/v1/ops/commands/${c.commandId}/approvals`, commander, {});
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.payload)).toMatchObject({ commandId: c.commandId, state: 'SUCCEEDED', attempts: 1 });
    expect(purchaseCalls).toHaveLength(1);
    expect(purchaseCalls[0]!.url).toBe('/internal/v1/event-refunds');
    expect(purchaseCalls[0]!.body).toMatchObject({ eventId, requestId: c.commandId, fault: 'ORGANIZER', ruledBy: operator['x-user-id'], confirmedBy: commander['x-user-id'] });
  });

  test('BAT465_실행_실패는_FAILED와_lastError를_남기고_재시도는_권한을_보며_SUCCEEDED로_끝난다', async () => {
    const operator = identity.ops('operator');
    const viewer = identity.ops('viewer');
    coreFail = true;
    const c = await createScale(operator, randomUUID());
    expect(c).toMatchObject({ state: 'FAILED', attempts: 1 });
    const failed = await q<{ last_error: string; executed_at: Date }>('select last_error, executed_at from ops_command where id = $1::uuid', [c.commandId]);
    expect(failed.rows[0]!.last_error).toContain('core-svc scale change 409');
    expect(failed.rows[0]!.executed_at).toBeTruthy();
    expect((await post(`/v1/ops/commands/${c.commandId}/retries`, viewer, {})).statusCode).toBe(403);
    coreFail = false;
    const retried = await post(`/v1/ops/commands/${c.commandId}/retries`, operator, {});
    expect(retried.statusCode).toBe(200);
    expect(JSON.parse(retried.payload)).toMatchObject({ commandId: c.commandId, state: 'SUCCEEDED', attempts: 2 });
    const cleared = await q<{ last_error: string | null; executed_at: Date }>('select last_error, executed_at from ops_command where id = $1::uuid', [c.commandId]);
    expect(cleared.rows[0]!.last_error).toBeNull();
    expect(cleared.rows[0]!.executed_at).toBeTruthy();
    expect(coreCalls.filter((x) => x.url.endsWith('/scale-changes')).length).toBeGreaterThanOrEqual(2);
  });

  test('BAT465_감사_체크포인트는_루트·직전_사슬을_검증하고_기록을_바꾸면_실패한다', async () => {
    const commander = identity.ops('commander');
    const created = await post('/v1/ops/audit-checkpoints', commander, { reason: '웨이브 점검' });
    expect(created.statusCode).toBe(201);
    const cp = JSON.parse(created.payload) as { checkpointId: string; fromSeq: number; toSeq: number; rootHash: string };
    expect(cp.toSeq).toBeGreaterThanOrEqual(cp.fromSeq);
    const list = await get('/v1/ops/audit-checkpoints?limit=10', commander);
    expect(list.statusCode).toBe(200);
    expect((JSON.parse(list.payload) as { items: Array<{ checkpointId: string }> }).items.some((x) => x.checkpointId === cp.checkpointId)).toBe(true);
    const ok = await get(`/v1/ops/audit-checkpoints/${cp.checkpointId}/verification`, commander);
    expect(JSON.parse(ok.payload)).toMatchObject({ valid: true, rootValid: true, prevValid: true });
    // 구간의 감사 기록 하나를 바꾸면 루트 재계산이 맞지 않는다.
    const seq = cp.fromSeq;
    await q('update audit_chain set record_sha256 = decode($1, $2) where seq = $3', ['00'.repeat(32), 'hex', seq]);
    const broken = await get(`/v1/ops/audit-checkpoints/${cp.checkpointId}/verification`, commander);
    expect(JSON.parse(broken.payload)).toMatchObject({ valid: false, rootValid: false });
  });

  test('BAT465_내부_사건은_eventKey로_한_번만_명령을_만든다', async () => {
    const eventKey = `event-${randomUUID()}`;
    const body = { eventKey, kind: 'COMMAND_REQUESTED', type: 'EVENT_CANCEL', reason: '사건 요청', params: { eventId: randomUUID(), fault: 'ORGANIZER' }, requestedBy: randomUUID(), requestedRole: 'operator' };
    const a = await post('/internal/v1/ops/command-events', {}, body);
    expect(a.statusCode).toBe(202);
    const first = JSON.parse(a.payload) as { accepted: boolean; commandId: string };
    expect(first.accepted).toBe(true);
    const b = await post('/internal/v1/ops/command-events', {}, body);
    expect(JSON.parse(b.payload)).toEqual(first);
    expect(await count('select count(*) as n from ops_command where id = $1::uuid', [first.commandId])).toBe(1);
  });

  test('BAT465_2인_명령_거부는_REJECTED로_남고_재시도는_FAILED만_받는다', async () => {
    const operator = identity.ops('operator');
    const commander = identity.ops('commander');
    const c = await createEventCancel(operator, randomUUID());
    const rejected = await post(`/v1/ops/commands/${c.commandId}/rejections`, commander, { reason: '근거 부족' });
    expect(rejected.statusCode).toBe(200);
    expect(JSON.parse(rejected.payload)).toMatchObject({ commandId: c.commandId, state: 'REJECTED' });
    const retry = await post(`/v1/ops/commands/${c.commandId}/retries`, commander, {});
    expect(retry.statusCode).toBe(409);
    expect(JSON.parse(retry.payload)).toMatchObject({ type: expect.stringContaining('command-not-failed') });
  });
});
