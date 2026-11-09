// 관리 계정 지정의 통합 시험(실제 PostgreSQL 18, docs/features/identity.md §6 '관리 계정 지정의 첫 구현', BUILD_ORDER BOT-151, ADR-0171 결정 7).
// 마이그레이션 0023(admin_designation, 살아 있는 행의 부분 고유 색인, 멱등 기록 종류), 함께 둘 수 없는 두 지정의 동시 요청, 역할 변경 때 거두기, 조회의 거둔 지정을 본다.
import { createDatabase, type Database, ensureOutboxPartitions, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { migrateIdentity } from '../scripts/migrate.mjs';
import { DrizzleAdminAccountStore } from '../src/modules/admin/adapters/db/drizzle-admin-account-store.js';
import { ManageAdminAccounts } from '../src/modules/admin/application/manage-admin-accounts.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const clock = fakeClock({ now: Date.parse('2026-11-05T16:00:00.000Z') });
const CMD = '0190f3a1-7c2e-7a00-8000-00000000dd01';
const CMD2 = '0190f3a1-7c2e-7a00-8000-00000000dd02';
const LEAD = '0190f3a1-7c2e-7a00-8000-00000000dd03';

beforeAll(async () => {
  pg = await startPostgres();
  await migrateIdentity(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'identity-admin-designation-test', max: 6 });
  await ensureOutboxPartitions(database, clock);
  const store = new DrizzleAdminAccountStore(database, clock);
  await store.create({ id: CMD, role: 'commander', email: 'c1.dz@peaket.example', status: 'ACTIVE', now: clock.now() });
  await store.create({ id: CMD2, role: 'commander', email: 'c2.dz@peaket.example', status: 'ACTIVE', now: clock.now() });
  await store.create({ id: LEAD, role: 'cs_lead', email: 'lead.dz@peaket.example', status: 'ACTIVE', now: clock.now() });
}, 120_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

const q = async <R>(sql: string, params: unknown[] = []): Promise<R[]> => (await database.pool.query(sql, params)).rows as R[];

test('PostgreSQL에서_조사관과가명정보취급자를같은순간에한계정에주면하나만OK이고다른하나는DESIGNATION_CONFLICT다(대상 행 잠금, I-T66④⑤)', async () => {
  const manage = new ManageAdminAccounts(new DrizzleAdminAccountStore(database, clock), clock);
  const both = await Promise.all([
    manage.designate({ requestId: 'd-1', actedBy: CMD, accountId: CMD2, kind: 'FRAUD_INVESTIGATOR', basis: '지정서 1' }),
    manage.designate({ requestId: 'd-2', actedBy: CMD, accountId: CMD2, kind: 'PSEUDONYM_HANDLER', basis: '지정서 2' }),
  ]);
  expect(both.map((r) => r.result).sort()).toEqual(['DESIGNATION_CONFLICT', 'OK']);
  expect(await q('select kind from admin_designation where admin_account_id = $1 and revoked_at is null', [CMD2])).toHaveLength(1);
  // 같은 종류는 살아 있는 행 하나(부분 고유 색인)
  await expect(q("insert into admin_designation (id, admin_account_id, kind, basis, designated_by, designated_at) select gen_random_uuid(), admin_account_id, kind, 'x', designated_by, now() from admin_designation where admin_account_id = $1 and revoked_at is null", [CMD2])).rejects.toThrow();
});

test('PostgreSQL에서_cs_lead를cs_agent로낮추면같은트랜잭션에서조사관지정을거두고_조회는90일안에거둔지정을준다(I-T66⑦)', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const manage = new ManageAdminAccounts(store, clock);
  expect((await manage.designate({ requestId: 'd-3', actedBy: CMD, accountId: LEAD, kind: 'FRAUD_INVESTIGATOR', basis: '지정서 3' })).result).toBe('OK');
  expect((await manage.get(LEAD))!.account.designations).toEqual(['FRAUD_INVESTIGATOR']);
  clock.advance(1_000);
  expect((await manage.changeRole({ requestId: 'd-4', actedBy: CMD, accountId: LEAD, role: 'cs_agent', expectedVersion: 1 })).account).toMatchObject({ role: 'cs_agent', designations: [] });
  const [row] = await q<{ revoked_at: Date }>("select revoked_at from admin_designation where admin_account_id = $1 and kind = 'FRAUD_INVESTIGATOR'", [LEAD]);
  expect(row!.revoked_at.getTime()).toBe(clock.now());
  expect(await manage.designationsOf(LEAD)).toEqual({ kinds: [], recentlyRevoked: [{ kind: 'FRAUD_INVESTIGATOR', revokedAt: clock.now() }] });
  expect(await q("select kind from admin_account_request where request_id in ('d-3', 'd-4') order by request_id")).toEqual([{ kind: 'DESIGNATE' }, { kind: 'CHANGE_ROLE' }]);
  // 거두기는 이미 거둔 지정이어도 OK
  expect((await manage.revokeDesignation({ requestId: 'd-5', actedBy: CMD, accountId: LEAD, kind: 'FRAUD_INVESTIGATOR' })).result).toBe('OK');
  // 목록도 살아 있는 지정을 싣는다
  const list = await manage.list({ group: 'OPS' });
  expect(list.accounts.find((a) => a.adminAccountId === CMD2)!.designations).toHaveLength(1);
});

test('PostgreSQL에서_조회는살아있는지정·90일안에거둔지정·90일지난지정을한쿼리로가르고_없는계정은빈답이다', async () => {
  const store = new DrizzleAdminAccountStore(database, clock);
  const manage = new ManageAdminAccounts(store, clock);
  const c3 = '0190f3a1-7c2e-7a00-8000-00000000dd04';
  await store.create({ id: c3, role: 'commander', email: 'c3.dz@peaket.example', status: 'ACTIVE', now: clock.now() });
  const D = 24 * 60 * 60_000;
  expect((await manage.designate({ requestId: 'm-1', actedBy: CMD, accountId: c3, kind: 'ACCESS_REVIEWER', basis: '지정서 a' })).result).toBe('OK');
  expect((await manage.revokeDesignation({ requestId: 'm-2', actedBy: CMD, accountId: c3, kind: 'ACCESS_REVIEWER' })).result).toBe('OK');
  const oldRevoke = clock.now();
  clock.advance(91 * D);
  expect((await manage.designate({ requestId: 'm-3', actedBy: CMD, accountId: c3, kind: 'PSEUDONYM_HANDLER', basis: '지정서 b' })).result).toBe('OK');
  expect((await manage.revokeDesignation({ requestId: 'm-4', actedBy: CMD, accountId: c3, kind: 'PSEUDONYM_HANDLER' })).result).toBe('OK');
  const recent = clock.now();
  clock.advance(1_000);
  expect((await manage.designate({ requestId: 'm-5', actedBy: CMD, accountId: c3, kind: 'ACCESS_REVIEWER', basis: '지정서 c' })).result).toBe('OK');
  const d = await manage.designationsOf(c3);
  expect(d).toEqual({ kinds: ['ACCESS_REVIEWER'], recentlyRevoked: [{ kind: 'PSEUDONYM_HANDLER', revokedAt: recent }] });
  expect(d.recentlyRevoked.some((r) => r.revokedAt === oldRevoke)).toBe(false);
  expect(await manage.designationsOf('0190f3a1-7c2e-7a00-8000-00000000ddff')).toEqual({ kinds: [], recentlyRevoked: [] });
});
