// /v1/ops/commands HTTP 골격(GAT-110 첫 몫): 역할 가드·접수·목록·2인 승인·거부.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { UnavailableAdminIdentity } from '../src/modules/admin-accounts/index.js';
import { fakeReauth, tokenFor } from './event-cancellation-fixtures.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-14T01:00:00.000Z');
const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, adminAccounts: { identity: new UnavailableAdminIdentity(), reauth: fakeReauth() } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

/** 위험 명령(2인 승인·멈추는 쪽 3·11)은 X-Reauth-Token(act=OPS_COMMAND)을 함께 보낸다(BAT-045 BOT-140) */
const withReauth = (h: Record<string, string>) => ({ ...h, 'x-reauth-token': tokenFor(h['x-user-id']!, { act: 'OPS_COMMAND' }) });
/** 접수(POST /v1/ops/commands)는 Idempotency-Key가 필요하다(ADR-0340 결정 7). 그 밖의 POST에는 붙이지 않는다 */
const post = (url: string, headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, ...(url === '/v1/ops/commands' ? { 'idempotency-key': randomUUID() } : {}), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
/** 명령 4 만료(지금 + 1시간, 24시간 이하) */
const BLOCK_EXPIRES = new Date(NOW + 60 * 60_000).toISOString();
const get = (url: string, headers: Record<string, string>) => svc.http.inject({ method: 'GET', url, headers });

describe('/v1/ops/commands', () => {
  test('GAT110_commander가_2인_명령을_접수하면_PENDING_APPROVAL이다', async () => {
    const commander = identity.ops('commander');
    const r = await post('/v1/ops/commands', withReauth(commander), { type: 'BOT_LEVEL', reason: '봇 급증', params: { level: 'AGGRESSIVE' } });
    expect(r.statusCode).toBe(201);
    expect(JSON.parse(r.payload)).toMatchObject({
      type: 'BOT_LEVEL',
      state: 'PENDING_APPROVAL',
      reason: '봇 급증',
      approvals: [],
      requestedBy: { adminAccountId: commander['x-user-id'], displayName: null, role: 'commander' },
    });
  });

  test('B3H01_operator는_킬스위치를_요청할_수_없고_판매_중지는_요청하되_승인할_수_없다', async () => {
    const operator = identity.ops('operator');
    const commander = identity.ops('commander');
    // 판매 중지는 operator 이상이 요청하고 요청자가 아닌 commander가 승인한다(POL-038 ⑩, ADR-0123 결정 2)
    const opCreated = await post('/v1/ops/commands', withReauth(operator), { type: 'SALE_STOP', reason: '판매 중지', params: { eventId: randomUUID(), reasonCode: 'LEGAL_REQUEST' } });
    expect(opCreated.statusCode).toBe(201);
    const opCommandId = (JSON.parse(opCreated.payload) as { commandId: string }).commandId;
    expect((await post(`/v1/ops/commands/${opCommandId}/approvals`, withReauth(operator), {})).statusCode).toBe(403);
    expect((await post('/v1/ops/commands', withReauth(operator), { type: 'KILL_SWITCH', reason: '긴급 정지', params: { scope: 'PLATFORM' } })).statusCode).toBe(403);
    const created = await post('/v1/ops/commands', withReauth(commander), { type: 'SALE_STOP', reason: '판매 중지', params: { eventId: randomUUID(), reasonCode: 'LEGAL_REQUEST' } });
    expect(created.statusCode).toBe(201);
    const commandId = (JSON.parse(created.payload) as { commandId: string }).commandId;
    expect(JSON.parse(created.payload)).toMatchObject({ state: 'PENDING_APPROVAL' });
    expect((await post(`/v1/ops/commands/${commandId}/approvals`, withReauth(operator), {})).statusCode).toBe(403);
    const detail = await get(`/v1/ops/commands/${commandId}`, operator);
    expect(JSON.parse(detail.payload)).toMatchObject({ canApprove: false });
    const approver = identity.ops('commander');
    const approved = await post(`/v1/ops/commands/${commandId}/approvals`, withReauth(approver), {});
    expect(approved.statusCode).toBe(200);
  });

  test('GAT110_상세는_params를_싣고_목록에는_싣지_않으며_viewer는_상세를_못_본다', async () => {
    const op = identity.ops('operator');
    const created = await post('/v1/ops/commands', op, { type: 'LOG_LEVEL', reason: '상세', params: { service: 'queue-svc', level: 'DEBUG' } });
    const commandId = (JSON.parse(created.payload) as { commandId: string }).commandId;
    const detail = await get(`/v1/ops/commands/${commandId}`, op);
    expect(detail.statusCode).toBe(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(detail.payload)).toMatchObject({ commandId, params: { service: 'queue-svc', level: 'DEBUG' } });
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
    const created = await post('/v1/ops/commands', withReauth(identity.ops('commander')), { type: 'BOT_LEVEL', reason: '권한 확인', params: { level: 'STANDARD' } });
    expect(created.statusCode).toBe(201);
    const commandId = (JSON.parse(created.payload) as { commandId: string }).commandId;
    expect((await post(`/v1/ops/commands/${commandId}/approvals`, withReauth(viewer), {})).statusCode).toBe(403);
    expect(JSON.parse((await get(`/v1/ops/commands/${commandId}`, identity.ops('operator'))).payload)).toMatchObject({ state: 'PENDING_APPROVAL', approvals: [] });
  });

  test('R-T23 ① operator가 판매 중지를 요청한 뒤 자기 승인하면 403이고, 요청자 아닌 commander가 승인한다', async () => {
    const operator = identity.ops('operator');
    const body = { type: 'SALE_STOP', reason: '판매자 신원 확인', params: { eventId: randomUUID(), reasonCode: 'SELLER_IDENTITY' } };
    // 판매 중지는 operator 이상이 요청한다(POL-038 ⑩, ADR-0123 결정 2)
    const opCreated = await post('/v1/ops/commands', withReauth(operator), body);
    expect(opCreated.statusCode).toBe(201);
    const opCommandId = (JSON.parse(opCreated.payload) as { commandId: string }).commandId;
    expect(JSON.parse(opCreated.payload)).toMatchObject({ state: 'PENDING_APPROVAL' });
    expect((await post(`/v1/ops/commands/${opCommandId}/approvals`, withReauth(operator), {})).statusCode).toBe(403);

    const requester = identity.ops('commander');
    const created = await post('/v1/ops/commands', withReauth(requester), { ...body, params: { eventId: randomUUID(), reasonCode: 'SELLER_IDENTITY' } });
    expect(created.statusCode).toBe(201);
    const { commandId } = JSON.parse(created.payload) as { commandId: string };
    expect(JSON.parse(created.payload)).toMatchObject({ state: 'PENDING_APPROVAL' });
    // 요청자 본인과 operator는 승인할 수 없다(요청자 ≠ 승인자, commander만)
    expect((await post(`/v1/ops/commands/${commandId}/approvals`, withReauth(requester), {})).statusCode).toBe(403);
    expect((await post(`/v1/ops/commands/${commandId}/approvals`, withReauth(operator), {})).statusCode).toBe(403);
    expect(JSON.parse((await get(`/v1/ops/commands/${commandId}`, requester)).payload)).toMatchObject({ state: 'PENDING_APPROVAL', approvals: [] });
    const approver = identity.ops('commander');
    expect((await post(`/v1/ops/commands/${commandId}/approvals`, withReauth(approver), {})).statusCode).toBe(200);
  });

  test('GAT110_다른_commander가_승인하면_APPROVED이고_요청자는_승인할_수_없다', async () => {
    const requester = identity.ops('commander');
    const created = await post('/v1/ops/commands', withReauth(requester), { type: 'DEGRADED_MODE', reason: '결제사 장애', params: { mode: 'PAYMENT' } });
    const commandId = (JSON.parse(created.payload) as { commandId: string }).commandId;
    const same = await post(`/v1/ops/commands/${commandId}/approvals`, withReauth(requester), {});
    expect(same.statusCode).toBe(403);
    const approver = identity.ops('commander');
    const approved = await post(`/v1/ops/commands/${commandId}/approvals`, withReauth(approver), {});
    expect(approved.statusCode).toBe(200);
    expect(JSON.parse(approved.payload)).toMatchObject({ commandId, state: 'APPROVED', approvals: [approver['x-user-id']] });
  });

  test('GAT110_거부는_사유를_남기고_REJECTED다', async () => {
    const requester = identity.ops('operator');
    const created = await post('/v1/ops/commands', withReauth(requester), { type: 'BLOCK_ASN_IP', reason: '대역 차단', params: { asns: [1234], expiresAt: BLOCK_EXPIRES } });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.payload)).toMatchObject({ state: 'PENDING_APPROVAL' });
    const commandId = (JSON.parse(created.payload) as { commandId: string }).commandId;
    const approver = identity.ops('operator');
    const rejected = await post(`/v1/ops/commands/${commandId}/rejections`, approver, { reason: '근거 부족' });
    expect(rejected.statusCode).toBe(200);
    expect(JSON.parse(rejected.payload)).toMatchObject({ commandId, state: 'REJECTED' });
    expect((await post(`/v1/ops/commands/${commandId}/rejections`, approver, { reason: '' })).statusCode).toBe(400);
  });

  test('GAT110_모르는_유형과_빈_사유는_400이다', async () => {
    const op = identity.ops('operator');
    // Idempotency-Key를 붙여 보내므로 400은 본문 검사의 400이다(키가 없는 400과 섞이지 않게 type까지 본다)
    for (const body of [{ type: 'NOPE', reason: 'x' }, { type: 'LOG_LEVEL', reason: '' }]) {
      const r = await post('/v1/ops/commands', op, body);
      expect(r.statusCode).toBe(400);
      expect(String((JSON.parse(r.payload) as { type: string }).type)).not.toMatch(/idempotency-key-invalid$/);
    }
  });
});
