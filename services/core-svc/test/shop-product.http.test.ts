// shop 상품 HTTP 시험(BUILD_ORDER BAT-610 서버 잔여, FR-024, SCR-023).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { FixedCommissionRate, MemoryMerchStock, MemoryProductEventDirectory, MemoryProductStore, MemoryProductTypeDirectory } from '../src/modules/shop/index.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

const TENANT = randomUUID();
const OTHER = randomUUID();
const store = new MemoryProductStore();
const directory = new MemoryProductEventDirectory();
const identity = new FakeIdentity();
const types = new MemoryProductTypeDirectory();
const stock = new MemoryMerchStock();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, shop: { store, directory, commission: new FixedCommissionRate(1000), types, stock } }),
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
  // MERCH 판 1 스키마 모양(ADR-0300 결정 1: options는 이름과 고를 값의 목록)
  attributes: { options: [{ name: '색상', values: ['인디고'] }] },
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

// ---- BAT-600: 상품 유형 표·유형 스키마(V-T46 ①②, ADR-0300 결정 1)와 한정 수량 고치기(P-T56 ⑧, ADR-0300 결정 3) ----
// 단언 값은 정본에서: 422 type 이름(product-type-invalid·product-attributes-invalid·product-limited-qty-invalid), 남은 수 = 남은 수 + (새 수량 − 옛 수량)
describe('상품 유형과 속성 검사(BAT-600)', () => {
  const typeOf = (res: { payload: string }) => String(JSON.parse(res.payload).type);
  const row = (id: string) => store.rows.get(id)!;

  test('V-T46 ① MERCH·PARKING 판 1 스키마에 맞는 속성이면 만들어지고 schema_version이 1이다', async () => {
    const merch = await create(TENANT, { name: 'V-T46 굿즈', attributes: { perAccountLimit: 2, options: [{ name: '사이즈', values: ['S', 'M'] }] } });
    expect(merch.statusCode).toBe(201);
    expect(row(JSON.parse(merch.payload).productId).schemaVersion).toBe(1);
    const parking = await create(TENANT, { name: 'V-T46 주차권', type: 'PARKING', fulfillments: ['WALLET'], attributes: { vehicleNotice: '경차는 지하 2층' } });
    expect(parking.statusCode).toBe(201);
    const p = row(JSON.parse(parking.payload).productId);
    expect(p.schemaVersion).toBe(1);
    expect(p.type).toBe('PARKING');
  });

  test('V-T46 ① 표에 없는 유형과 꺼진 유형은 422 product-type-invalid이고 행이 생기지 않는다', async () => {
    types.rows.set('VIP', { code: 'VIP', latestSchemaVersion: 1, enabled: false });
    const before = store.rows.size;
    for (const type of ['VIP', 'FOOD', 'merch']) {
      const res = await create(TENANT, { name: `유형 ${type}`, type, attributes: {} });
      expect(res.statusCode, type).toBe(422);
      expect(typeOf(res), type).toContain('product-type-invalid');
    }
    expect(store.rows.size).toBe(before);
  });

  test('V-T46 ① 모르는 칸·옵션 11개·perAccountLimit 0과 100은 422 product-attributes-invalid이고 경계 1·99와 옵션 10개는 통과한다', async () => {
    const before = store.rows.size;
    const opt = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `옵션${i + 1}`, values: ['가'] }));
    const bad: Record<string, unknown>[] = [{ color: '인디고' }, { options: opt(11) }, { perAccountLimit: 0 }, { perAccountLimit: 100 }, { options: '인디고' }, { vehicleNotice: '안내' }];
    for (const attributes of bad) {
      const res = await create(TENANT, { name: '속성 틀림', attributes });
      expect(res.statusCode, JSON.stringify(attributes)).toBe(422);
      expect(typeOf(res)).toContain('product-attributes-invalid');
    }
    expect(store.rows.size).toBe(before);
    for (const attributes of [{ perAccountLimit: 1 }, { perAccountLimit: 99 }, { options: opt(10) }, { perAccountLimit: null }]) {
      const res = await create(TENANT, { name: '경계 통과', attributes });
      expect(res.statusCode, JSON.stringify(attributes)).toBe(201);
    }
  });

  test('V-T46 ① 유형 표의 최신 판이 스키마 묶음에 없으면(판 10) 422 product-attributes-invalid다', async () => {
    types.rows.set('PARKING', { code: 'PARKING', latestSchemaVersion: 10, enabled: true });
    try {
      const res = await create(TENANT, { name: '판 10 주차권', type: 'PARKING', fulfillments: ['WALLET'], attributes: {} });
      expect(res.statusCode).toBe(422);
      expect(typeOf(res)).toContain('product-attributes-invalid');
    } finally {
      types.rows.set('PARKING', { code: 'PARKING', latestSchemaVersion: 1, enabled: true });
    }
  });

  test('V-T46 ② 맞게 만든 상품을 고쳐 속성을 깨면 422이고 행이 그대로다', async () => {
    const p = JSON.parse((await create(TENANT, { name: '고치기 전', attributes: { perAccountLimit: 2 } })).payload);
    const before = structuredClone(row(p.productId));
    for (const attributes of [{ perAccountLimit: 100 }, { unknown: 1 }]) {
      const res = await patch(p.productId, { attributes, name: '고친 이름' }, '"1"');
      expect(res.statusCode, JSON.stringify(attributes)).toBe(422);
      expect(typeOf(res)).toContain('product-attributes-invalid');
    }
    expect(row(p.productId)).toEqual(before);
  });

  test('V-T46 ② 고치기는 합친 속성을 통째로 다시 검사한다(속성을 건드리지 않고 이름만 고쳐도 옛 행의 틀린 속성이면 422)', async () => {
    const p = JSON.parse((await create(TENANT, { name: '옛 행' })).payload);
    // 스키마 전에 저장된 행처럼 틀린 속성을 직접 넣는다
    store.rows.set(p.productId, { ...row(p.productId), attributes: { options: '인디고' } });
    const before = structuredClone(row(p.productId));
    const res = await patch(p.productId, { name: '이름만 고침' }, '"1"');
    expect(res.statusCode).toBe(422);
    expect(typeOf(res)).toContain('product-attributes-invalid');
    expect(row(p.productId)).toEqual(before);
  });

  test('V-T46 ② 맞게 고치면 200이고 schema_version을 최신 판으로 적는다', async () => {
    const p = JSON.parse((await create(TENANT, { name: '판 다시 적기' })).payload);
    store.rows.set(p.productId, { ...row(p.productId), schemaVersion: 0 });
    const res = await patch(p.productId, { attributes: { perAccountLimit: 3 } }, '"1"');
    expect(res.statusCode).toBe(200);
    expect(row(p.productId).schemaVersion).toBe(1);
    expect(row(p.productId).attributes).toEqual({ perAccountLimit: 3 });
  });

  test('P-T56 ⑧ 1개 팔린 뒤 한정 수량을 3에서 2로 고치면 남은 수가 1이고 재고 카운터 키가 지워진다', async () => {
    const p = JSON.parse((await create(TENANT, { name: '한정 3', limitedQty: 3 })).payload);
    store.rows.get(p.productId)!.stock = 2; // 1개 팔림
    stock.setCounter(p.productId, 2);
    const res = await patch(p.productId, { limitedQty: 2 }, '"1"');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toMatchObject({ stockRemaining: 1, stockTotal: 2 });
    expect(row(p.productId).stock).toBe(1);
    expect(stock.slots.get(p.productId)?.stock).toBeUndefined();
  });

  test('P-T56 ⑧ 남은 수 식의 결과가 0이면 통과한다(경계)', async () => {
    const p = JSON.parse((await create(TENANT, { name: '한정 3 경계 0', limitedQty: 3 })).payload);
    store.rows.get(p.productId)!.stock = 2;
    const res = await patch(p.productId, { limitedQty: 1 }, '"1"');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toMatchObject({ stockRemaining: 0, stockTotal: 1 });
  });

  test('P-T56 ⑧ 2개 팔린 뒤 0으로(결과 −2), 1개 팔린 뒤 0으로(결과 −1) 고치면 422 product-limited-qty-invalid이고 남은 수·카운터가 그대로다', async () => {
    for (const [sold, remaining] of [
      [2, 1],
      [1, 2],
    ] as const) {
      const p = JSON.parse((await create(TENANT, { name: `한정 3 ${sold}개 팔림`, limitedQty: 3 })).payload);
      store.rows.get(p.productId)!.stock = remaining;
      stock.setCounter(p.productId, remaining);
      const before = structuredClone(row(p.productId));
      const res = await patch(p.productId, { limitedQty: 0 }, '"1"');
      expect(res.statusCode, `${sold}개 팔림`).toBe(422);
      expect(typeOf(res)).toContain('product-limited-qty-invalid');
      expect(row(p.productId)).toEqual(before);
      expect(stock.slots.get(p.productId)?.stock).toBe(remaining);
    }
  });

  test('P-T56 ⑧ 한정 수량을 늘리면 남은 수에 늘린 만큼 더한다(덮어쓰지 않는다)', async () => {
    const p = JSON.parse((await create(TENANT, { name: '한정 3 늘리기', limitedQty: 3 })).payload);
    store.rows.get(p.productId)!.stock = 1; // 2개 팔림
    const res = await patch(p.productId, { limitedQty: 5 }, '"1"');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toMatchObject({ stockRemaining: 3, stockTotal: 5 });
  });
});
