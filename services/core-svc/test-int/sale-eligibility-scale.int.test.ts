// 큰 판매 자격 명단(50만 줄)의 문장 시간 상한 시험(리뷰 C4, docs/architecture.md §5 시간 초과 기본값: core 역할 statement_timeout 5초·idle_in_transaction 10초).
// 시험 DB 사용자에 운영과 같은 역할 기본값을 걸고(ALTER ROLE … SET) 50만 줄 올리기·다시 올리기·지우기·파기를 돌린다. 문장 하나가 5초를 넘으면 DB가 끊는다.
// CI가 이 PC보다 느려 시험 시간 상한은 넉넉히 둔다. 실제 PostgreSQL 18 컨테이너, 실제 core-svc HTTP 앱, identity 경계만 대역이다.
import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { type Clock, createService, createDatabase, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter, saleEligibilityList } from '../src/modules/catalog/adapters/db/schema.js';
import { DrizzleSaleMaintenanceStore, type MemberCodeDirectory, MemorySaleEligibilityCopy, saleEligibilityMaintenanceTasks } from '../src/modules/catalog/index.js';
import { FakeIdentity, testMedia } from '../test/support.js';
import { multipart } from './media-support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const code = (i: number) => {
  const d = (k: number) => ALPHABET[Math.floor(i / 32 ** k) % 32];
  return `${d(6)}${d(5)}${d(4)}-${d(3)}${d(2)}${d(1)}${d(0)}`;
};
/** 회원 코드를 계정으로 바꾸는 대역(코드에서 정해진 UUID) */
const directory: MemberCodeDirectory = {
  resolve: async (codes) =>
    new Map(
      codes.map((c) => {
        const h = createHash('sha256').update(c).digest('hex');
        return [c, `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`];
      }),
    ),
};

let pg: PostgresContainer;
let admin: Database;
let appDb: Database;
let partnerDb: Database;
let maintDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;
const identity = new FakeIdentity();
const copy = new MemorySaleEligibilityCopy();
let now = Date.parse('2026-11-05T00:00:00Z');
const clock: Clock = { now: () => now, monotonicMs: () => performance.now() };
const A = randomUUID();
const KEY = 'lumen-fanclub-2026';

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-test', max: 2 });
  await ensureOutboxPartitions(admin, systemClock);
  appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 2);
  // 운영 역할 기본값(새 세션에 걸린다): 일반 API 역할 5초·10초
  await admin.db.execute(sql.raw(`CREATE USER core_partner_login PASSWORD 'peaket-test' NOBYPASSRLS NOSUPERUSER; GRANT core_partner TO core_partner_login;
    ALTER ROLE core_partner_login SET statement_timeout = '5s'; ALTER ROLE core_partner_login SET idle_in_transaction_session_timeout = '10s';
    CREATE USER core_maintenance_login PASSWORD 'peaket-test' NOBYPASSRLS NOSUPERUSER; GRANT core_maintenance TO core_maintenance_login;
    ALTER ROLE core_maintenance_login SET statement_timeout = '5s'; ALTER ROLE core_maintenance_login SET idle_in_transaction_session_timeout = '10s';`));
  partnerDb = createDatabase({ url: pg.urlFor('core_partner_login', 'peaket-test'), applicationName: 'core-svc-core_partner', max: 2 });
  maintDb = createDatabase({ url: pg.urlFor('core_maintenance_login', 'peaket-test'), applicationName: 'core-svc-maintenance', max: 2 });
  await admin.db.insert(promoter).values({ id: A, legalName: '(주)에이' });
  const PLACE = randomUUID();
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: randomUUID() });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia({ memberCodes: directory, eligibilityCopy: copy }) }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    adminAuthz: identity,
  });
  await admin.db.insert(production).values({ id: PROD, promoterId: A, placeId: PLACE, title: '큰 명단 공연', genre: '콘서트', saleReview: 'DRAFT' });
  await admin.db.insert(event).values({ id: randomUUID(), productionId: PROD, promoterId: A, venueId: null, openAt: new Date('2026-11-20T11:00:00Z'), startsAt: new Date('2026-12-24T10:00:00Z'), endsAt: new Date('2026-12-24T12:00:00Z') });
}, 180_000);

afterAll(async () => {
  await svc?.close();
  await appDb?.close();
  await partnerDb?.close();
  await maintDb?.close();
  await admin?.close();
  pg?.stop();
});

const PROD = randomUUID();
async function upload(from: number) {
  const text = `${Array.from({ length: 500_000 }, (_, i) => code(from + i)).join('\n')}\n`;
  const { payload, contentType } = await multipart({ key: KEY, name: '큰 명단' }, [{ name: 'l.csv', type: 'text/csv', bytes: new TextEncoder().encode(text) }]);
  return svc.http.inject({ method: 'POST', url: `/v1/partner/productions/${PROD}/sale-eligibility-lists`, headers: { ...identity.partner(A, 'partner_admin'), 'content-type': contentType, 'x-requested-with': 'peaket-partner' }, payload });
}
const memberCount = async () => (await admin.db.execute(sql`select count(*)::int as n from sale_eligibility_member`)).rows[0] as { n: number };

describe('C4 큰 명단 문장 시간 상한(리뷰)', () => {
  test('50만 줄 올리기·같은 키로 다시 올리기·지우기·파기가 문장마다 5초 상한 안에 끝난다', async () => {
    const t0 = Date.now();
    const first = await upload(0);
    expect([first.statusCode, JSON.parse(first.payload).applied]).toEqual([200, 500_000]);
    const t1 = Date.now();
    // 같은 키로 다시 올리면 옛 구성원 50만 행을 지우고 새 50만 행을 넣는다
    const again = await upload(1_000_000);
    expect([again.statusCode, JSON.parse(again.payload).version]).toEqual([200, 2]);
    expect(await memberCount()).toEqual({ n: 500_000 });
    const t2 = Date.now();
    const del = await svc.http.inject({ method: 'DELETE', url: `/v1/partner/productions/${PROD}/sale-eligibility-lists/${KEY}`, headers: { ...identity.partner(A, 'partner_admin'), 'x-requested-with': 'peaket-partner' } });
    expect(del.statusCode).toBe(204);
    expect(await memberCount()).toEqual({ n: 0 });
    const t3 = Date.now();
    expect((await upload(2_000_000)).statusCode).toBe(200);
    now = Date.parse('2026-12-24T10:00:00Z');
    const t4 = Date.now();
    const purge = await saleEligibilityMaintenanceTasks(new DrizzleSaleMaintenanceStore(maintDb), copy, clock).find((t) => t.name === 'sale-eligibility-purge')!.run();
    const t5 = Date.now();
    expect(purge).toMatchObject({ purged: 1 });
    expect(await memberCount()).toEqual({ n: 0 });
    expect(await admin.db.select().from(saleEligibilityList).where(eq(saleEligibilityList.productionId, PROD))).toEqual([]);
    console.log(`50만 줄(문장 상한 5초): 올리기 ${t1 - t0}ms, 다시 올리기 ${t2 - t1}ms, 지우기 ${t3 - t2}ms, 파기 ${t5 - t4}ms`);
  }, 600_000);
});
