// 관제 판매 승인 목록·상세·반려와 파트너 요청·현황·변경 취소를 실제 PostgreSQL 0034 권한으로 한 번 돈다(S-T41 ①③④⑤, BAT-616 RV-03·RV-04).
// HTTP 시험은 메모리 저장소라 Drizzle 경로와 core_partner·core_ops 열 권한, 커서의 ::uuid 캐스트를 보지 못한다. 여기서 그 길을 지난다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type Clock, createDatabase, createService, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { FakeIdentity, quiet, testMedia } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

const NOW = Date.parse('2026-11-21T00:00:00Z');
const clock: Clock = { now: () => NOW, monotonicMs: () => performance.now() };
const identity = new FakeIdentity();
const TENANT = randomUUID();
const PLACE = randomUUID();
const SELLER = {
  legalName: '(주)실제디비공연',
  representative: '김대표',
  address: '서울 실제로 1',
  phone: '02-9000-0001',
  email: 'db-seller@example.test',
  businessRegNo: '987-65-43210',
  mailOrderReportNo: '2026-서울-4321',
};

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let opsDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-sale-review-db-it', max: 4 });
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  opsDb = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 4);
  await admin.db.insert(promoter).values({ id: TENANT, legalName: '(주)피켓공연' });
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  svc = await createService({
    name: 'core-svc-sale-review-db',
    module: AppModule.register({ database: appDb, notifyDatabase: appDb, partnerDatabase: partnerDb, opsDatabase: opsDb, media: testMedia() }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 240_000);

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  await Promise.allSettled([appDb?.close(), partnerDb?.close(), opsDb?.close(), admin?.close()]);
  pg?.stop();
});

const partnerAdmin = () => identity.partner(TENANT, 'partner_admin');
const opsViewer = () => identity.ops('viewer');
const problem = (r: { payload: string }) => JSON.parse(r.payload) as { type: string; status: number; title: string };

const request = (headers: Record<string, string>, productionId: string) =>
  svc.http.inject({ method: 'POST', url: `/v1/partner/productions/${productionId}/sale-review`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ seller: SELLER, payoutAccount: { bankCode: '004', accountNumber: '1002-345-678901', holderName: '홍길동' }, accessibleSeating: { confirmed: true } }) });
const cancel = (headers: Record<string, string>, productionId: string) => svc.http.inject({ method: 'DELETE', url: `/v1/partner/productions/${productionId}/sale-review`, headers });
const partnerStatus = (headers: Record<string, string>, productionId: string) => svc.http.inject({ method: 'GET', url: `/v1/partner/productions/${productionId}/sale-review`, headers });
const list = (headers: Record<string, string>, q = '') => svc.http.inject({ method: 'GET', url: `/v1/ops/sale-reviews${q}`, headers });
const detail = (headers: Record<string, string>, productionId: string) => svc.http.inject({ method: 'GET', url: `/v1/ops/sale-reviews/${productionId}`, headers });
const rejection = (headers: Record<string, string>, productionId: string, body: unknown) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/sale-reviews/${productionId}/rejections`, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });

/** 실제 DB에 공연 하나와 비취소 회차 하나를 넣는다. 요청·목록·상세·반려가 모두 이 행을 쓴다 */
async function makeProduction(
  o: {
    saleReview?: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
    approvedAt?: Date | null;
    submittedAt?: Date | null;
    createdAt?: Date;
    cancelled?: boolean;
    placeId?: string | null;
    requestedPlace?: { name: string; address: string };
  } = {},
) {
  const productionId = randomUUID();
  const title = `겨울 콘서트-${productionId.slice(0, 8)}`;
  await admin.db.insert(production).values({
    id: productionId,
    promoterId: TENANT,
    placeId: o.placeId === undefined ? PLACE : o.placeId,
    ...(o.requestedPlace !== undefined ? { requestedPlace: o.requestedPlace } : {}),
    title,
    genre: '콘서트',
    saleReview: o.saleReview ?? 'DRAFT',
    ...(o.approvedAt !== undefined ? { saleApprovedAt: o.approvedAt } : {}),
    ...(o.submittedAt !== undefined ? { saleSubmittedAt: o.submittedAt } : {}),
    ...(o.createdAt !== undefined ? { createdAt: o.createdAt } : {}),
  });
  const eventId = randomUUID();
  const startsAt = new Date('2026-12-20T10:00:00.000Z');
  await admin.db.insert(event).values({
    id: eventId,
    productionId,
    promoterId: TENANT,
    openAt: new Date(startsAt.getTime() - 3 * 86_400_000),
    startsAt,
    endsAt: new Date(startsAt.getTime() + 2 * 3_600_000),
    perPersonLimit: 4,
    version: 1,
  });
  if (o.cancelled) {
    await admin.db.insert(event).values({
      id: randomUUID(),
      productionId,
      promoterId: TENANT,
      openAt: new Date(startsAt.getTime() - 2 * 86_400_000),
      startsAt: new Date(startsAt.getTime() + 86_400_000),
      endsAt: new Date(startsAt.getTime() + 86_400_000 + 2 * 3_600_000),
      perPersonLimit: 4,
      version: 1,
      status: 'CANCELLED',
    });
  }
  return { productionId, eventId, title };
}

async function productionRow(productionId: string) {
  const r = await admin.pool.query('select sale_review, sale_submitted_at, rejection_reason from production where id = $1', [productionId]);
  return r.rows[0] as { sale_review: string; sale_submitted_at: Date | null; rejection_reason: string | null };
}

describe('관제 판매 승인 실제 PostgreSQL 경로(S-T41 ①③④⑤)', () => {
  test('S-T41 ①⑤_ core_partner가 판매자 정보를 쓰고 core_ops가 목록·상세를 읽는다(목록은 연락처·사업자번호 0건, 상세는 판매자 정보)', async () => {
    const p = await makeProduction();
    const r = await request(partnerAdmin(), p.productionId);
    expect(r.statusCode).toBe(202);
    expect(JSON.parse(r.payload)).toEqual({ status: 'SUBMITTED' });

    const row = await productionRow(p.productionId);
    expect(row.sale_review).toBe('SUBMITTED');
    expect(row.sale_submitted_at).not.toBeNull();
    expect(row.rejection_reason).toBeNull();

    const seller = (await admin.pool.query('select legal_name, representative, address, phone, email, business_reg_no, mail_order_report_no, exemption_basis, verified_at from promoter where id = $1', [TENANT])).rows[0] as Record<string, unknown>;
    expect(seller).toMatchObject({
      legal_name: SELLER.legalName,
      representative: SELLER.representative,
      address: SELLER.address,
      phone: SELLER.phone,
      email: SELLER.email,
      business_reg_no: SELLER.businessRegNo,
      mail_order_report_no: SELLER.mailOrderReportNo,
      exemption_basis: null,
      verified_at: null,
    });
    // 계좌 모양만 보고 저장하지 않는다(지급대행 연동 전, LCH-110)
    const stored = JSON.stringify((await admin.pool.query('select * from promoter where id = $1', [TENANT])).rows);
    expect(stored).not.toContain('1002-345-678901');
    expect(stored).not.toContain('홍길동');

    const s = await partnerStatus(partnerAdmin(), p.productionId);
    expect(s.statusCode).toBe(200);
    expect(s.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(s.payload)).toMatchObject({ saleReview: 'SUBMITTED', rejectionReason: null, seller: { legalName: SELLER.legalName, phone: SELLER.phone } });

    const l = await list(opsViewer(), '?status=SUBMITTED&limit=100');
    expect(l.statusCode).toBe(200);
    expect(l.headers['cache-control']).toBe('no-store');
    const items = JSON.parse(l.payload).items as { productionId: string; promoterName: string }[];
    const item = items.find((x) => x.productionId === p.productionId);
    expect(item?.promoterName).toBe(SELLER.legalName);
    expect(item).not.toHaveProperty('seller');
    expect(l.payload).not.toContain(SELLER.phone);
    expect(l.payload).not.toContain(SELLER.businessRegNo);

    const d = await detail(opsViewer(), p.productionId);
    expect(d.statusCode).toBe(200);
    expect(d.headers['cache-control']).toBe('no-store');
    const out = JSON.parse(d.payload) as { seller: Record<string, unknown>; events: { eventId: string }[]; rejectionReason: string | null };
    expect(out.seller).toMatchObject({ legalName: SELLER.legalName, representative: SELLER.representative, phone: SELLER.phone, businessRegNo: SELLER.businessRegNo });
    expect(out.events.map((e) => e.eventId)).toEqual([p.eventId]);
    expect(out.rejectionReason).toBeNull();
  });

  test('S-T41 ⑤⑫ 상세는 등록 공연장·휠체어 확인·취소 회차를 주고, 새 공연장 요청은 요청 이름을 준다(RV-06)', async () => {
    const p = await makeProduction({ cancelled: true });
    const before = await request(partnerAdmin(), p.productionId);
    expect(before.statusCode).toBe(202);
    const d = await detail(opsViewer(), p.productionId);
    expect(d.statusCode).toBe(200);
    const out = JSON.parse(d.payload) as {
      title: string;
      placeId: string | null;
      placeName: string | null;
      requestedPlace: boolean;
      accessibleSeatingCheck: boolean | null;
      events: { eventId: string; status: string }[];
    };
    expect(out).toMatchObject({ title: p.title, placeId: PLACE, placeName: '피켓홀', requestedPlace: false, accessibleSeatingCheck: true });
    expect(out.events.map((e) => e.status).sort()).toEqual(['CANCELLED', 'SCHEDULED']);

    const partner = JSON.parse((await partnerStatus(partnerAdmin(), p.productionId)).payload) as { title: string };
    expect(partner.title).toBe(p.title);

    const requested = await makeProduction({ saleReview: 'SUBMITTED', submittedAt: new Date(NOW), placeId: null, requestedPlace: { name: '새 공연장', address: '서울 새로 2' } });
    const rd = JSON.parse((await detail(opsViewer(), requested.productionId)).payload) as { placeId: string | null; placeName: string | null; requestedPlace: boolean };
    expect(rd).toMatchObject({ placeId: null, placeName: '새 공연장', requestedPlace: true });
  });

  test('S-T41 ⑤ RV-06 제출·승인 시각이 없는 SUBMITTED 목록은 created_at 차례로 온다', async () => {
    const older = await makeProduction({ saleReview: 'SUBMITTED', submittedAt: null, createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const newer = await makeProduction({ saleReview: 'SUBMITTED', submittedAt: null, createdAt: new Date('2026-01-02T00:00:00.000Z') });
    const r = await list(opsViewer(), '?status=SUBMITTED&limit=100');
    expect(r.statusCode).toBe(200);
    const ids = (JSON.parse(r.payload).items as { productionId: string }[]).map((x) => x.productionId);
    expect(ids.indexOf(older.productionId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(newer.productionId)).toBeGreaterThan(ids.indexOf(older.productionId));
  });

  test('S-T41 ④_ core_ops 반려가 rejection_reason을 실제 DB에 남기고 상세·파트너 현황이 같은 사유를 읽는다', async () => {
    const p = await makeProduction();
    expect((await request(partnerAdmin(), p.productionId)).statusCode).toBe(202);
    const reason = '사업자등록증 사본과 통신판매업 신고번호를 확인해 주세요';
    const r = await rejection(identity.ops('operator'), p.productionId, { reason });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ applied: true });

    const row = await productionRow(p.productionId);
    expect(row.sale_review).toBe('REJECTED');
    expect(row.rejection_reason).toBe(reason);

    expect((JSON.parse((await detail(opsViewer(), p.productionId)).payload) as { rejectionReason: string | null }).rejectionReason).toBe(reason);
    expect((JSON.parse((await partnerStatus(partnerAdmin(), p.productionId)).payload) as { rejectionReason: string | null }).rejectionReason).toBe(reason);
  });

  test('S-T41 ③_ core_partner 변경 취소가 실제 DB에서 pending·제출 시각·사유를 비우고 APPROVED로 돌린다', async () => {
    const p = await makeProduction({ saleReview: 'SUBMITTED', approvedAt: new Date(NOW - 86_400_000), submittedAt: new Date(NOW) });
    await admin.pool.query(`update production set rejection_reason = null where id = $1`, [p.productionId]);
    const r = await cancel(partnerAdmin(), p.productionId);
    expect(r.statusCode).toBe(204);
    const row = await productionRow(p.productionId);
    expect(row.sale_review).toBe('APPROVED');
    expect(row.sale_submitted_at).toBeNull();
    expect(row.rejection_reason).toBeNull();
  });

  test('S-T41 ⑤_ Drizzle 목록도 잘못된 커서 UUID·반복 쿼리·limit 밖을 400으로 막고, 참 커서는 ::uuid 캐스트를 지난다', async () => {
    for (const q of ['?status=SUBMITTED&limit=1', '?status=SUBMITTED&limit=2']) await request(partnerAdmin(), (await makeProduction()).productionId);

    const nonUuid = Buffer.from(JSON.stringify(['2026-11-20T00:00:00.000Z', 'x'])).toString('base64url');
    const badTime = Buffer.from(JSON.stringify(['언젠가', randomUUID()])).toString('base64url');
    const cases = [
      `?cursor=${nonUuid}`,
      `?cursor=${badTime}`,
      '?cursor=not-a-cursor',
      '?status=SUBMITTED&status=REJECTED',
      '?limit=1&limit=2',
      '?limit=0',
      '?limit=101',
      '?unknown=1',
    ];
    for (const q of cases) {
      const r = await list(opsViewer(), q);
      expect({ q, status: r.statusCode }).toEqual({ q, status: 400 });
      expect(problem(r).status, q).toBe(400);
    }

    const page1 = await list(opsViewer(), '?status=SUBMITTED&limit=1');
    expect(page1.statusCode).toBe(200);
    const first = JSON.parse(page1.payload) as { items: { productionId: string }[]; nextCursor: string | null };
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const page2 = await list(opsViewer(), `?status=SUBMITTED&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(page2.statusCode).toBe(200);
    const second = JSON.parse(page2.payload) as { items: { productionId: string }[] };
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.productionId).not.toBe(first.items[0]!.productionId);
  });
});
