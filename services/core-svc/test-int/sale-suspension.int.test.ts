// LCH-090 판매 중지·재개 core 트랜잭션 [PostgreSQL·실제 HTTP](BAT-620, ADR-0123, SR-T8 ③).
// 정본: docs/features/transfer-refund.md §2.1 '판매 중지와 재개', docs/features/control-tower.md §5 제어 상태 표,
// docs/features/search.md §2.3 '구현 자리'·§12 SR-T8 ③, docs/api/guidelines.md §4(문제 응답).
// 운영과 같은 DB 역할(core_app·core_partner·core_ops)로 띄운 서비스에 내부 토큰을 실어 실제 HTTP로 부른다.
// 검색 문서를 미리 심고, 중지가 같은 트랜잭션에서 검색을 지우며 커밋 뒤 CDN 검색 경로를 비우는지 본다. 되돌림은 커밋 자리 트리거로 끊는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { type Clock, createDatabase, createService, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { DrizzleSearchReadModel, MemoryCdnInvalidation } from '../src/modules/catalog/index.js';
import { FakeIdentity, quiet, testMedia } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

const H = 3_600_000;
const NOW = Date.parse('2026-11-22T03:00:00.000Z');
let now = NOW;
const clock: Clock = { now: () => now, monotonicMs: () => performance.now() };
const identity = new FakeIdentity();
const TENANT = randomUUID();
const PLACE = randomUUID();
const TOKEN = 'int-test-token-b620-suspension';

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let opsDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;
let sync: DrizzleSearchReadModel;
const cdn = new MemoryCdnInvalidation();
const lines: Record<string, unknown>[] = [];

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-sale-suspension-it', max: 4 });
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 4);
  opsDb = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 4);
  await admin.db.insert(promoter).values({ id: TENANT, legalName: '(주)피켓공연' });
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
  sync = new DrizzleSearchReadModel(admin);
  svc = await createService({
    name: 'core-svc-sale-suspension',
    module: AppModule.register({ database: appDb, notifyDatabase: appDb, partnerDatabase: partnerDb, opsDatabase: opsDb, media: testMedia({ cdn }) }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' },
    clock,
    logDestination: new Writable({
      write: (c, _e, cb) => {
        for (const l of String(c).split('\n')) {
          if (!l.trim()) continue;
          try {
            lines.push(JSON.parse(l) as Record<string, unknown>);
          } catch {
            // JSON이 아닌 줄은 버린다
          }
        }
        cb();
      },
    }),
    adminAuthz: identity,
  });
}, 240_000);

afterAll(async () => {
  delete process.env.PEAKET_INTERNAL_TOKEN;
  await svc?.close().catch(() => undefined);
  await Promise.allSettled([appDb?.close(), partnerDb?.close(), opsDb?.close(), admin?.close()]);
  pg?.stop();
});

const rows = async (text: string, values: unknown[] = []) => (await admin.pool.query(text, values)).rows as Record<string, unknown>[];
const docIds = async () => (await rows('select production_id from search_document')).map((r) => r.production_id as string);

interface Seeded {
  productionId: string;
  openEventId: string;
  futureEventId: string;
}
async function seeded(title: string): Promise<Seeded> {
  const productionId = randomUUID();
  await admin.db.insert(production).values({
    id: productionId,
    promoterId: TENANT,
    placeId: PLACE,
    title,
    genre: '콘서트',
    saleReview: 'APPROVED',
    saleApprovedAt: new Date(NOW - 30 * 24 * H),
    pendingRevision: { salePolicy: [{ kind: 'GENERAL' }] },
  });
  const openEventId = randomUUID();
  const futureEventId = randomUUID();
  await admin.db.insert(event).values({
    id: openEventId,
    productionId,
    promoterId: TENANT,
    venueId: null,
    openAt: new Date(NOW - 2 * H),
    startsAt: new Date(NOW + 30 * 24 * H),
    endsAt: new Date(NOW + 30 * 24 * H + 2 * H),
    perPersonLimit: 4,
    version: 1,
  });
  await admin.db.insert(event).values({
    id: futureEventId,
    productionId,
    promoterId: TENANT,
    venueId: null,
    openAt: new Date(NOW + 24 * H),
    startsAt: new Date(NOW + 32 * 24 * H),
    endsAt: new Date(NOW + 32 * 24 * H + 2 * H),
    perPersonLimit: 4,
    version: 1,
  });
  await admin.transaction((tx) => sync.sync(tx, [productionId], new Date(now)));
  expect(await docIds()).toContain(productionId);
  return { productionId, openEventId, futureEventId };
}

const headers = (token: string | null = TOKEN) => ({ 'content-type': 'application/json', ...(token === null ? {} : { 'x-peaket-internal-token': token }) });
const scope = (eventId: string, token: string | null = TOKEN) =>
  svc.http.inject({ method: 'GET', url: `/internal/v1/events/${eventId}/sale-review-scope`, headers: headers(token) });
const apply = (eventId: string, body: Record<string, unknown>, token: string | null = TOKEN) =>
  svc.http.inject({ method: 'POST', url: `/internal/v1/events/${eventId}/sale-review-result`, headers: headers(token), payload: JSON.stringify(body) });
const productionRow = async (productionId: string) =>
  (
    await rows(
      'select sale_review, suspended_at, suspension_reason_code, suspension_reason, suspension_approval_id, suspension_open_event_ids, pending_revision, sale_submitted_at, rejection_reason from production where id = $1',
      [productionId],
    )
  )[0] as Record<string, unknown>;
const removedLines = (productionId: string) => lines.filter((l) => l.event === 'search_removed' && l.productionId === productionId);

describe('LCH-090 판매 중지·재개 core 트랜잭션 [PostgreSQL·실제 HTTP]', () => {
  test('SR-T8 ③ 판매 중지는 같은 트랜잭션에서 검색 문서를 지우고 커밋 뒤 CDN 검색 경로와 공연 태그를 비운다', async () => {
    const p = await seeded('판매중지검색 공연');
    const s = await scope(p.openEventId);
    expect(s.statusCode).toBe(200);
    expect(JSON.parse(s.payload)).toEqual({ productionId: p.productionId, saleReview: 'APPROVED', eventIds: [p.openEventId, p.futureEventId] });

    const before = await productionRow(p.productionId);
    expect(before).toMatchObject({ sale_review: 'APPROVED', suspension_approval_id: null, pending_revision: { salePolicy: [{ kind: 'GENERAL' }] } });
    const pathCalls = cdn.pathCalls.length;
    const tagCalls = cdn.calls.length;

    const r = await apply(p.openEventId, { kind: 'SUSPENDED', approvalId: 'AP-STOP-1', reasonCode: 'SELLER_IDENTITY', reason: '판매자 신원 확인' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ status: 'APPLIED', productionId: p.productionId, eventIds: [p.openEventId, p.futureEventId], resumeEventIds: [] });

    // 같은 트랜잭션: 상태·사유·다시 열 목록이 남고, 기다리던 변경분·제출 시각·반려 사유는 거둔다
    expect(await productionRow(p.productionId)).toMatchObject({
      sale_review: 'SUSPENDED',
      suspension_reason_code: 'SELLER_IDENTITY',
      suspension_reason: '판매자 신원 확인',
      suspension_approval_id: 'AP-STOP-1',
      suspension_open_event_ids: [p.openEventId],
      pending_revision: null,
      sale_submitted_at: null,
      rejection_reason: null,
    });
    expect((await productionRow(p.productionId)).suspended_at).toBeInstanceOf(Date);

    // 검색 읽기 모델에서 빠지고, 커밋 뒤 CDN 검색 경로와 공연·회차 태그를 비운다
    expect(await docIds()).not.toContain(p.productionId);
    expect(cdn.pathCalls.slice(pathCalls)).toEqual([['/v1/search*']]);
    expect(cdn.calls.length).toBeGreaterThan(tagCalls);
    expect(cdn.calls.at(-1)).toEqual([`event:${p.openEventId}`, `event:${p.futureEventId}`, `production:${p.productionId}`]);
    expect(removedLines(p.productionId)).toEqual([expect.objectContaining({ reason: 'SALE_SUSPENDED', productionId: p.productionId })]);

    // 공개 요약은 판매 중지 안내(410)이고 검색 API에서도 사라진다
    const detail = await svc.http.inject({ method: 'GET', url: `/v1/events/${p.openEventId}` });
    expect(detail.statusCode).toBe(410);
    expect(JSON.parse(detail.payload)).toMatchObject({ type: 'https://peaket.example/problems/event-suspended' });
    const search = await svc.http.inject({ method: 'GET', url: '/v1/search?q=판매중지검색' });
    expect(JSON.parse(search.payload)).toMatchObject({ items: [] });
  });

  test('같은 승인 업무로 다시 내리면 200 UNCHANGED이고 검색 판·무효화가 늘지 않는다', async () => {
    const p = await seeded('판매중지멱등 공연');
    expect((await apply(p.openEventId, { kind: 'SUSPENDED', approvalId: 'AP-STOP-2', reasonCode: 'LEGAL_REQUEST', reason: '법원 요청' })).statusCode).toBe(200);
    const version = Number((await rows('select version from search_version where id = 1'))[0]!.version);
    const paths = cdn.pathCalls.length;
    const r = await apply(p.openEventId, { kind: 'SUSPENDED', approvalId: 'AP-STOP-2', reasonCode: 'LEGAL_REQUEST', reason: '법원 요청' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ status: 'UNCHANGED', productionId: p.productionId, eventIds: [p.openEventId, p.futureEventId], resumeEventIds: [] });
    expect(Number((await rows('select version from search_version where id = 1'))[0]!.version)).toBe(version);
    expect(cdn.pathCalls.length).toBe(paths);
  });

  test('R-T23 ④ 재개는 판매 중이던 회차만 다시 열고, 중지 동안 오픈 시각이 지난 회차는 열지 않는다', async () => {
    const p = await seeded('판매재개범위 공연');
    expect((await apply(p.openEventId, { kind: 'SUSPENDED', approvalId: 'AP-STOP-3', reasonCode: 'FRAUD_SUSPECTED', reason: '사기 의심' })).statusCode).toBe(200);
    // 중지 동안 두 번째 회차의 오픈 시각이 지난다
    now = NOW + 48 * H;
    const r = await apply(p.openEventId, { kind: 'RESUMED', approvalId: 'AP-RESUME-3' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ status: 'APPLIED', productionId: p.productionId, eventIds: [p.openEventId, p.futureEventId], resumeEventIds: [p.openEventId] });
    expect(await productionRow(p.productionId)).toMatchObject({
      sale_review: 'APPROVED',
      suspended_at: null,
      suspension_reason_code: null,
      suspension_reason: null,
      suspension_approval_id: null,
      suspension_open_event_ids: null,
    });
    expect(await docIds()).toContain(p.productionId);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/events/${p.openEventId}` })).statusCode).toBe(200);
    // core 공개 요약은 공연 단위라 오픈 시각이 지난 회차도 200이다. 판매가 열리지 않는 것은 ops가 그 회차에 RESUME을 보내지 않는 것으로 지킨다(executor 시험).
    expect((await svc.http.inject({ method: 'GET', url: `/v1/events/${p.futureEventId}` })).statusCode).toBe(200);
    // 검색은 다시 들어오고, 경로 무효화도 한 번 더 부른다(캐시에 남은 '없음'을 지운다)
    expect(cdn.pathCalls.at(-1)).toEqual(['/v1/search*']);
    now = NOW;
  });

  test('검색 쓰기가 실패하면 판매 중지 상태도 되돌려지고 무효화·search_removed가 0이다', async () => {
    const p = await seeded('판매중지되돌림 공연');
    const paths = cdn.pathCalls.length;
    await admin.pool.query(
      `create or replace function b620_fail_commit() returns trigger language plpgsql as $$ begin raise exception 'injected b620 search write failure'; end $$;
       create constraint trigger b620_fail_commit after delete on search_document deferrable initially deferred for each row when (old.production_id = '${p.productionId}') execute function b620_fail_commit();`,
    );
    try {
      const r = await apply(p.openEventId, { kind: 'SUSPENDED', approvalId: 'AP-STOP-4', reasonCode: 'OTHER', reason: '확인 필요' });
      expect(r.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await admin.pool.query('drop trigger if exists b620_fail_commit on search_document; drop function if exists b620_fail_commit();');
    }
    expect(await productionRow(p.productionId)).toMatchObject({ sale_review: 'APPROVED', suspension_approval_id: null, pending_revision: { salePolicy: [{ kind: 'GENERAL' }] } });
    expect(await docIds()).toContain(p.productionId);
    expect(cdn.pathCalls.length).toBe(paths);
    expect(removedLines(p.productionId)).toEqual([]);
    // 트리거를 치우면 같은 요청이 정상으로 빠진다(되돌림이 남긴 잠금·상태가 없다)
    expect((await apply(p.openEventId, { kind: 'SUSPENDED', approvalId: 'AP-STOP-4', reasonCode: 'OTHER', reason: '확인 필요' })).statusCode).toBe(200);
    expect(await productionRow(p.productionId)).toMatchObject({ sale_review: 'SUSPENDED', suspension_approval_id: 'AP-STOP-4' });
  });

  test('내부 토큰·회차·상태 경계: 토큰이 없으면 401, 없는 회차는 404, 이미 승인된 공연의 재개는 200 UNCHANGED, 초안 공연의 재개는 409다', async () => {
    const p = await seeded('판매중지경계 공연');
    expect((await scope(p.openEventId, null)).statusCode).toBe(401);
    expect((await apply(p.openEventId, { kind: 'SUSPENDED', approvalId: 'AP-X', reasonCode: 'OTHER', reason: 'x' }, null)).statusCode).toBe(401);
    expect((await scope(randomUUID())).statusCode).toBe(404);
    expect((await apply(randomUUID(), { kind: 'SUSPENDED', approvalId: 'AP-X', reasonCode: 'OTHER', reason: 'x' })).statusCode).toBe(404);
    // 이미 승인된 공연의 재개는 다시 부른 재시도로 보고 아무것도 바꾸지 않는다
    const again = await apply(p.openEventId, { kind: 'RESUMED', approvalId: 'AP-X' });
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.payload)).toEqual({ status: 'UNCHANGED', productionId: p.productionId, eventIds: [p.openEventId, p.futureEventId], resumeEventIds: [] });
    expect((await apply(p.openEventId, { kind: 'SUSPENDED', approvalId: 'AP-X', reasonCode: 'BORED', reason: 'x' })).statusCode).toBe(400);
    expect((await apply(p.openEventId, { kind: 'SUSPENDED', approvalId: 'AP-X', reasonCode: 'OTHER' })).statusCode).toBe(400);
    // 승인 이력이 없는 초안 공연은 내릴 수도, 재개할 수도 없다
    const draft = randomUUID();
    await admin.db.insert(production).values({ id: draft, promoterId: TENANT, placeId: PLACE, title: '초안 공연', genre: '콘서트', saleReview: 'DRAFT' });
    const draftEvent = randomUUID();
    await admin.db.insert(event).values({ id: draftEvent, productionId: draft, promoterId: TENANT, openAt: new Date(NOW + H), startsAt: new Date(NOW + 24 * H), endsAt: new Date(NOW + 26 * H), perPersonLimit: 4, version: 1 });
    const n = await apply(draftEvent, { kind: 'SUSPENDED', approvalId: 'AP-X', reasonCode: 'OTHER', reason: 'x' });
    expect(n.statusCode).toBe(409);
    expect(JSON.parse(n.payload)).toMatchObject({ type: 'https://peaket.example/problems/sale-suspension-conflict' });
    const nr = await apply(draftEvent, { kind: 'RESUMED', approvalId: 'AP-X' });
    expect(nr.statusCode).toBe(409);
    expect(JSON.parse(nr.payload)).toMatchObject({ type: 'https://peaket.example/problems/sale-suspension-conflict' });
  });
});
