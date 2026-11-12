// 받는 층: 좌석맵 템플릿 목록·하나·템플릿에서 만들기(openapi, ADR-0066, ADR-0264 결정 17·43·44). 메모리 저장소로 계약 응답과 판정 차례를 본다.
import 'reflect-metadata';
import { GetPartnerSeatmapTemplateResponse, GetPartnerSeatmapTemplatesResponse, CreatePartnerProductionSeatmapResponse } from '@peaket/contracts/openapi/partner';
import { createService } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, StaticTemplateCatalog } from '../src/modules/catalog/index.js';
import { templateLayout } from '../src/modules/catalog/domain/seatmap-templates.js';
import { FakeIdentity, testMedia } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const catalog = StaticTemplateCatalog.load(fileURLToPath(new URL('../seed/seatmap-templates/', import.meta.url)));
const TENANT = randomUUID();
const OTHER = randomUUID();
const P = 'https://peaket.example/problems/';

beforeAll(async () => {
  for (const t of catalog.definitions()) repo.templates.set(t.templateId, { doc: templateLayout(t, t.defaultCapacity)! as never, published: true });
  svc = await createService({ name: 'core-svc', module: AppModule.register({ memory: true, catalog: repo, media: testMedia({ templates: catalog }) }), env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' }, adminAuthz: identity });
});
afterAll(async () => {
  await svc?.close();
});

function seed(o: { tenant?: string; approved?: boolean } = {}) {
  const productionId = randomUUID();
  repo.productions.set(productionId, {
    id: productionId,
    promoterId: o.tenant ?? TENANT,
    placeId: randomUUID(),
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: o.approved ? 'APPROVED' : 'DRAFT',
    saleApprovedAt: o.approved ? new Date('2026-11-01T00:00:00Z') : null,
  });
  return productionId;
}
const first = catalog.list().find((x) => x.code === 'ARENA-END')!;
const url = (id: string) => `/v1/partner/productions/${id}/seatmap`;
const create = (id: string, body: unknown, h = identity.partner(TENANT, 'partner_admin')) =>
  svc.http.inject({ method: 'POST', url: url(id), headers: { ...h, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

describe('좌석맵 템플릿(메모리)', () => {
  test('S-T40 ① 목록은 10종이고 하나는 도형·fillRule·등급 기본값을 주며 좌석이 없다 [ASVS v5.0.0-3.5.3]', async () => {
    const list = await svc.http.inject({ method: 'GET', url: '/v1/partner/seatmap-templates', headers: identity.partner(TENANT, 'partner_member') });
    expect(list.statusCode).toBe(200);
    expect(GetPartnerSeatmapTemplatesResponse.safeParse(json(list)).success).toBe(true);
    expect((json(list).items as unknown[]).length).toBe(10);
    const one = await svc.http.inject({ method: 'GET', url: `/v1/partner/seatmap-templates/${first.templateId}`, headers: identity.partner(TENANT) });
    expect(one.statusCode).toBe(200);
    expect(GetPartnerSeatmapTemplateResponse.safeParse(json(one)).success).toBe(true);
    const layout = json(one).layout as { sections: { seats: unknown[]; fillRule: { targetCount: number } }[]; priceTiers: unknown[] };
    expect(layout.sections.every((s) => s.seats.length === 0)).toBe(true);
    expect(layout.sections.reduce((n, s) => n + s.fillRule.targetCount, 0)).toBe(first.defaultCapacity);
    expect(layout.priceTiers).toHaveLength(3);
  });

  test('S-T40 ② 템플릿에서 만들기는 201이고 구역 fillRule 목표 합이 목표와 같으며 좌석이 0개다', async () => {
    const id = seed();
    const r = await create(id, { templateId: first.templateId, targetCapacity: 1000 });
    expect(r.statusCode).toBe(201);
    expect(CreatePartnerProductionSeatmapResponse.safeParse(json(r)).success).toBe(true);
    const layout = json(r) as { sections: { seats: unknown[]; fillRule: { targetCount: number } }[] };
    expect(layout.sections.reduce((n, s) => n + s.fillRule.targetCount, 0)).toBe(1000);
    expect(layout.sections.every((s) => s.seats.length === 0)).toBe(true);
  });

  test('좌석이 있으면 replace 없이는 409 replace-required, replace면 201이다', async () => {
    const id = seed();
    expect((await create(id, { templateId: first.templateId, targetCapacity: 800 })).statusCode).toBe(201);
    // 좌석이 없는 템플릿 배치본이라 한 번 더 만들기는 replace 없이도 된다. 좌석을 넣은 뒤 본다
    const withSeats = seed();
    expect((await create(withSeats, { templateId: first.templateId, targetCapacity: 800 })).statusCode).toBe(201);
    const row = repo.layouts.get(withSeats)!;
    row.rows = { version: 1, doc: { ...row.rows!.doc, sections: row.rows!.doc.sections.map((s, i) => (i === 0 ? { ...s, seats: [{ seatId: randomUUID(), index: 0, row: '1', number: 1, x: 10, y: 10 }] } : s)) } };
    const blocked = await create(withSeats, { templateId: first.templateId, targetCapacity: 800 });
    expect([blocked.statusCode, json(blocked).type]).toEqual([409, `${P}seatmap-replace-required`]);
    expect((await create(withSeats, { templateId: first.templateId, targetCapacity: 800, replace: true })).statusCode).toBe(201);
  });

  test('다른 테넌트 404, 승인 이력 실무자 403, 범위 밖 변형·작은 목표 422다 [ASVS v5.0.0-2.2.2]', async () => {
    const id = seed();
    expect((await create(id, { templateId: first.templateId, targetCapacity: 1000 }, identity.partner(OTHER))).statusCode).toBe(404);
    const approved = seed({ approved: true });
    expect((await create(approved, { templateId: first.templateId, targetCapacity: 1000 }, identity.partner(TENANT, 'partner_member'))).statusCode).toBe(403);
    expect((await create(id, { templateId: first.templateId, targetCapacity: 1000, variant: { thrustCm: 9999 } })).statusCode).toBe(422);
    expect((await create(id, { templateId: first.templateId, targetCapacity: 1 })).statusCode).toBe(422);
  });
});
