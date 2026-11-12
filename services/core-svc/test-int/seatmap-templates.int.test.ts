// 좌석맵 템플릿·업무 경고 통합 시험(ADR-0066, ADR-0264 결정 15·17·43~45, BUILD_ORDER BAT-151).
// 실제 PostgreSQL 18 컨테이너에 템플릿 10종을 넣고, 실제 core-svc HTTP 앱(운영과 같은 권한의 DB 사용자)으로
// 목록·하나·템플릿에서 만들기·저장 경고·가져오기 경고를 잇는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CreatePartnerProductionSeatmapImportResponse,
  CreatePartnerProductionSeatmapResponse,
  GetPartnerSeatmapTemplateResponse,
  GetPartnerSeatmapTemplatesResponse,
  PutPartnerProductionSeatmapResponse,
} from '@peaket/contracts/openapi/partner';
import { createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter, section, venue } from '../src/modules/catalog/adapters/db/schema.js';
import { layoutVenueId } from '../src/modules/catalog/domain/seatmap-layout.js';
import type { CheckedLayout } from '../src/modules/catalog/domain/seatmap-import.js';
import { MemoryPublicFileStore, StaticTemplateCatalog } from '../src/modules/catalog/index.js';
import { seedSeatmapTemplates } from '../src/seed/seatmap-templates.js';
import { FakeIdentity, testMedia } from '../test/support.js';
import { logSink, multipart } from './media-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

type Svc = Awaited<ReturnType<typeof createService>>;

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let svc: Svc;
const logs = logSink();
const identity = new FakeIdentity();
const A = randomUUID();
const B = randomUUID();
const PLACE = randomUUID();
const P = 'https://peaket.example/problems/';
const templates = StaticTemplateCatalog.load(fileURLToPath(new URL('../seed/seatmap-templates/', import.meta.url)));
const first = templates.list().find((t) => t.code === 'ARENA-END')!;

const seatIds = Array.from({ length: 101 }, () => randomUUID());
const overlapLayout: CheckedLayout = {
  canvas: { width: 1000, height: 600 },
  sections: [
    {
      sectionId: 'A',
      name: 'A구역',
      tierId: 'R',
      shape: { kind: 'POLYGON', points: [[0, 0], [1000, 0], [1000, 600], [0, 600]] },
      seats: seatIds.map((seatId, i) => ({ seatId, row: '1', number: i + 1, x: 10, y: 10, tierId: 'R' })),
    },
  ],
  priceTiers: [{ tierId: 'R', name: 'R석', price: 1000 }],
};
/** 가져오기가 돌려줄 배치. 저장이 매긴 좌석 ID를 넣어 두 경로의 경고 좌석을 견준다 */
let parsed: CheckedLayout = overlapLayout;
const parser = { parse: async () => ({ status: 'PARSED' as const, layout: parsed, errors: [], ignored: [] }) };

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-test', max: 6 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 6);
  await admin.db.insert(promoter).values([
    { id: A, legalName: '(주)에이' },
    { id: B, legalName: '(주)비' },
  ]);
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  await seedSeatmapTemplates(admin, templates);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia({ templates, seatmap: parser, publicFiles: new MemoryPublicFileStore() }) }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' },
    logDestination: logs.stream,
    adminAuthz: identity,
  });
}, 180_000);

afterAll(async () => {
  await svc?.close();
  await appDb?.close();
  await partnerDb?.close();
  await admin?.close();
  pg?.stop();
});

interface Made {
  id: string;
  eventId: string;
}

/** 공연 하나와 회차 하나(관리자 연결로 넣는다). openAt이 지났으면 오픈 뒤 잠금을 본다 */
async function makeProduction(o: { tenant?: string; approved?: boolean; openAt?: Date } = {}): Promise<Made> {
  const tenant = o.tenant ?? A;
  const id = randomUUID();
  const eventId = randomUUID();
  await admin.db.insert(production).values({
    id,
    promoterId: tenant,
    placeId: PLACE,
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: o.approved ? 'APPROVED' : 'DRAFT',
    saleApprovedAt: o.approved ? new Date('2026-11-01T00:00:00Z') : null,
  });
  await admin.db.insert(event).values({
    id: eventId,
    productionId: id,
    promoterId: tenant,
    openAt: o.openAt ?? new Date('2026-11-20T11:00:00Z'),
    startsAt: new Date('2026-12-24T10:00:00Z'),
    endsAt: new Date('2026-12-24T12:30:00Z'),
    perPersonLimit: 4,
  });
  return { id, eventId };
}

const adminOf = (t = A) => identity.partner(t, 'partner_admin');
const memberOf = (t = A) => identity.partner(t, 'partner_member');
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const list = () => svc.http.inject({ method: 'GET', url: '/v1/partner/seatmap-templates', headers: memberOf() });
const one = (templateId: string) => svc.http.inject({ method: 'GET', url: `/v1/partner/seatmap-templates/${templateId}`, headers: memberOf() });
const create = (productionId: string, body: unknown, headers = adminOf()) =>
  svc.http.inject({ method: 'POST', url: `/v1/partner/productions/${productionId}/seatmap`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const put = (productionId: string, body: unknown, ifMatch: string, headers = adminOf()) =>
  svc.http.inject({ method: 'PUT', url: `/v1/partner/productions/${productionId}/seatmap`, headers: { ...headers, 'content-type': 'application/json', 'if-match': ifMatch }, payload: JSON.stringify(body) });
const getSeatmap = (productionId: string) => svc.http.inject({ method: 'GET', url: `/v1/partner/productions/${productionId}/seatmap`, headers: memberOf() });
const importFile = async (productionId: string) => {
  const { payload, contentType } = await multipart({ format: 'JSON' }, [{ name: 'seatmap.json', type: 'application/json', bytes: new TextEncoder().encode('{}') }]);
  return svc.http.inject({
    method: 'POST',
    url: `/v1/partner/productions/${productionId}/seatmap-imports`,
    headers: { ...memberOf(), 'content-type': contentType, 'x-requested-with': 'peaket-partner' },
    payload,
  });
};

describe('좌석맵 템플릿·경고(실제 DB)', () => {
  test('S-T40 ① 목록 10종과 하나의 도형·fillRule·등급 기본값을 계약 모양으로 준다', async () => {
    const r = await list();
    expect(r.statusCode).toBe(200);
    const out = GetPartnerSeatmapTemplatesResponse.parse(json(r));
    const items = out.items ?? [];
    expect(items).toHaveLength(10);
    expect(new Set(items.map((x) => x.code)).size).toBe(10);
    const t = await one(first.templateId);
    expect(t.statusCode).toBe(200);
    const detail = GetPartnerSeatmapTemplateResponse.parse(json(t));
    const layout = detail.layout as { sections: { seats: unknown[]; fillRule: { targetCount: number } }[]; priceTiers: unknown[] };
    expect(layout.sections.every((s) => s.seats.length === 0)).toBe(true);
    expect(layout.sections.reduce((n, s) => n + s.fillRule.targetCount, 0)).toBe(first.defaultCapacity);
    expect(layout.priceTiers).toHaveLength(3);
  });

  test('S-T40 ② 템플릿에서 만들기는 201이고 DB 배치본·구역·fillRule 목표가 맞는다', async () => {
    const p = await makeProduction();
    const r = await create(p.id, { templateId: first.templateId, targetCapacity: 1000 });
    expect(r.statusCode).toBe(201);
    const out = CreatePartnerProductionSeatmapResponse.parse(json(r));
    expect(out.layoutVersion).toBe(1);
    const sections = out.sections as unknown as { seats: unknown[]; fillRule: { targetCount: number } }[];
    expect(sections.reduce((n, s) => n + s.fillRule.targetCount, 0)).toBe(1000);
    expect(sections.every((s) => s.seats.length === 0)).toBe(true);
    const [layoutRow] = await admin.db.select().from(venue).where(eq(venue.id, layoutVenueId(p.id)));
    expect(layoutRow).toMatchObject({ kind: 'LAYOUT', promoterId: A, templateVenueId: first.templateId, layoutVersion: 1 });
    const rows = await admin.db.select().from(section).where(eq(section.venueId, layoutVenueId(p.id)));
    expect(rows).toHaveLength(first.sectionCount);
    expect((await getSeatmap(p.id)).statusCode).toBe(200);
  });

  test('S-T40 ② 좌석이 있으면 replace 없이는 409이고 replace면 다시 만들며, 오픈 뒤에는 409다', async () => {
    const p = await makeProduction();
    expect((await create(p.id, { templateId: first.templateId, targetCapacity: 800 })).statusCode).toBe(201);
    expect((await put(p.id, overlapLayout, '"1"')).statusCode).toBe(200);
    const blocked = await create(p.id, { templateId: first.templateId, targetCapacity: 800 });
    expect([blocked.statusCode, json(blocked).type]).toEqual([409, `${P}seatmap-replace-required`]);
    expect(json(blocked).existingSeatCount).toBe(101);
    expect((await create(p.id, { templateId: first.templateId, targetCapacity: 800, replace: true })).statusCode).toBe(201);

    const open = await makeProduction({ approved: true, openAt: new Date('2026-11-01T00:00:00Z') });
    const locked = await create(open.id, { templateId: first.templateId, targetCapacity: 800 });
    expect([locked.statusCode, json(locked).type]).toEqual([409, `${P}seatmap-geometry-locked`]);
  });

  test('S-T40 ② 다른 테넌트 404, 승인 이력 실무자 403, 범위 밖 변형·작은 목표 422다', async () => {
    const p = await makeProduction();
    expect((await create(p.id, { templateId: first.templateId, targetCapacity: 1000 }, adminOf(B))).statusCode).toBe(404);
    const approved = await makeProduction({ approved: true });
    expect((await create(approved.id, { templateId: first.templateId, targetCapacity: 1000 }, memberOf())).statusCode).toBe(403);
    expect((await create(p.id, { templateId: first.templateId, targetCapacity: 1000, variant: { thrustCm: 9999 } })).statusCode).toBe(422);
    expect((await create(p.id, { templateId: first.templateId, targetCapacity: 1 })).statusCode).toBe(422);
  });

  test('S-T40 ⑧ 저장 응답과 가져오기 결과의 warnings가 같은 코드·좌석이고 저장은 200으로 판이 오른다', async () => {
    const p = await makeProduction();
    const saved = await put(p.id, overlapLayout, '"0"');
    expect([saved.statusCode, saved.headers.etag]).toEqual([200, '"1"']);
    const savedOut = PutPartnerProductionSeatmapResponse.parse(json(saved));
    const savedWarnings = savedOut.warnings ?? [];
    const overlap = savedWarnings.find((w) => w.code === 'SEAT_OVERLAP')!;
    expect([overlap.seatCount, overlap.seatIds?.length]).toEqual([101, 100]);
    expect(savedWarnings.find((w) => w.code === 'W1')).toMatchObject({ seatCount: 0 });

    parsed = { canvas: savedOut.canvas, sections: savedOut.sections as unknown as CheckedLayout['sections'], priceTiers: savedOut.priceTiers };
    const imported = await importFile(p.id);
    expect(imported.statusCode).toBe(200);
    const out = CreatePartnerProductionSeatmapImportResponse.parse(json(imported));
    const importedWarnings = out.warnings ?? [];
    expect(importedWarnings.find((w) => w.code === 'SEAT_OVERLAP')).toMatchObject({ seatCount: overlap.seatCount, seatIds: overlap.seatIds });
    expect(importedWarnings.map((w) => w.code)).toEqual(savedWarnings.map((w) => w.code));
  });
});
