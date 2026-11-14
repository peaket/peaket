// notify 웹훅 도메인·HTTP 시험(BUILD_ORDER BAT-610 서버 잔여, FR-025, docs/features/notify.md §9).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryWebhookStore, checkWebhookUrl, newWebhookSecret } from '../src/modules/notify/index.js';
import type { WebhookEndpointRecord } from '../src/modules/notify/domain/webhook.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

const TENANT = randomUUID();
const OTHER = randomUUID();
const store = new MemoryWebhookStore();
const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, notify: { store } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

const headers = (tenant = TENANT) => ({ ...identity.partner(tenant), 'content-type': 'application/json' });
const noBody = (tenant = TENANT) => identity.partner(tenant);
const create = (tenant = TENANT, body: Record<string, unknown> = { url: 'https://partner.example.com/hook', eventTypes: ['order.confirmed'] }) =>
  svc.http.inject({ method: 'POST', url: '/v1/partner/webhooks', headers: headers(tenant), payload: JSON.stringify(body) });
const list = (tenant = TENANT) => svc.http.inject({ method: 'GET', url: '/v1/partner/webhooks', headers: headers(tenant) });
const update = (id: string, body: Record<string, unknown>, ifMatch?: string, tenant = TENANT) =>
  svc.http.inject({ method: 'PATCH', url: `/v1/partner/webhooks/${id}`, headers: { ...headers(tenant), ...(ifMatch ? { 'if-match': ifMatch } : {}) }, payload: JSON.stringify(body) });
const rotate = (id: string, tenant = TENANT) => svc.http.inject({ method: 'POST', url: `/v1/partner/webhooks/${id}/secret-rotations`, headers: noBody(tenant) });

describe('파트너 웹훅 관리', () => {
  test('N-T15 등록은 비밀을 한 번 주고 목록은 비밀 원문을 싣지 않는다', async () => {
    const r = await create();
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload);
    expect(body.secret).toMatch(/^whsec_/);
    expect(body).toMatchObject({ url: 'https://partner.example.com/hook', status: 'ACTIVE', version: 1 });
    const page = JSON.parse((await list()).payload);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty('secret');
  });

  test('N-T15 https·443·사용자 정보·IP·사설 호스트를 거절한다', async () => {
    for (const url of ['http://partner.example.com/hook', 'https://partner.example.com:8443/hook', 'https://u:p@partner.example.com/hook', 'https://203.0.113.10/hook', 'https://[::1]/hook', 'https://2130706433/hook', 'https://localhost/hook']) {
      const r = await create(TENANT, { url });
      expect(r.statusCode, url).toBe(400);
    }
    expect(() => checkWebhookUrl('https://partner.example.com/hook')).not.toThrow();
  });

  test('N-T15 고치기는 If-Match가 필요하고 다른 테넌트는 404다', async () => {
    const created = JSON.parse((await create()).payload);
    expect((await update(created.endpointId, { status: 'DISABLED' })).statusCode).toBe(428);
    expect((await update(created.endpointId, { status: 'DISABLED' }, '"9"')).statusCode).toBe(412);
    const ok = await update(created.endpointId, { status: 'DISABLED', eventTypes: ['event.sold_out'] }, '"1"');
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload)).toMatchObject({ status: 'DISABLED', eventTypes: ['event.sold_out'], version: 2 });
    expect((await update(created.endpointId, { status: 'ACTIVE' }, '"2"', OTHER)).statusCode).toBe(404);
  });

  test('N-T15 비밀 재발급은 24시간 옛 비밀을 남기고 1분 안 재발급은 409다', async () => {
    const created = JSON.parse((await create()).payload);
    const seeded = store.endpoints.get(created.endpointId)!;
    seeded.secretIssuedAt = new Date(NOW_MS - 120_000);
    const first = await rotate(created.endpointId);
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    const rotated = JSON.parse(first.payload);
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(new Date(rotated.previousSecretValidUntil).getTime()).toBeGreaterThan(NOW_MS + 23 * 60 * 60 * 1000);
    expect((await rotate(created.endpointId)).statusCode).toBe(409);
  });

  test('N-T15 발송 기록을 읽고 DEAD·SUCCEEDED만 다시 보낸다', async () => {
    const created = JSON.parse((await create()).payload);
    const deliveryId = randomUUID();
    store.deliveries.set(deliveryId, {
      deliveryId,
      endpointId: created.endpointId,
      webhookId: 'msg_1',
      eventType: 'order.confirmed',
      status: 'DEAD',
      attemptCount: 7,
      lastHttpStatus: null,
      lastError: 'TIMEOUT',
      nextAttemptAt: null,
      createdAt: new Date(NOW_MS),
      finishedAt: new Date(NOW_MS),
    });
    const page = JSON.parse((await svc.http.inject({ method: 'GET', url: `/v1/partner/webhooks/${created.endpointId}/deliveries`, headers: headers() })).payload);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ deliveryId, status: 'DEAD', lastError: 'TIMEOUT' });
    const re = await svc.http.inject({ method: 'POST', url: `/v1/partner/webhook-deliveries/${deliveryId}/redeliveries`, headers: noBody() });
    expect(re.statusCode).toBe(202);
    expect(JSON.parse(re.payload)).toMatchObject({ status: 'PENDING', attemptCount: 8 });
    expect((await svc.http.inject({ method: 'POST', url: `/v1/partner/webhook-deliveries/${deliveryId}/redeliveries`, headers: noBody() })).statusCode).toBe(409);
  });

  test('N-T15 저장소도 판이 다르면 conflict다', async () => {
    const s = new MemoryWebhookStore();
    const endpoint: WebhookEndpointRecord = {
      endpointId: randomUUID(),
      promoterId: TENANT,
      url: 'https://partner.example.com/hook',
      eventTypes: ['order.confirmed'],
      status: 'ACTIVE',
      disabledReason: null,
      secret: 'whsec_test',
      previousSecret: null,
      secretIssuedAt: new Date(NOW_MS),
      previousSecretValidUntil: null,
      version: 1,
    };
    await s.insertEndpoint(endpoint);
    expect(await s.saveEndpoint(TENANT, { ...endpoint, status: 'DISABLED' }, 9)).toBe('conflict');
    expect(await s.saveEndpoint(TENANT, { ...endpoint, status: 'DISABLED' }, 1)).toMatchObject({ status: 'DISABLED', version: 2 });
  });

  test('N-T15 비밀은 whsec_로 시작하는 32바이트 난수다', () => {
    const s = newWebhookSecret();
    expect(s).toMatch(/^whsec_[A-Za-z0-9+/=]{40,}$/);
    expect(newWebhookSecret()).not.toBe(s);
  });
});
