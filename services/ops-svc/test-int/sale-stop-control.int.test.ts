// BAT-465 R-584 판매 중지·재개 집행의 실제 PostgreSQL 18 통합 시험.
// 2인 승인, purchase-svc → queue-svc 차례(중지)·반대 차례(재개), 실패·재시도, 실행 전후 감사 체크포인트,
// 공개 앵커(Ed25519)까지 HTTP로 본다. purchase/queue는 같은 계약을 흉내 내는 HTTP 서버다.
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
import { ephemeralAuditAnchorSigner } from '../src/modules/audit/index.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-15T03:00:00.000Z');
const identity = new FakeIdentity();
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;
let purchaseServer: Server;
let queueServer: Server;
let purchaseFail = false;
const purchaseCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
const queueCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
/** 두 가짜 서버에 닿은 차례(중지 purchase→queue, 재개 queue→purchase 확인) */
const callOrder: string[] = [];

const bodyOf = (raw: string): Record<string, unknown> => (raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
const post = (url: string, headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (url: string, headers: Record<string, string>) => svc.http.inject({ method: 'GET', url, headers });

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-sale-stop-it' });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();

  purchaseServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      purchaseCalls.push({ url: req.url ?? '', body: bodyOf(raw) });
      callOrder.push('purchase');
      res.statusCode = purchaseFail ? 503 : 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ eventId: String(bodyOf(raw).eventId ?? ''), suspended: bodyOf(raw).action === 'SUSPEND', revision: 5 }));
    });
  });
  queueServer = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      queueCalls.push({ url: req.url ?? '', body: bodyOf(raw) });
      callOrder.push('queue');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await Promise.all([new Promise<void>((r) => purchaseServer.listen(0, '127.0.0.1', r)), new Promise<void>((r) => queueServer.listen(0, '127.0.0.1', r))]);
  const purchasePort = (purchaseServer.address() as AddressInfo).port;
  const queuePort = (queueServer.address() as AddressInfo).port;
  const executor = new HttpCommandExecutor({
    purchase: createExternalHttpClient({ provider: 'purchase-svc', baseUrl: `http://127.0.0.1:${purchasePort}`, timeoutCapMs: 5_000 }),
    queue: createExternalHttpClient({ provider: 'queue-svc', baseUrl: `http://127.0.0.1:${queuePort}`, timeoutCapMs: 5_000 }),
  });
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db, executor, nowMs: NOW, signer: ephemeralAuditAnchorSigner('it') }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  await new Promise<void>((r) => purchaseServer?.close(() => r()));
  await new Promise<void>((r) => queueServer?.close(() => r()));
  container?.stop();
});

describe('BAT-465 판매 중지·재개 집행 실제 DB', () => {
  test('R584_중지는_2인_승인_뒤_purchase_then_queue로_집행된다', async () => {
    purchaseCalls.length = 0;
    queueCalls.length = 0;
    callOrder.length = 0;
    const operator = identity.ops('operator');
    const commander = identity.ops('commander');
    const eventId = randomUUID();
    const created = await post('/v1/ops/commands', operator, { type: 'SALE_STOP', reason: '판매자 신원 확인', params: { eventId, reasonCode: 'SELLER_IDENTITY' } });
    expect(created.statusCode).toBe(201);
    const command = JSON.parse(created.payload) as { commandId: string; state: string; approvalExpiresAt: string | null };
    expect(command).toMatchObject({ state: 'PENDING_APPROVAL' });
    expect(command.approvalExpiresAt).toBeTruthy();
    expect(purchaseCalls).toHaveLength(0);

    const approved = await post(`/v1/ops/commands/${command.commandId}/approvals`, commander, {});
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.payload)).toMatchObject({ state: 'SUCCEEDED', attempts: 1 });
    expect(purchaseCalls.map((c) => c.url)).toEqual([`/internal/v1/event-sales/${eventId}/suspensions`]);
    expect(purchaseCalls[0]!.body).toMatchObject({ action: 'SUSPEND', commandId: command.commandId, reason: '판매자 신원 확인', suspensionRef: command.commandId });
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0]!.body).toMatchObject({ action: 'SUSPEND', commandId: command.commandId, revision: 5 });
    expect(callOrder).toEqual(['purchase', 'queue']);
  });

  test('R584_재개는_queue_then_purchase_차례다', async () => {
    purchaseCalls.length = 0;
    queueCalls.length = 0;
    callOrder.length = 0;
    const operator = identity.ops('operator');
    const commander = identity.ops('commander');
    const eventId = randomUUID();
    const created = await post('/v1/ops/commands', operator, { type: 'SALE_RESUME', reason: '확인 끝', params: { eventId } });
    const { commandId } = JSON.parse(created.payload) as { commandId: string };
    const approved = await post(`/v1/ops/commands/${commandId}/approvals`, commander, {});
    expect(JSON.parse(approved.payload)).toMatchObject({ state: 'SUCCEEDED' });
    // 재개는 대기열을 먼저 열고 판매를 연다: 호출 차례로 확인한다
    expect(queueCalls).toHaveLength(1);
    expect(purchaseCalls).toHaveLength(1);
    expect(callOrder).toEqual(['queue', 'purchase']);
    expect(queueCalls[0]!.body).toMatchObject({ action: 'RESUME' });
    expect(purchaseCalls[0]!.body).toMatchObject({ action: 'RESUME' });
  });

  test('R584_대상이_실패하면_FAILED이고_재시도가_SUCCEEDED다', async () => {
    const operator = identity.ops('operator');
    const commander = identity.ops('commander');
    const created = await post('/v1/ops/commands', operator, { type: 'SALE_STOP', reason: '법적 요청', params: { eventId: randomUUID(), reasonCode: 'LEGAL_REQUEST' } });
    const { commandId } = JSON.parse(created.payload) as { commandId: string };
    purchaseFail = true;
    const failed = await post(`/v1/ops/commands/${commandId}/approvals`, commander, {});
    expect(JSON.parse(failed.payload)).toMatchObject({ state: 'FAILED', attempts: 1 });
    expect(JSON.parse(failed.payload).lastError).toContain('purchase-svc sale suspension 503');
    purchaseFail = false;
    const retried = await post(`/v1/ops/commands/${commandId}/retries`, commander, {});
    expect(JSON.parse(retried.payload)).toMatchObject({ state: 'SUCCEEDED', attempts: 2 });
  });

  test('R584_실행_전후_감사_체크포인트와_공개_앵커가_남는다', async () => {
    const commander = identity.ops('commander');
    const created = await post('/v1/ops/audit-checkpoints', commander, { reason: '판매 중지 집행 뒤' });
    expect(created.statusCode).toBe(201);
    const cp = JSON.parse(created.payload) as { checkpointId: string; signature: string | null; keyId: string | null; anchorRef: string | null };
    expect(cp.signature).toBeTruthy();
    expect(cp.keyId).toBe('it');
    expect(cp.anchorRef).toBe(`local:${cp.checkpointId}`);
    const anchor = await get(`/v1/ops/audit-anchors/${cp.checkpointId}`, {});
    expect(anchor.statusCode).toBe(200);
    expect(JSON.parse(anchor.payload)).toMatchObject({ algorithm: 'Ed25519', signature: cp.signature });
    const verification = await get(`/v1/ops/audit-anchors/${cp.checkpointId}/verification`, {});
    expect(JSON.parse(verification.payload)).toMatchObject({ valid: true, signatureValid: true, anchorValid: true });

    const { rows } = await admin.query<{ n: string }>('select count(*)::text as n from audit_checkpoint');
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });
});
