// /v1/ops/commands HTTP 골격(GAT-110 첫 몫): 역할 가드·접수·목록·2인 승인·거부.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-14T01:00:00.000Z');
const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({ name: 'ops-svc', module: AppModule.register({ memory: true }), env: { PEAKET_ENV: 'ci' }, clock: fakeClock({ now: NOW }), logDestination: quiet(), adminAuthz: identity });
});
afterAll(async () => {
  await svc?.close();
});

const post = (url: string, headers: Record<string, string>, body: unknown) => svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (url: string, headers: Record<string, string>) => svc.http.inject({ method: 'GET', url, headers });

describe('/v1/ops/commands', () => {
  test('GAT110_operator가_2인_명령을_접수하면_PENDING_APPROVAL이다', async () => {
    const op = identity.ops('operator');
    const r = await post('/v1/ops/commands', op, { type: 'BOT_LEVEL', reason: '봇 급증', params: { level: 'AGGRESSIVE' } });
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'BOT_LEVEL',
      state: 'PENDING_APPROVAL',
      reason: '봇 급증',
      approvals: [],
      requestedBy: { adminAccountId: op['x-user-id'], displayName: null, role: 'operator' },
    });
  });

  test('GAT110_상세는_params를_싣고_목록에는_싣지_않으며_viewer는_상세를_못_본다', async () => {
    const op = identity.ops('operator');
    const created = await post('/v1/ops/commands', op, { type: 'LOG_LEVEL', reason: '상세', params: { level: 'DEBUG' } });
    const commandId = (JSON.parse(created.payload) as { commandId: string }).commandId;
    const detail = await get(`/v1/ops/commands/${commandId}`, op);
    expect(detail.statusCode).toBe(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(detail.payload)).toMatchObject({ commandId, params: { level: 'DEBUG' } });
    const list = await get('/v1/ops/commands?type=LOG_LEVEL&limit=100', op);
    const item = (JSON.parse(list.payload) as { items: Array<Record<string, unknown>> }).items.find((i) => i.commandId === commandId);
    expect(item).toBeTruthy();
    expect(item).not.toHaveProperty('params');
    expect((await get(`/v1/ops/commands/${randomUUID()}`, op)).statusCode).toBe(404);
    const viewer = identity.ops('viewer');
    expect((await get(`/v1/ops/commands/${commandId}`, viewer)).statusCode).toBe(403);
  });

  test('GAT110_viewer는_목록만_보고_접수하지_못한다', async () => {
    const viewer = identity.ops('viewer');
    expect((await get('/v1/ops/commands', viewer)).statusCode).toBe(200);
    expect((await get('/v1/ops/commands?limit=101', viewer)).statusCode).toBe(400);
    expect((await post('/v1/ops/commands', viewer, { type: 'LOG_LEVEL', reason: 'x' })).statusCode).toBe(403);
    const created = await post('/v1/ops/commands', identity.ops('operator'), { type: 'BOT_LEVEL', reason: '권한 확인' });
    const commandId = (JSON.parse(created.payload) as { commandId: string }).commandId;
    expect((await post(`/v1/ops/commands/${commandId}/approvals`, viewer, {})).statusCode).toBe(403);
  });

  test('GAT110_다른_operator가_승인하면_APPROVED이고_요청자는_승인할_수_없다', async () => {
    const requester = identity.ops('operator');
    const created = await post('/v1/ops/commands', requester, { type: 'DEGRADED_MODE', reason: '결제사 장애', params: { mode: 'PAYMENT' } });
    const commandId = (JSON.parse(created.payload) as { commandId: string }).commandId;
    const same = await post(`/v1/ops/commands/${commandId}/approvals`, requester, {});
    expect(same.statusCode).toBe(403);
    const approver = identity.ops('commander');
    const approved = await post(`/v1/ops/commands/${commandId}/approvals`, approver, {});
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.payload)).toMatchObject({ commandId, state: 'APPROVED', approvals: [approver['x-user-id']] });
  });

  test('GAT110_거부는_사유를_남기고_REJECTED다', async () => {
    const requester = identity.ops('operator');
    const created = await post('/v1/ops/commands', requester, { type: 'BLOCK_ASN_IP', reason: '대역 차단', params: { asn: 1234 } });
    const commandId = (JSON.parse(created.payload) as { commandId: string }).commandId;
    const approver = identity.ops('operator');
    const rejected = await post(`/v1/ops/commands/${commandId}/rejections`, approver, { reason: '근거 부족' });
    expect(rejected.statusCode).toBe(200);
    expect(JSON.parse(rejected.payload)).toMatchObject({ commandId, state: 'REJECTED' });
    expect((await post(`/v1/ops/commands/${commandId}/rejections`, approver, { reason: '' })).statusCode).toBe(400);
  });

  test('GAT110_모르는_유형과_빈_사유는_400이다', async () => {
    const op = identity.ops('operator');
    expect((await post('/v1/ops/commands', op, { type: 'NOPE', reason: 'x' })).statusCode).toBe(400);
    expect((await post('/v1/ops/commands', op, { type: 'LOG_LEVEL', reason: '' })).statusCode).toBe(400);
  });
});
