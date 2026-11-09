// 테넌트 표의 행 보안(2차 방어) 통합 시험(실제 PostgreSQL 18 컨테이너, AZ-T5, FR-021, docs/security/authz-matrix.md §5.3, ADR-0198 결정 8, ADR-0241, BUILD_ORDER HOT-172)
import 'reflect-metadata';
import { createDatabase, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { assertDatabaseRole } from '../src/modules/catalog/adapters/db/database-role.js';
import { event, place, production, productionArtist, promoter, searchAlias } from '../src/modules/catalog/adapters/db/schema.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

let pg: PostgresContainer;
let admin: Database;
let partner: Database;
let app: Database;
const A = randomUUID();
const B = randomUUID();
const PLACE = randomUUID();
const PROD_A = randomUUID();
const PROD_B = randomUUID();
const EVENT_A = randomUUID();
const EVENT_B = randomUUID();
const OPEN_B = new Date('2027-01-10T11:00:00Z');

const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-test', max: 2 });
  await ensureOutboxPartitions(admin, systemClock);
  // 연결 하나짜리 풀: 앞 트랜잭션의 SET LOCAL이 끝난 연결을 다시 쓰는 경우를 만든다
  partner = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 1);
  app = await loginFor(admin, pg, 'core_app_login', 'core_app', 2);
  await admin.db.insert(promoter).values([
    { id: A, legalName: '(주)에이' },
    { id: B, legalName: '(주)비' },
  ]);
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  await admin.db.insert(production).values([
    { id: PROD_A, promoterId: A, placeId: PLACE, title: 'A 공연', genre: '콘서트', saleReview: 'DRAFT' },
    { id: PROD_B, promoterId: B, placeId: PLACE, title: 'B 공연', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') },
  ]);
  const times = { startsAt: new Date('2027-02-01T10:00:00Z'), endsAt: new Date('2027-02-01T12:00:00Z') };
  await admin.db.insert(event).values([
    { id: EVENT_A, productionId: PROD_A, promoterId: A, venueId: randomUUID(), openAt: new Date('2027-01-05T11:00:00Z'), ...times },
    { id: EVENT_B, productionId: PROD_B, promoterId: B, venueId: randomUUID(), openAt: OPEN_B, ...times },
  ]);
});
afterAll(async () => {
  await partner?.close();
  await app?.close();
  await admin?.close();
  pg?.stop();
});

describe('AZ-T5 파트너 전용 DB 사용자', () => {
  test('[ASVS v5.0.0-8.4.1] 테넌트 조건을 뺀 조회도 자기 행만 준다', async () => {
    const seen = await partner.transaction(
      async (tx) => ({ p: await tx.select({ id: production.id }).from(production), e: await tx.select({ id: event.id }).from(event) }),
      { tenantId: A },
    );
    expect(seen.p.map((r) => r.id)).toEqual([PROD_A]);
    expect(seen.e.map((r) => r.id)).toEqual([EVENT_A]);
  });

  test('[ASVS v5.0.0-8.4.1] SET LOCAL 없이는 0건이다(앞 트랜잭션이 쓴 연결을 다시 써도 오류 없이)', async () => {
    await partner.transaction(async (tx) => tx.select({ id: production.id }).from(production), { tenantId: A });
    const after = await partner.transaction(async (tx) => tx.select({ id: production.id }).from(production));
    expect(after).toEqual([]);
    expect(await partner.db.select({ id: event.id }).from(event)).toEqual([]);
  });

  test('[ASVS v5.0.0-8.4.1] 다른 테넌트로 넣지 못하고 다른 테넌트의 행을 고치지 못한다', async () => {
    await expect(
      partner.transaction(async (tx) => tx.insert(production).values({ id: randomUUID(), promoterId: B, placeId: PLACE, title: '끼어들기', genre: '콘서트' }), { tenantId: A }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    const changed = await partner.transaction(async (tx) => tx.update(production).set({ pendingRevision: { marker: 'a' } }).where(sql`true`).returning({ id: production.id }), { tenantId: A });
    expect(changed.map((r) => r.id)).toEqual([PROD_A]);
    const [b] = await admin.db.select({ pending: production.pendingRevision }).from(production).where(sql`${production.id} = ${PROD_B}`);
    expect(b?.pending).toBeNull();
    await admin.db.update(production).set({ pendingRevision: null }).where(sql`${production.id} = ${PROD_A}`);
    const times = { startsAt: new Date('2027-02-01T10:00:00Z'), endsAt: new Date('2027-02-01T12:00:00Z') };
    await expect(
      partner.transaction(async (tx) => tx.insert(event).values({ id: randomUUID(), productionId: PROD_B, promoterId: B, venueId: randomUUID(), openAt: new Date('2027-01-06T11:00:00Z'), ...times }), { tenantId: A }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  test('[ASVS v5.0.0-8.4.1] 리뷰 재현: 파트너는 스스로 판매 승인을 올리거나 다른 칸을 고치지 못한다', async () => {
    const denied = async (fn: Parameters<Database['transaction']>[0]) => expect(partner.transaction(fn, { tenantId: A })).rejects.toMatchObject({ cause: { code: '42501' } });
    await denied(async (tx) => tx.update(production).set({ saleApprovedAt: new Date() }));
    await denied(async (tx) => tx.update(production).set({ promoterId: B }));
    await denied(async (tx) => tx.update(production).set({ title: '바꿈' }));
    await denied(async (tx) => tx.update(event).set({ status: 'CANCELLED' }));
  });

  test('[ASVS v5.0.0-8.4.1] 리뷰 재현: 코드가 쓰지 않는 표는 읽지 못한다(판매자 연락처, 승인 전 공연 별칭)', async () => {
    const denied = async (fn: Parameters<Database['transaction']>[0]) => expect(partner.transaction(fn, { tenantId: A })).rejects.toMatchObject({ cause: { code: '42501' } });
    await denied(async (tx) => tx.select({ id: promoter.id }).from(promoter));
    await denied(async (tx) => tx.select({ id: searchAlias.id }).from(searchAlias));
    await denied(async (tx) => tx.select({ id: productionArtist.artistId }).from(productionArtist));
  });

  test('[ASVS v5.0.0-8.4.1] 리뷰 재현: 임시 표로 함수의 대상을 바꿔치지 못한다', async () => {
    const out = await partner.transaction(
      async (tx) => {
        await tx.execute(sql.raw(`create temp table event (open_at timestamptz, production_id uuid, status text) on commit drop`));
        await tx.execute(sql.raw(`create temp table production (id uuid, sale_approved_at timestamptz, sale_review text) on commit drop`));
        return tx.execute(sql`select * from public_open_times(${'2027-01-01T00:00:00Z'}::timestamptz, ${'2027-02-01T00:00:00Z'}::timestamptz, ${PROD_A}::uuid)`);
      },
      { tenantId: A },
    );
    expect(rows<Record<string, unknown>>(out)).toHaveLength(1);
  });

  test('[ASVS v5.0.0-8.4.1] 다른 공연을 지우거나 판매자 표를 고칠 권한이 없다', async () => {
    await expect(partner.transaction(async (tx) => tx.delete(production), { tenantId: A })).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(partner.transaction(async (tx) => tx.update(promoter).set({ legalName: 'x' }), { tenantId: A })).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  test('오픈 간격 함수는 공개 공연의 오픈 시각만 준다(다른 칸은 볼 길이 없다)', async () => {
    const out = await partner.transaction(
      async (tx) => tx.execute(sql`select * from public_open_times(${'2027-01-01T00:00:00Z'}::timestamptz, ${'2027-02-01T00:00:00Z'}::timestamptz, ${PROD_A}::uuid)`),
      { tenantId: A },
    );
    const r = rows<Record<string, unknown>>(out);
    expect(r).toHaveLength(1);
    expect(Object.keys(r[0]!)).toEqual(['open_at']);
    expect(new Date(r[0]!.open_at as string).getTime()).toBe(OPEN_B.getTime());
  });
});

describe('AZ-T5 팬·관제 사용자와 권한', () => {
  test('[ASVS v5.0.0-8.4.1] 팬·관제 경로의 사용자는 테넌트 없이 전체를 본다', async () => {
    const p = await app.db.select({ id: production.id }).from(production);
    expect(p.map((r) => r.id).sort()).toEqual([PROD_A, PROD_B].sort());
  });

  test('[ASVS v5.0.0-8.4.1] 앱 사용자는 표 소유자가 아니고 BYPASSRLS가 없으며, 두 표의 행 보안이 켜져 있다', async () => {
    const roles = rows<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      await admin.db.execute(sql`select rolname, rolbypassrls, rolsuper from pg_roles where rolname in ('core_partner', 'core_app', 'core_partner_login', 'core_app_login') order by rolname`),
    );
    expect(roles).toHaveLength(4);
    for (const r of roles) expect([r.rolname, r.rolbypassrls, r.rolsuper]).toEqual([r.rolname, false, false]);
    const tables = rows<{ relname: string; owner: string; relrowsecurity: boolean }>(
      await admin.db.execute(sql`select c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity from pg_class c where c.relname in ('production', 'event') and c.relkind = 'r' order by c.relname`),
    );
    expect(tables.map((t) => t.relrowsecurity)).toEqual([true, true]);
    for (const t of tables) expect(['core_partner', 'core_app', 'core_partner_login', 'core_app_login']).not.toContain(t.owner);
  });

  test('[ASVS v5.0.0-8.4.1] 리뷰 재현: 팬·관제 사용자는 찜 말고는 쓰지 못한다', async () => {
    await expect(app.db.update(production).set({ title: '바꿈' })).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(app.db.delete(event)).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  test('[ASVS v5.0.0-8.4.1] 리뷰 재현: 서비스 시작 때 접속 사용자의 역할을 본다(소유자·두 역할 겸임이면 시작하지 않는다)', async () => {
    await expect(assertDatabaseRole(partner, 'core_partner')).resolves.toBeUndefined();
    await expect(assertDatabaseRole(app, 'core_app')).resolves.toBeUndefined();
    await expect(assertDatabaseRole(admin, 'core_partner')).rejects.toThrow(/행 보안/);
    await expect(assertDatabaseRole(app, 'core_partner')).rejects.toThrow(/core_partner/);
    const both = await loginFor(admin, pg, 'core_both_login', 'core_partner', 1);
    await admin.db.execute(sql.raw('GRANT core_app TO core_both_login'));
    await expect(assertDatabaseRole(both, 'core_partner')).rejects.toThrow(/core_app/);
    await both.close();
  });

  test('리뷰 재현: 슈퍼유저가 아닌 소유자로도 마이그레이션되고(역할이 이미 있어도) 함수가 행 보안을 지난다', async () => {
    await admin.db.execute(sql.raw(`CREATE ROLE core_migrator LOGIN PASSWORD 'peaket-test' CREATEROLE NOSUPERUSER`));
    await admin.db.execute(sql.raw('CREATE DATABASE peaket_owner OWNER core_migrator'));
    const url = pg.urlFor('core_migrator', 'peaket-test').replace(/\/peaket$/, '/peaket_owner');
    await migrateCore(url);
    const owner = createDatabase({ url, applicationName: 'core-svc-test', max: 1 });
    const fn = rows<{ owner: string }>(await owner.db.execute(sql`select pg_get_userbyid(proowner) as owner from pg_proc where proname = 'public_open_times'`));
    await owner.close();
    expect(fn).toEqual([{ owner: 'core_migrator' }]);
  });

  test('오픈 간격 함수는 파트너 사용자만 부른다', async () => {
    const q = sql`select * from public_open_times(now(), now(), ${PROD_A}::uuid)`;
    await expect(app.db.execute(q)).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
