// shop 상품 HTTP 시험(BUILD_ORDER BAT-610 서버 잔여, FR-024, SCR-023).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FixedCommissionRate, MemoryProductEventDirectory, MemoryProductStore } from '../src/modules/shop/index.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

const TENANT = randomUUID();
const OTHER = randomUUID();
const store = new MemoryProductStore();
const directory = new MemoryProductEventDirectory();
const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, shop: { store, directory, commission: new FixedCommissionRate(1000) } }),
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
const body = (over: Record<string, unknown> = {}) => ({
  type: 'MERCH',
  name: 'LUMEN 공식 응원봉',
  price: 45000,
  shippingFee: 3000,
  returnShippingFee: 3000,
  returnAddress: '서울특별시 마포구',
  ticketLinked: false,
  linkedEventId: null,
  limitedQty: 10,
  fulfillments: ['DELIVERY', 'PICKUP'],
  transferable: false,
  status: 'PUBLISHED',
  attributes: { options: '인디고' },
  ...over,
});
const create = (tenant = TENANT, over: Record<string, unknown> = {}) =>
  svc.http.inject({ method: 'POST', url: '/v1/partner/products', headers: headers(tenant), payload: JSON.stringify(body(over)) });
const list = (tenant = TENANT, qs = '') => svc.http.inject({ method: 'GET', url: `/v1/partner/products${qs}`, headers: headers(tenant) });
const get = (id: string, tenant = TENANT) => svc.http.inject({ method: 'GET', url: `/v1/partner/products/${id}`, headers: headers(tenant) });
const patch = (id: string, over: Record<string, unknown>, ifMatch?: string, tenant = TENANT) =>
  svc.http.inject({
    method: 'PATCH',
    url: `/v1/partner/products/${id}`,
    headers: { ...headers(tenant), ...(ifMatch ? { 'if-match': ifMatch } : {}) },
    payload: JSON.stringify(over),
  });

describe('파트너 상품', () => {
  test('만들기→목록→하나 보기→고치기, ETag 판이 오른다', async () => {
    const created = await create();
    expect(created.statusCode).toBe(201);
    const p = JSON.parse(created.payload);
    expect(p).toMatchObject({ name: 'LUMEN 공식 응원봉', status: 'ON_SALE', stockRemaining: 10, stockTotal: 10, version: 1 });
    expect(created.headers.etag).toBe('"1"');

    const page = JSON.parse((await list()).payload);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ productId: p.productId, status: 'ON_SALE' });

    const one = await get(p.productId);
    expect(one.statusCode).toBe(200);
    expect(one.headers.etag).toBe('"1"');

    const updated = await patch(p.productId, { price: 39000, status: 'HIDDEN' }, '"1"');
    expect(updated.statusCode).toBe(200);
    expect(JSON.parse(updated.payload)).toMatchObject({ price: 39000, status: 'HIDDEN', version: 2 });
    expect(updated.headers.etag).toBe('"2"');
  });

  test('한정 수량 0은 품절이고, 티켓 연동은 연결 회차가 필요하다', async () => {
    const sold = await create(TENANT, { name: '품절 상품', limitedQty: 0 });
    expect(sold.statusCode).toBe(201);
    expect(JSON.parse(sold.payload).status).toBe('SOLD_OUT');

    const bad = await create(TENANT, { name: '잘못된 부가 상품', ticketLinked: true, linkedEventId: null, fulfillments: ['PICKUP'] });
    expect(bad.statusCode).toBe(422);
    expect(JSON.parse(bad.payload).type).toContain('product-ticket-link-invalid');
  });

  test('판매 기간으로 판매 전·판매 끝을 계산한다', async () => {
    const scheduled = await create(TENANT, { name: '판매 전 상품', saleStartsAt: '2027-01-01T00:00:00.000Z' });
    expect(scheduled.statusCode).toBe(201);
    expect(JSON.parse(scheduled.payload).status).toBe('NOT_STARTED');
    const ended = await create(TENANT, { name: '판매 끝 상품', saleEndsAt: '2020-01-01T00:00:00.000Z' });
    expect(ended.statusCode).toBe(201);
    expect(JSON.parse(ended.payload).status).toBe('ENDED');
  });

  test('고치기도 저장 전 검증을 다시 본다', async () => {
    const created = await create();
    const p = JSON.parse(created.payload);
    const invalid = await patch(p.productId, { ticketLinked: true, linkedEventId: null }, '"1"');
    expect(invalid.statusCode).toBe(422);
    expect(JSON.parse(invalid.payload).type).toContain('product-ticket-link-invalid');
  });

  test('다른 테넌트 상품은 404이고, If-Match가 없거나 다르면 428·412다', async () => {
    const created = await create();
    const p = JSON.parse(created.payload);
    expect((await get(p.productId, OTHER)).statusCode).toBe(404);
    expect((await patch(p.productId, { name: '몰래' }, undefined, OTHER)).statusCode).toBe(428);
    expect((await patch(p.productId, { name: '몰래' }, '"9"')).statusCode).toBe(412);
  });

  test('상품 상태로 거르고 이름을 찾는다', async () => {
    const page = JSON.parse((await list(TENANT, '?status=HIDDEN&q=응원봉')).payload);
    expect(page.items.every((p: { status: string }) => p.status === 'HIDDEN')).toBe(true);
    expect(page.items.some((p: { name: string }) => p.name.includes('응원봉'))).toBe(true);
  });

  test('판매 승인 전 초안은 목록에서 DRAFT다', async () => {
    const draft = await create(TENANT, { name: '초안 상품', status: 'DRAFT' });
    expect(draft.statusCode).toBe(201);
    expect(JSON.parse(draft.payload).status).toBe('DRAFT');
  });
});
