// 받는 층: 찜(openapi putProductionWish·deleteProductionWish, ADR-0198 결정 5, BUILD_ORDER HOT-171)
import 'reflect-metadata';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, type SaleReview } from '../src/modules/catalog/index.js';
import { WISH_LIMIT } from '../src/modules/catalog/domain/registration.js';
import { FakeIdentity, fan, NOW_MS, quiet } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const clock: FakeClock = fakeClock({ now: NOW_MS });

beforeAll(async () => {
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, catalog: repo }), env: { PEAKET_ENV: 'ci' }, clock, logDestination: quiet(), adminAuthz: new FakeIdentity() });
});
afterAll(async () => {
  await svc?.close();
});

function production(saleReview: SaleReview = 'APPROVED', saleApprovedAt: Date | null = new Date('2026-11-01T00:00:00Z')): string {
  const id = randomUUID();
  repo.productions.set(id, { id, promoterId: randomUUID(), placeId: randomUUID(), title: '공연', genre: '콘서트', saleReview, saleApprovedAt });
  return id;
}
const put = (h: Record<string, string>, id: string) => svc.http.inject({ method: 'PUT', url: `/v1/productions/${id}/wish`, headers: h });
const del = (h: Record<string, string>, id: string) => svc.http.inject({ method: 'DELETE', url: `/v1/productions/${id}/wish`, headers: h });

describe('찜', () => {
  test('공개공연을찜하면204이고_다시보내도처음찜한시각을둔다', async () => {
    const me = randomUUID();
    const id = production();
    expect((await put(fan(me), id)).statusCode).toBe(204);
    const first = repo.wishes.get(me)?.get(id);
    clock.advance(60_000);
    expect((await put(fan(me), id)).statusCode).toBe(204);
    expect(repo.wishes.get(me)?.get(id)).toEqual(first);
  });

  test('판매승인전·판매중지·없는공연은_404다', async () => {
    const h = fan();
    expect((await put(h, production('DRAFT', null))).statusCode).toBe(404);
    expect((await put(h, production('SUSPENDED'))).statusCode).toBe(404);
    expect((await put(h, randomUUID())).statusCode).toBe(404);
  });

  test('[ASVS v5.0.0-2.4.1] 계정마다상한을넘으면_422 wish-limit이고_이미한찜은그대로204다', async () => {
    const me = randomUUID();
    const mine = new Map<string, Date>();
    for (let i = 0; i < WISH_LIMIT; i++) mine.set(randomUUID(), new Date(NOW_MS));
    const had = production();
    mine.delete(mine.keys().next().value as string);
    mine.set(had, new Date(NOW_MS));
    repo.wishes.set(me, mine);
    const r = await put(fan(me), production());
    expect(r.statusCode).toBe(422);
    expect(JSON.parse(r.payload).type).toBe('https://peaket.example/problems/wish-limit');
    expect((await put(fan(me), had)).statusCode).toBe(204);
  });

  test('해제는_없어도204이고_내찜만지운다', async () => {
    const me = randomUUID();
    const other = randomUUID();
    const id = production();
    await put(fan(me), id);
    await put(fan(other), id);
    expect((await del(fan(me), id)).statusCode).toBe(204);
    expect((await del(fan(me), id)).statusCode).toBe(204);
    expect(repo.wishes.get(me)?.has(id)).toBe(false);
    expect(repo.wishes.get(other)?.has(id)).toBe(true);
  });

  test('로그인하지않으면_401이다', async () => {
    expect((await svc.http.inject({ method: 'PUT', url: `/v1/productions/${production()}/wish` })).statusCode).toBe(401);
  });
});
