// F-06-5 ops-svc 팬 조회 PostgreSQL 18 통합 시험(계획 §6·§8, 작업 폴더 lane2-F-06-5-opencode).
// 실제 마이그레이션 0041을 적용하고 admin_data_access·cs_case.account_id, Drizzle 접속기록 저장·읽기,
// 가린 값 열람의 2년 보존, 문의 건을 열 때 계정 채움과 계정별 건 목록을 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { DrizzleAdminDataAccessStore } from '../src/modules/fan-lookup/adapters/db/drizzle-fan-lookup.js';
import { FanLookup } from '../src/modules/fan-lookup/application/fan-lookup.js';
import { DrizzleCsCaseStore } from '../src/modules/cases/adapters/db/drizzle-cs-case-store.js';
import { ReceiveCaseRequested } from '../src/modules/cases/application/receive-case-requested.js';
import { weekendOnlyCalendar } from '../src/modules/cases/domain/business-calendar.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let container: PostgresContainer;
let admin: Database;
let database: Database;
let access: DrizzleAdminDataAccessStore;
let cases: DrizzleCsCaseStore;
let lookup: FanLookup;

const NOW = Date.parse('2026-11-27T05:00:00.000Z');
const DAY = 86_400_000;
const clock = fakeClock({ now: NOW });

beforeAll(async () => {
  container = await startPostgres({ name: 'peaket-f065-fan-lookup-it' });
  await migrateOps(container.url);
  admin = createDatabase({ url: container.url, applicationName: 'ops-svc-fan-lookup-it-admin', max: 4 });
  await admin.pool.query("create user ops_app_fan_lookup_it password 'peaket-test' nosuperuser nobypassrls in role ops_app");
  database = createDatabase({ url: container.urlFor('ops_app_fan_lookup_it', 'peaket-test'), applicationName: 'ops-svc-fan-lookup-it-app', max: 4 });
  access = new DrizzleAdminDataAccessStore(database);
  cases = new DrizzleCsCaseStore(database);
}, 240_000);

afterAll(async () => {
  await database?.close();
  await admin?.close();
  container?.stop();
});

const codeOf = async (text: string, params: unknown[] = []): Promise<string> => {
  try {
    await admin.pool.query(text, params);
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};

describe('0041 admin_data_access·cs_case.account_id(실제 PostgreSQL 18)', () => {
  test('R-T27 ③ 0041이 적용되어 admin_data_access 칸·CHECK·인덱스와 cs_case.account_id가 있다', async () => {
    const applied = (await admin.pool.query<{ name: string }>("select name from ops_migration where name = '0041_admin_data_access_inquiry.sql'")).rows;
    expect(applied).toHaveLength(1);
    const cols = (
      await admin.pool.query<{ column_name: string; is_nullable: string; udt_name: string }>(
        "select column_name, is_nullable, udt_name from information_schema.columns where table_schema = 'public' and table_name = 'admin_data_access' order by ordinal_position",
      )
    ).rows;
    expect(cols.map((c) => c.column_name)).toEqual([
      'id', 'admin_account_id', 'actor_role', 'promoter_id', 'action', 'target_kind', 'event_id', 'filter',
      'occurred_at', 'reason', 'target_count', 'format', 'source_ip', 'source_service', 'recorded_at', 'retain_until',
    ]);
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    expect(byName.get('source_ip')?.udt_name).toBe('inet');
    expect(byName.get('filter')?.udt_name).toBe('jsonb');
    expect(byName.get('retain_until')?.is_nullable).toBe('NO');
    const checks = new Map(
      (await admin.pool.query<{ conname: string; def: string }>("select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'admin_data_access'::regclass and contype = 'c'")).rows.map((r) => [r.conname, r.def]),
    );
    expect(checks.get('admin_data_access_action_check')).toContain('VIEW_UNMASKED');
    expect(checks.get('admin_data_access_target_check')).toContain('FAN_PROFILE');
    const idx = (await admin.pool.query<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'public' and tablename = 'admin_data_access'")).rows.map((r) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining(['admin_data_access_admin_idx', 'admin_data_access_target_idx']));
    const accountCol = (await admin.pool.query<{ is_nullable: string; udt_name: string }>("select is_nullable, udt_name from information_schema.columns where table_schema = 'public' and table_name = 'cs_case' and column_name = 'account_id'")).rows;
    expect(accountCol).toEqual([{ is_nullable: 'YES', udt_name: 'uuid' }]);
    const caseIdx = (await admin.pool.query<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'public' and tablename = 'cs_case' and indexname = 'cs_case_account_idx'")).rows;
    expect(caseIdx).toHaveLength(1);
    const grants = (
      await admin.pool.query<{ access: boolean; cases: boolean }>(
        "select has_table_privilege('ops_app', 'admin_data_access', 'SELECT,INSERT,UPDATE,DELETE') as access, has_table_privilege('ops_app', 'cs_case', 'SELECT,INSERT,UPDATE,DELETE') as cases",
      )
    ).rows[0]!;
    expect(grants).toEqual({ access: true, cases: true });
    expect(await codeOf("insert into admin_data_access (id, admin_account_id, actor_role, action, target_kind, occurred_at, source_service, recorded_at, retain_until) values ($1, $2, 'cs_agent', 'READ', 'FAN_PROFILE', now(), 'ops-svc', now(), now())", [randomUUID(), randomUUID()])).toBe('23514');
    expect(await codeOf("insert into admin_data_access (id, admin_account_id, actor_role, action, target_kind, occurred_at, source_service, recorded_at, retain_until) values ($1, $2, 'cs_agent', 'VIEW_UNMASKED', 'ORDER', now(), 'ops-svc', now(), now())", [randomUUID(), randomUUID()])).toBe('23514');
  });
});

describe('Drizzle 접속기록·가린 값 열람·계정 채움(실제 PostgreSQL 18)', () => {
  test('R-T27 ③ 가린 값을 사유와 함께 열면 admin_data_access에 접속지·대상 건수·2년 보존이 남는다', async () => {
    const adminAccountId = randomUUID();
    const profile = { accountId: randomUUID(), memberCode: 'M-0001', nickname: '별빛', status: 'ACTIVE', name: '홍길동', phone: '010-1234-5678', email: 'hong@example.com' };
    const audit: Array<Record<string, unknown>> = [];
    lookup = new FanLookup({
      wiring: { profile: { get: async (id) => (id === profile.accountId ? profile : undefined), resolve: async () => profile.accountId }, access },
      audit: { append: async (r) => { audit.push(r as unknown as Record<string, unknown>); } },
      clock,
    });
    const out = await lookup.unmask(profile.accountId, { fields: ['NAME', 'PHONE'], reason: '고객 요청 확인' }, { accountId: adminAccountId, role: 'cs_agent' }, '203.0.113.7');
    expect(out).toMatchObject({ name: '홍길동', phone: '010-1234-5678', reason: '고객 요청 확인', unmaskedAt: new Date(NOW).toISOString() });
    expect(out).not.toHaveProperty('email');
    const row = (await admin.pool.query<Record<string, unknown>>("select * from admin_data_access where admin_account_id = $1 and action = 'VIEW_UNMASKED'", [adminAccountId])).rows[0]!;
    expect(row).toMatchObject({
      admin_account_id: adminAccountId,
      actor_role: 'cs_agent',
      action: 'VIEW_UNMASKED',
      target_kind: 'FAN_PROFILE',
      reason: '고객 요청 확인',
      target_count: 2,
      source_ip: '203.0.113.7',
      source_service: 'ops-svc',
    });
    expect((row.retain_until as Date).getTime()).toBe(Date.UTC(2028, 10, 27, 5, 0, 0));
    const recent = await access.recent(adminAccountId, NOW - DAY);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ source_ip: '203.0.113.7', target_kind: 'FAN_PROFILE' });
    expect(await access.recent(randomUUID(), NOW - DAY)).toHaveLength(0);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ recordType: 'ADMIN_DATA_ACCESS_RECORDED', payload: { fields: ['NAME', 'PHONE'], sourceService: 'ops-svc' } });
  });

  test('R-T27 ③ 문의 건을 열 때 core 계정을 cs_case.account_id에 채우고 그 계정의 건만 찾는다', async () => {
    const accountId = randomUUID();
    const other = randomUUID();
    const inquiryId = randomUUID();
    const receive = new ReceiveCaseRequested(cases, {
      calendar: weekendOnlyCalendar,
      supportCases: { read: async (id) => (id === inquiryId ? { accountId } : undefined) },
    });
    const payload = { eventKey: `inquiry-${inquiryId}`, kind: 'INQUIRY' as const, sourceId: inquiryId, category: 'OTHER', createdAt: new Date(NOW).toISOString() };
    const opened = await receive.handle(payload, NOW);
    expect(opened.result).toBe('opened');
    expect(opened.case?.accountId).toBe(accountId);
    const row = (await admin.pool.query<{ account_id: string | null }>('select account_id from cs_case where id = $1', [opened.case!.caseId])).rows[0]!;
    expect(row.account_id).toBe(accountId);
    const duplicate = await receive.handle(payload, NOW + 1_000);
    expect(duplicate.result).toBe('duplicate');
    expect(duplicate.case?.caseId).toBe(opened.case!.caseId);

    const mine = await cases.list({ statuses: ['OPEN'], accountId, limit: 20 });
    expect(mine.map((c) => c.caseId)).toEqual([opened.case!.caseId]);
    expect(await cases.list({ statuses: ['OPEN'], accountId: other, limit: 20 })).toHaveLength(0);
    const found = await cases.find(opened.case!.caseId);
    expect(found?.accountId).toBe(accountId);
  });
});
