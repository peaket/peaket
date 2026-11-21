// 테넌트 표의 행 보안(2차 방어) 통합 시험(실제 PostgreSQL 18 컨테이너, AZ-T5, FR-021, docs/security/authz-matrix.md §5.3, ADR-0198 결정 8, ADR-0241, BUILD_ORDER HOT-172).
// 배치본·구역·좌석·가격 등급 표(0007)는 HOT-240이 더했다(ADR-0260 결정 2). 판매 자격 명단·구성원 표와 규칙·회차 고치기 칸 권한(0008)은 HOT-250이 더했다(ADR-0261 결정 8)
// 판매자 표 promoter의 행 보안·칸 단위 읽기(0040)는 W12-core-rls가 더했다(ADR-0327 결정 13, authz-matrix §3.3·§5.3). 0034가 판매자 표를 파트너에게 행 보안 없이 열었다
import 'reflect-metadata';
import { createDatabase, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { assertDatabaseRole } from '../src/modules/catalog/adapters/db/database-role.js';
import { event, place, priceTier, production, productionArtist, promoter, promoterContractState, saleEligibilityList, saleEligibilityMember, searchAlias, seat, section, venue } from '../src/modules/catalog/adapters/db/schema.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

let pg: PostgresContainer;
let admin: Database;
let partner: Database;
let app: Database;
let ops: Database;
const A = randomUUID();
const B = randomUUID();
const NAME_A = '(주)에이';
const NAME_B = '(주)비';
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
  ops = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 1);
  await admin.db.insert(promoter).values([
    { id: A, legalName: NAME_A },
    { id: B, legalName: NAME_B },
  ]);
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  await admin.db.insert(production).values([
    { id: PROD_A, promoterId: A, placeId: PLACE, title: 'A 공연', genre: '콘서트', saleReview: 'DRAFT' },
    { id: PROD_B, promoterId: B, placeId: PLACE, title: 'B 공연', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') },
  ]);
  const times = { startsAt: new Date('2027-02-01T10:00:00Z'), endsAt: new Date('2027-02-01T12:00:00Z') };
  await admin.db.insert(event).values([
    { id: EVENT_A, productionId: PROD_A, promoterId: A, venueId: null, openAt: new Date('2027-01-05T11:00:00Z'), ...times },
    { id: EVENT_B, productionId: PROD_B, promoterId: B, venueId: null, openAt: OPEN_B, ...times },
  ]);
});
afterAll(async () => {
  await partner?.close();
  await app?.close();
  await ops?.close();
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
      partner.transaction(async (tx) => tx.insert(event).values({ id: randomUUID(), productionId: PROD_B, promoterId: B, venueId: null, openAt: new Date('2027-01-06T11:00:00Z'), ...times }), { tenantId: A }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  test('[ASVS v5.0.0-8.4.1] 리뷰 재현: 파트너는 스스로 판매 승인을 올리거나 다른 칸을 고치지 못한다', async () => {
    const denied = async (fn: Parameters<Database['transaction']>[0]) => expect(partner.transaction(fn, { tenantId: A })).rejects.toMatchObject({ cause: { code: '42501' } });
    await denied(async (tx) => tx.update(production).set({ saleApprovedAt: new Date() }));
    await denied(async (tx) => tx.update(production).set({ promoterId: B }));
    await denied(async (tx) => tx.update(production).set({ title: '바꿈' }));
    await denied(async (tx) => tx.update(event).set({ status: 'CANCELLED' }));
  });

  // 판매자 표는 0034부터 파트너가 자기 행을 읽는다(ADR-0327 결정 1·11·13). 그 범위는 아래 'AZ-T5 판매자 표 ①~⑦'이 본다
  test('[ASVS v5.0.0-8.4.1] 리뷰 재현: 코드가 쓰지 않는 표는 읽지 못한다(승인 전 공연 별칭·출연진)', async () => {
    const denied = async (fn: Parameters<Database['transaction']>[0]) => expect(partner.transaction(fn, { tenantId: A })).rejects.toMatchObject({ cause: { code: '42501' } });
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

  // 판매자 표 고치기는 0034부터 자기 행의 판매자 정보 칸에 열렸다. 다른 파트너 행을 못 고치는 것은 'AZ-T5 판매자 표 ③'이 본다
  test('[ASVS v5.0.0-8.4.1] 다른 공연을 지울 권한이 없다', async () => {
    await expect(partner.transaction(async (tx) => tx.delete(production), { tenantId: A })).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  test('S-T38 ⑦ 배치본·구역·좌석·가격 등급 행은 자기 테넌트로만 넣고 고치며 공개된 틀만 읽는다 [ASVS v5.0.0-8.4.1]', async () => {
    const T = randomUUID();
    const H = randomUUID();
    const LA = randomUUID();
    const LB = randomUUID();
    const tri: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    await admin.db.insert(venue).values([
      { id: T, name: '틀', kind: 'TEMPLATE', canvasWidth: 100, canvasHeight: 100, published: true },
      { id: H, name: '숨긴 틀', kind: 'TEMPLATE', canvasWidth: 100, canvasHeight: 100, published: false },
      { id: LB, kind: 'LAYOUT', promoterId: B },
    ]);
    await admin.db.insert(section).values([
      { venueId: T, sectionKey: 'A', sortOrder: 0, name: 'A', shape: tri },
      { venueId: H, sectionKey: 'A', sortOrder: 0, name: 'A', shape: tri },
      { venueId: LB, sectionKey: 'A', promoterId: B, sortOrder: 0, name: 'A', shape: tri, seatIndexFrom: 0, seatIndexTo: 0 },
    ]);
    await admin.db.insert(priceTier).values({ venueId: LB, tierId: 'R', promoterId: B, name: 'R석', price: 1000, displayOrder: 0 });
    await admin.db.insert(seat).values({ venueId: LB, seatKey: randomUUID(), sectionKey: 'A', promoterId: B, seatIndex: 0, rowLabel: '1', number: 1, x: 0, y: 0 });
    const denied = async (fn: Parameters<Database['transaction']>[0]) => expect(partner.transaction(fn, { tenantId: A })).rejects.toMatchObject({ cause: { code: '42501' } });
    // 다른 테넌트 배치본·틀을 만들지 못하고, 다른 테넌트 배치본에 구역·좌석·가격 등급을 넣지 못한다
    await denied(async (tx) => tx.insert(venue).values({ id: randomUUID(), kind: 'LAYOUT', promoterId: B }));
    await denied(async (tx) => tx.insert(venue).values({ id: randomUUID(), name: '새 틀', kind: 'TEMPLATE' }));
    await denied(async (tx) => tx.insert(section).values({ venueId: LB, sectionKey: 'X', promoterId: B, sortOrder: 1, name: 'X', shape: tri }));
    await denied(async (tx) => tx.insert(priceTier).values({ venueId: LB, tierId: 'S', promoterId: B, name: 'S석', price: 1, displayOrder: 1 }));
    await denied(async (tx) => tx.insert(seat).values({ venueId: LB, seatKey: randomUUID(), sectionKey: 'A', promoterId: B, seatIndex: 1, rowLabel: '1', number: 2, x: 0, y: 0 }));
    // 틀 구역(판매자 없음)도 넣지 못한다
    await denied(async (tx) => tx.insert(section).values({ venueId: T, sectionKey: 'X', sortOrder: 1, name: 'X', shape: tri }));
    await partner.transaction(async (tx) => tx.insert(venue).values({ id: LA, kind: 'LAYOUT', promoterId: A }), { tenantId: A });
    // 조건 없는 고치기·지우기도 자기 행만 건드린다(틀과 B의 행은 그대로)
    const changed = await partner.transaction(async (tx) => tx.update(venue).set({ versionSeq: 9 }).where(sql`true`).returning({ id: venue.id }), { tenantId: A });
    expect(changed.map((r) => r.id)).toEqual([LA]);
    const removed = await partner.transaction(async (tx) => ({ seat: await tx.delete(seat).returning({ k: seat.seatKey }), tier: await tx.delete(priceTier).returning({ k: priceTier.tierId }) }), { tenantId: A });
    expect(removed).toEqual({ seat: [], tier: [] });
    expect((await admin.db.select().from(seat).where(sql`${seat.venueId} = ${LB}`)).length).toBe(1);
    // 공개된 틀과 그 구역, 자기 배치본만 읽는다
    const seen = await partner.transaction(
      async (tx) => ({ v: (await tx.select({ id: venue.id }).from(venue)).map((r) => r.id).sort(), s: (await tx.select({ v: section.venueId }).from(section)).map((r) => r.v), t: await tx.select().from(priceTier) }),
      { tenantId: A },
    );
    expect(seen).toEqual({ v: [LA, T].sort(), s: [T], t: [] });
    // 판매자·종류·공개 표시는 고치지 못하고, 회차는 정한 칸(배치본, 0008부터 일정·정렬·배정·1인 한도·판)만 고친다
    await denied(async (tx) => tx.update(venue).set({ promoterId: B }));
    await denied(async (tx) => tx.update(venue).set({ kind: 'TEMPLATE' }));
    await denied(async (tx) => tx.update(venue).set({ published: true }));
    await denied(async (tx) => tx.update(event).set({ entryClosedAt: new Date('2027-01-05T11:00:00Z') }));
    // 다른 테넌트의 배치본을 회차에 잇지 못한다(묶음 외래키)
    await expect(partner.transaction(async (tx) => tx.update(event).set({ venueId: LB }).where(sql`${event.id} = ${EVENT_A}`), { tenantId: A })).rejects.toMatchObject({ cause: { code: '23503' } });
    // 팬·관제 사용자는 공연 상세의 가격 등급만 읽고(리뷰 S5) 배치본·구역·좌석은 읽지도 쓰지도 못한다
    expect((await app.db.select({ tierId: priceTier.tierId, venueId: priceTier.venueId }).from(priceTier)).map((r) => r.venueId)).toContain(LB);
    for (const t of [venue, section, seat] as const) await expect(app.db.select().from(t)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(app.db.update(venue).set({ versionSeq: 1 })).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(app.db.delete(seat)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(app.db.delete(priceTier)).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  test('다른 파트너 공연의 규칙·명단은 파트너 역할 행 보안이 남의 명단·구성원을 0건으로 보고 쓰지 못하게 하며, 팬 경로는 자격에 쓰는 칸만 읽는다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.4.1]', async () => {
    const LIST_B = randomUUID();
    const MEMBER_B = randomUUID();
    const due = new Date('2027-02-01T10:00:00Z');
    const row = (id: string, productionId: string, promoterId: string, key: string) => ({ id, productionId, promoterId, key, name: '명단', memberCount: 1, fileSha256: Buffer.alloc(32, 1), version: 1, uploadedAt: new Date(), uploadedBy: randomUUID(), destroyDueAt: due });
    await admin.db.insert(saleEligibilityList).values(row(LIST_B, PROD_B, B, 'fanclub-b'));
    await admin.db.insert(saleEligibilityMember).values({ listId: LIST_B, promoterId: B, accountId: MEMBER_B });
    const denied = async (fn: Parameters<Database['transaction']>[0]) => expect(partner.transaction(fn, { tenantId: A })).rejects.toMatchObject({ cause: { code: '42501' } });
    // 조건 없는 읽기·고치기·지우기도 B의 행을 보지도 건드리지도 않는다
    const seen = await partner.transaction(async (tx) => ({ l: await tx.select({ id: saleEligibilityList.id }).from(saleEligibilityList), m: await tx.select({ a: saleEligibilityMember.accountId }).from(saleEligibilityMember) }), { tenantId: A });
    expect(seen).toEqual({ l: [], m: [] });
    const touched = await partner.transaction(
      async (tx) => ({
        u: await tx.update(saleEligibilityList).set({ name: '바꿈' }).where(sql`true`).returning({ id: saleEligibilityList.id }),
        d: await tx.delete(saleEligibilityMember).returning({ a: saleEligibilityMember.accountId }),
        p: await tx.update(production).set({ salePolicy: [] }).where(sql`${production.id} = ${PROD_B}`).returning({ id: production.id }),
      }),
      { tenantId: A },
    );
    expect(touched).toEqual({ u: [], d: [], p: [] });
    expect(await admin.db.select({ a: saleEligibilityMember.accountId }).from(saleEligibilityMember)).toEqual([{ a: MEMBER_B }]);
    // B의 명단·구성원으로 넣지 못한다(행 보안). 자기 공연에 B의 판매자로 넣어도 막힌다
    await denied(async (tx) => tx.insert(saleEligibilityList).values(row(randomUUID(), PROD_B, B, 'sneak')));
    await denied(async (tx) => tx.insert(saleEligibilityMember).values({ listId: LIST_B, promoterId: B, accountId: randomUUID() }));
    await denied(async (tx) => tx.insert(saleEligibilityList).values(row(randomUUID(), PROD_A, B, 'sneak')));
    // 칸 권한: 명단 키·공연·판매자는 고치지 못하고, 회차는 정한 칸만 고친다
    const LIST_A = randomUUID();
    await partner.transaction(async (tx) => tx.insert(saleEligibilityList).values(row(LIST_A, PROD_A, A, 'fanclub-a')), { tenantId: A });
    await denied(async (tx) => tx.update(saleEligibilityList).set({ key: 'other-key' }));
    await denied(async (tx) => tx.update(saleEligibilityList).set({ productionId: PROD_B }));
    await denied(async (tx) => tx.update(saleEligibilityList).set({ promoterId: B }));
    await denied(async (tx) => tx.update(event).set({ status: 'CANCELLED' }));
    const edited = await partner.transaction(async (tx) => tx.update(event).set({ lobbyMinutes: 5, version: 2 }).where(sql`true`).returning({ id: event.id }), { tenantId: A });
    expect(edited.map((r) => r.id)).toEqual([EVENT_A]);
    // 팬 경로: 명단 키·이름·파기 시각과 구성원 계정만 읽고 SHA-256·올린 사람은 읽지 못하며 쓰지 못한다
    expect(await app.db.select({ key: saleEligibilityList.key, name: saleEligibilityList.name }).from(saleEligibilityList).where(sql`${saleEligibilityList.id} = ${LIST_B}`)).toEqual([{ key: 'fanclub-b', name: '명단' }]);
    expect(await app.db.select({ a: saleEligibilityMember.accountId }).from(saleEligibilityMember)).toEqual([{ a: MEMBER_B }]);
    await expect(app.db.select({ s: saleEligibilityList.fileSha256 }).from(saleEligibilityList)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(app.db.select({ s: saleEligibilityList.uploadedBy }).from(saleEligibilityList)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(app.db.delete(saleEligibilityMember)).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(app.db.update(production).set({ salePolicy: [] })).rejects.toMatchObject({ cause: { code: '42501' } });
    const tables = rows<{ relname: string; relrowsecurity: boolean }>(await admin.db.execute(sql`select relname, relrowsecurity from pg_class where relname in ('sale_eligibility_list', 'sale_eligibility_member') and relkind = 'r' order by relname`));
    expect(tables).toEqual([
      { relname: 'sale_eligibility_list', relrowsecurity: true },
      { relname: 'sale_eligibility_member', relrowsecurity: true },
    ]);
    await admin.db.execute(sql`delete from sale_eligibility_member; delete from sale_eligibility_list; update event set lobby_minutes = 10, version = 1`);
  });

  test('리뷰 재현(S6): 파트너 연결은 승인 이력이 있는 공연의 공개본 판매 정책과 회차 일정·판매 설정을 바로 고치지 못한다(판·변경분 칸만) [ASVS v5.0.0-8.4.1]', async () => {
    const PROD_C = randomUUID();
    const EVENT_C = randomUUID();
    const times = { startsAt: new Date('2027-02-01T10:00:00Z'), endsAt: new Date('2027-02-01T12:00:00Z') };
    await admin.db.insert(production).values({ id: PROD_C, promoterId: A, placeId: PLACE, title: '승인된 A 공연', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') });
    await admin.db.insert(event).values({ id: EVENT_C, productionId: PROD_C, promoterId: A, venueId: null, openAt: new Date('2027-01-07T11:00:00Z'), ...times });
    const denied = async (fn: Parameters<Database['transaction']>[0]) => expect(partner.transaction(fn, { tenantId: A })).rejects.toMatchObject({ cause: { code: '42501' } });
    await denied(async (tx) => tx.update(production).set({ salePolicy: [] }).where(sql`${production.id} = ${PROD_C}`));
    await denied(async (tx) => tx.update(event).set({ openAt: new Date('2027-01-08T11:00:00Z') }).where(sql`${event.id} = ${EVENT_C}`));
    await denied(async (tx) => tx.update(event).set({ perPersonLimit: 1 }).where(sql`${event.id} = ${EVENT_C}`));
    // 판·변경분·판매 승인 상태 칸은 고친다(재승인 대기로 두는 길)
    const ok = await partner.transaction(
      async (tx) => ({
        p: await tx.update(production).set({ salePolicyVersion: 2, pendingRevision: { salePolicy: [] }, saleReview: 'SUBMITTED' }).where(sql`${production.id} = ${PROD_C}`).returning({ id: production.id }),
        e: await tx.update(event).set({ version: 2 }).where(sql`${event.id} = ${EVENT_C}`).returning({ id: event.id }),
      }),
      { tenantId: A },
    );
    expect(ok).toEqual({ p: [{ id: PROD_C }], e: [{ id: EVENT_C }] });
    // 승인 이력이 없는 공연은 바로 고친다
    const draft = await partner.transaction(async (tx) => tx.update(event).set({ perPersonLimit: 3 }).where(sql`${event.id} = ${EVENT_A}`).returning({ id: event.id }), { tenantId: A });
    expect(draft).toEqual([{ id: EVENT_A }]);
    await admin.db.execute(sql`update event set per_person_limit = 4 where id = ${EVENT_A}`);
    await admin.db.execute(sql`delete from event where id = ${EVENT_C}`);
    await admin.db.execute(sql`delete from production where id = ${PROD_C}`);
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

/** 거부된 쿼리의 SQLSTATE. Drizzle은 pg 오류를 cause로 감싼다. DB 오류가 아니면 그 글을 돌려 단언 차이에 드러낸다 */
const sqlState = (e: unknown): string => {
  const cause = e instanceof Error ? e.cause : undefined;
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : `DB 오류 아님: ${String(e)}`;
};

describe('AZ-T5 판매자 표(promoter, ADR-0327 결정 13)', () => {
  // 판매자 정보 여덟 칸(ADR-0327 결정 1·11, 0034가 파트너에게 고치기를 준 칸). 시드·코드 상수와 겹치지 않는 값을 고른다
  const SELLER = {
    legalName: '(주)에이 새상호',
    representative: '가나다',
    address: '부산 해운대구 시험로 7',
    phone: '051-000-0707',
    email: 'seller-a@peaket.test',
    businessRegNo: '707-07-07070',
    mailOrderReportNo: '2026-부산해운대-0707',
    exemptionBasis: '시험용 면제 근거',
  };
  const CLEARED = { representative: null, address: null, phone: null, email: null, businessRegNo: null, mailOrderReportNo: null, exemptionBasis: null, verifiedAt: null };
  const sellerColumns = {
    id: promoter.id,
    legalName: promoter.legalName,
    representative: promoter.representative,
    address: promoter.address,
    phone: promoter.phone,
    email: promoter.email,
    businessRegNo: promoter.businessRegNo,
    mailOrderReportNo: promoter.mailOrderReportNo,
    exemptionBasis: promoter.exemptionBasis,
  };
  const bothSellers = sql`${promoter.id} in (${A}, ${B})`;
  /** admin(슈퍼유저라 행 보안을 지난다)으로 본 두 판매자의 상호 */
  const legalNames = async () => Object.fromEntries((await admin.db.select({ id: promoter.id, n: promoter.legalName }).from(promoter).where(bothSellers)).map((r) => [r.id, r.n]));

  // 시험마다 시드로 되돌린다(③④가 바꾸고, 구현 전 트리에서는 ②도 두 행을 바꾼다)
  afterEach(async () => {
    await admin.db.update(promoter).set({ legalName: NAME_A, ...CLEARED }).where(sql`${promoter.id} = ${A}`);
    await admin.db.update(promoter).set({ legalName: NAME_B, ...CLEARED }).where(sql`${promoter.id} = ${B}`);
  });

  test('AZ-T5 판매자 표 ① 테넌트 조건을 뺀 조회도 자기 판매자 행만 준다 [ASVS v5.0.0-8.4.1]', async () => {
    const seen = {
      a: await partner.transaction(async (tx) => tx.select({ id: promoter.id }).from(promoter), { tenantId: A }),
      b: await partner.transaction(async (tx) => tx.select({ id: promoter.id }).from(promoter), { tenantId: B }),
    };
    expect(seen).toEqual({ a: [{ id: A }], b: [{ id: B }] });
  });

  test('AZ-T5 판매자 표 ② 테넌트 없이는 읽기·고치기 모두 0건이다(앞 트랜잭션이 쓴 연결을 다시 써도 오류 없이) [ASVS v5.0.0-8.4.1]', async () => {
    // 연결 하나짜리 풀이라 다음 트랜잭션이 같은 연결을 받는다. 그 연결의 app.tenant_id는 NULL이 아니라 빈 문자열이다(authz-matrix §5.3)
    await partner.transaction(async (tx) => tx.select({ id: promoter.id }).from(promoter), { tenantId: A });
    const inTx = await partner.transaction(async (tx) => {
      const tenant = rows<{ v: string | null }>(await tx.execute(sql`select current_setting('app.tenant_id', true) as v`));
      const seen = await tx.select({ id: promoter.id }).from(promoter);
      await tx.update(promoter).set({ legalName: '(주)테넌트없이고침' });
      return { tenant, seen };
    });
    const outside = await partner.db.select({ id: promoter.id }).from(promoter);
    expect({ inTx, outside, names: await legalNames() }).toEqual({ inTx: { tenant: [{ v: '' }], seen: [] }, outside: [], names: { [A]: NAME_A, [B]: NAME_B } });
  });

  test('AZ-T5 판매자 표 ③ 조건 없는 고치기로도 다른 파트너의 판매자 행을 바꾸지 못하고 넣기·지우기 권한이 없다 [ASVS v5.0.0-8.4.1]', async () => {
    const denied = async (fn: Parameters<Database['transaction']>[0]) => expect(partner.transaction(fn, { tenantId: A })).rejects.toMatchObject({ cause: { code: '42501' } });
    // WHERE도 RETURNING도 없이 고친다. 칸을 읽지 않아야 읽기 정책이 끼지 않고 고치기 정책만 행을 거른다(PostgreSQL 18 CREATE POLICY '명령별 적용 정책')
    await partner.transaction(async (tx) => tx.update(promoter).set({ legalName: '(주)에이 조건없이고침' }), { tenantId: A });
    const names = await legalNames();
    await denied(async (tx) => tx.delete(promoter));
    await denied(async (tx) => tx.insert(promoter).values({ id: randomUUID(), legalName: '(주)끼어들기' }));
    expect(names).toEqual({ [A]: '(주)에이 조건없이고침', [B]: NAME_B });
  });

  test('AZ-T5 판매자 표 ④ 자기 판매자 행의 판매자 정보 여덟 칸은 고치고 읽는다(운영자 확인 시각은 그대로) [ASVS v5.0.0-8.4.1]', async () => {
    const VERIFIED = new Date('2026-10-01T03:00:00.000Z');
    await admin.db.update(promoter).set({ verifiedAt: VERIFIED }).where(sql`${promoter.id} = ${A}`);
    const own = sql`${promoter.id} = ${A}`;
    const out = await partner.transaction(
      async (tx) => ({
        changed: await tx.update(promoter).set(SELLER).where(own).returning({ id: promoter.id }),
        read: await tx.select(sellerColumns).from(promoter).where(own),
      }),
      { tenantId: A },
    );
    expect(out).toEqual({ changed: [{ id: A }], read: [{ id: A, ...SELLER }] });
    const stored = Object.fromEntries((await admin.db.select().from(promoter).where(bothSellers)).map((r) => [r.id, r]));
    expect(stored).toEqual({
      [A]: { id: A, ...SELLER, verifiedAt: VERIFIED },
      [B]: { id: B, legalName: NAME_B, ...CLEARED },
    });
  });

  test('AZ-T5 판매자 표 ⑤ 자기 행이라도 판매자 정보 밖의 칸은 읽지도 고치지도 못한다(운영자 확인 시각·수수료율·계약 변경 대기) [ASVS v5.0.0-8.2.3]', async () => {
    const tried = (fn: Parameters<Database['transaction']>[0]) => partner.transaction(fn, { tenantId: A }).then(() => '됨', sqlState);
    const own = sql`${promoter.id} = ${A}`;
    // 칸마다 따로 한 트랜잭션씩 본다(목록 밖 값마다 거부). 계약 칸은 그림자 객체 promoterContractState로만 닿는다(schema.ts)
    const outcome = {
      readVerifiedAt: await tried(async (tx) => tx.select({ v: promoter.verifiedAt }).from(promoter).where(own)),
      readCommissionRateBp: await tried(async (tx) => tx.select({ v: promoterContractState.commissionRateBp }).from(promoterContractState).where(own)),
      readPendingContractApprovalId: await tried(async (tx) => tx.select({ v: promoterContractState.pendingContractApprovalId }).from(promoterContractState).where(own)),
      updateVerifiedAt: await tried(async (tx) => tx.update(promoter).set({ verifiedAt: new Date('2026-10-02T00:00:00.000Z') })),
      updateCommissionRateBp: await tried(async (tx) => tx.update(promoterContractState).set({ commissionRateBp: 1 })),
      updatePendingContractApprovalId: await tried(async (tx) => tx.update(promoterContractState).set({ pendingContractApprovalId: randomUUID() })),
      updateId: await tried(async (tx) => tx.update(promoter).set({ id: randomUUID() })),
    };
    expect(outcome).toEqual({
      readVerifiedAt: '42501',
      readCommissionRateBp: '42501',
      readPendingContractApprovalId: '42501',
      updateVerifiedAt: '42501',
      updateCommissionRateBp: '42501',
      updatePendingContractApprovalId: '42501',
      updateId: '42501',
    });
  });

  test('AZ-T5 판매자 표 ⑥ 팬 경로 사용자는 모든 판매자 행을 읽기만 하고 관제 사용자는 모든 판매자 행을 본다 [ASVS v5.0.0-8.4.1]', async () => {
    // 회차 상세가 읽는 모양(기본 객체의 모든 칸, ADR-0200)
    const fan = Object.fromEntries((await app.db.select().from(promoter)).map((r) => [r.id, r]));
    expect(fan).toEqual({
      [A]: { id: A, legalName: NAME_A, ...CLEARED },
      [B]: { id: B, legalName: NAME_B, ...CLEARED },
    });
    await expect(app.db.update(promoter).set({ legalName: '(주)팬경로고침' })).rejects.toMatchObject({ cause: { code: '42501' } });
    const seenByOps = await ops.db.select({ id: promoter.id }).from(promoter);
    expect(seenByOps.map((r) => r.id).sort()).toEqual([A, B].sort());
  });

  test('AZ-T5 판매자 표 ⑦ 행 보안이 켜져 있고 FORCE가 없으며 소유자가 앱 역할이 아니고 정책 넷이 정한 모양이다 [ASVS v5.0.0-8.4.1]', async () => {
    const table = rows<{ rls: boolean; forced: boolean; owner: string }>(
      await admin.db.execute(
        sql`select c.relrowsecurity as rls, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'promoter' and c.relkind = 'r'`,
      ),
    );
    const policies = rows<{ policyname: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }>(
      await admin.db.execute(sql`select policyname, cmd, roles::text[] as roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'promoter' order by policyname`),
    );
    // 파트너 식은 production_partner_tenant(0004, ADR-0241 결정 3)의 식에서 promoter_id 자리에 id가 온 것이다(ADR-0327 결정 13)
    const base = rows<{ qual: string }>(await admin.db.execute(sql`select qual from pg_policies where schemaname = 'public' and tablename = 'production' and policyname = 'production_partner_tenant'`));
    expect(base).toHaveLength(1);
    expect(base[0]!.qual).toMatch(/\bpromoter_id = /);
    const self = base[0]!.qual.replace('promoter_id', 'id');
    expect({ table: table.map((t) => ({ rls: t.rls, forced: t.forced })), policies }).toEqual({
      table: [{ rls: true, forced: false }],
      policies: [
        { policyname: 'promoter_app_read', cmd: 'SELECT', roles: ['core_app'], qual: 'true', with_check: null },
        { policyname: 'promoter_ops', cmd: 'ALL', roles: ['core_ops'], qual: 'true', with_check: 'true' },
        { policyname: 'promoter_partner_self_read', cmd: 'SELECT', roles: ['core_partner'], qual: self, with_check: null },
        { policyname: 'promoter_partner_self_update', cmd: 'UPDATE', roles: ['core_partner'], qual: self, with_check: self },
      ],
    });
    expect(['core_partner', 'core_app', 'core_ops', 'core_partner_login', 'core_app_login', 'core_ops_login']).not.toContain(table[0]!.owner);
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
      await admin.db.execute(sql`select c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity from pg_class c where c.relname in ('production', 'event', 'venue', 'section', 'seat', 'price_tier') and c.relkind = 'r' order by c.relname`),
    );
    expect(tables.map((t) => [t.relname, t.relrowsecurity])).toEqual([
      ['event', true],
      ['price_tier', true],
      ['production', true],
      ['seat', true],
      ['section', true],
      ['venue', true],
    ]);
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
