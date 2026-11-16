// A2-19(W7-audit): 예매자 명단 접속기록(attendee_export_audit)을 실제 PostgreSQL 18에서 본다(J-T26 ⑤⑥, docs/data.md §2 '예매자 명단 내려받기 이력과 접속기록').
// 0021 뒤 LIST·DOWNLOAD 두 모양이 들어가고 틀린 모양은 CHECK가 거절하며, 내려받기 이력과 DOWNLOAD 행은 한 트랜잭션이라 접속기록이 실패하면 이력도 남지 않는다.
// 저장은 운영과 같은 파트너 DB 역할(core_partner, 행 보안)로 하고, 확인은 저장소를 거치지 않고 관리자 풀의 직접 SQL로 읽는다.
// 리뷰 R2: 0021 뒤 새 행은 접속지(source_ip, inet)가 꼭 있어야 하므로(NOT VALID CHECK) 직접 넣는 준비에도 접속지를 넣는다.
import 'reflect-metadata';
import { createDatabase, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pgLib from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { DrizzleAttendeeExportStore } from '../src/modules/export/adapters/db/drizzle-export-store.js';
import type { AttendeeExportRecord } from '../src/modules/export/domain/export.js';
import type { AttendeeViewRecord } from '../src/modules/export/domain/ports.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

let pg: PostgresContainer;
let admin: Database;
let partner: Database;
let store: DrizzleAttendeeExportStore;
const A = randomUUID();
const B = randomUUID();
const EVENT = randomUUID();
const ACCOUNT = randomUUID();
const createdAt = new Date('2026-11-15T00:00:00Z');

const record = (o: Partial<AttendeeExportRecord> = {}): AttendeeExportRecord => ({
  exportId: randomUUID(),
  promoterId: A,
  eventId: EVENT,
  actorAccountId: ACCOUNT,
  actorDisplayName: '스텔라 관리자',
  actorRole: 'partner_admin',
  reason: '현장 명단 대조',
  format: 'CSV',
  count: 2,
  result: 'COMPLETED',
  createdAt,
  expiresAt: new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000),
  ...o,
});

const view = (o: Partial<AttendeeViewRecord> = {}): AttendeeViewRecord => ({
  auditId: randomUUID(),
  promoterId: A,
  eventId: EVENT,
  actorAccountId: ACCOUNT,
  actorDisplayName: '파트너 관리자',
  actorRole: 'partner_admin',
  count: 49,
  filter: { limit: 50, cursor: 'opaque-c' },
  createdAt,
  clientIp: '198.51.100.30',
  ...o,
});

interface AuditRow {
  id: string;
  action: string;
  export_id: string | null;
  promoter_id: string;
  reason: string | null;
  format: string | null;
  count: number;
  filter: unknown;
  created_at: Date;
  retain_until: Date;
}

const auditRow = async (id: string): Promise<AuditRow | undefined> =>
  (await admin.pool.query<AuditRow>('select id, action, export_id, promoter_id, reason, format, count, filter, created_at, retain_until from attendee_export_audit where id = $1', [id])).rows[0];

/** 관리자(행 보안 밖)로 접속기록 한 행을 직접 넣는다. CHECK만 겨룬다 */
const rawAudit = (o: { id?: string; action: string; exportId: string | null; reason: string | null; format: string | null; sourceIp?: string }) =>
  admin.pool.query(
    `insert into attendee_export_audit (id, action, export_id, promoter_id, event_id, actor_account_id, actor_display_name, actor_role, reason, format, count, filter, created_at, retain_until, source_ip)
     values ($1, $2, $3, $4, $5, $6, '관리자', 'partner_admin', $7, $8, 1, '{}'::jsonb, $9, $10, $11)`,
    [o.id ?? randomUUID(), o.action, o.exportId, A, EVENT, ACCOUNT, o.reason, o.format, createdAt, new Date('2028-11-15T00:00:00Z'), o.sourceIp ?? '198.51.100.30'],
  );

const sourceIpOf = async (id: string): Promise<string | null | undefined> =>
  (await admin.pool.query<{ ip: string | null }>('select host(source_ip) as ip from attendee_export_audit where id = $1', [id])).rows[0]?.ip;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-export-audit-admin', max: 2 });
  partner = await loginFor(admin, pg, 'core_partner_export_audit', 'core_partner', 2);
  store = new DrizzleAttendeeExportStore(partner);
});
afterAll(async () => {
  await partner?.close();
  await admin?.close();
  pg?.stop();
});

describe('A2-19 접속기록 표(실제 DB)', () => {
  test('A2-19 J-T26 ⑥ 접속기록 넣기가 실패하면 attendee_export도 남지 않는다', async () => {
    const r = record();
    // 같은 테넌트로 id = exportId인 접속기록 행을 먼저 넣어 두면 recordExport의 둘째 넣기가 유일 위반으로 실패한다
    await partner.transaction(
      async (tx) =>
        tx.execute(sql`insert into attendee_export_audit (id, export_id, promoter_id, event_id, actor_account_id, actor_display_name, actor_role, reason, format, count, created_at, retain_until, source_ip)
          values (${r.exportId}, ${r.exportId}, ${A}, ${EVENT}, ${ACCOUNT}, '먼저 넣은 행', 'partner_admin', '충돌 만들기', 'CSV', 1, ${createdAt}, ${new Date('2028-11-15T00:00:00Z')}, '198.51.100.30')`),
      { tenantId: A, accessMode: 'read write' },
    );

    await expect(store.recordExport(r, { clientIp: '198.51.100.30' })).rejects.toMatchObject({ cause: { code: '23505' } });
    const left = await admin.pool.query('select count(*)::int as n from attendee_export where id = $1', [r.exportId]);
    expect(left.rows[0].n).toBe(0);
    // 먼저 넣은 행 하나뿐이다
    expect((await auditRow(r.exportId))?.reason).toBe('충돌 만들기');
  });

  test('A2-19 J-T26 ⑤⑥ 0021 뒤 LIST·DOWNLOAD 행이 들어가고 모양이 틀리면 CHECK가 거절한다', async () => {
    const v = view();
    await store.recordView(v);
    expect(await auditRow(v.auditId)).toEqual({
      id: v.auditId,
      action: 'LIST',
      export_id: null,
      promoter_id: A,
      reason: null,
      format: null,
      count: 49,
      filter: { limit: 50, cursor: 'opaque-c' },
      created_at: createdAt,
      // 만든 때 + 2년(UTC 달력). 730일이면 2028-11-14다
      retain_until: new Date('2028-11-15T00:00:00Z'),
    });

    const r = record({ createdAt: new Date('2028-02-29T12:00:00Z') });
    await store.recordExport(r, { clientIp: '198.51.100.30' });
    expect(await auditRow(r.exportId)).toEqual({
      id: r.exportId,
      action: 'DOWNLOAD',
      export_id: r.exportId,
      promoter_id: A,
      reason: '현장 명단 대조',
      format: 'CSV',
      count: 2,
      filter: {},
      created_at: new Date('2028-02-29T12:00:00Z'),
      retain_until: new Date('2030-03-01T12:00:00Z'),
    });
    const history = await admin.pool.query('select count(*)::int as n from attendee_export where id = $1', [r.exportId]);
    expect(history.rows[0].n).toBe(1);

    // 틀린 모양: 사유 있는 LIST, export_id 없는 DOWNLOAD, 모르는 종류
    await expect(rawAudit({ action: 'LIST', exportId: null, reason: '보기에 사유', format: null })).rejects.toMatchObject({ code: '23514' });
    await expect(rawAudit({ action: 'DOWNLOAD', exportId: null, reason: '사유', format: 'CSV' })).rejects.toMatchObject({ code: '23514' });
    await expect(rawAudit({ action: 'VIEW', exportId: null, reason: null, format: null })).rejects.toMatchObject({ code: '23514' });
    // 대조군: 맞는 두 모양은 직접 넣어도 들어간다
    await rawAudit({ action: 'LIST', exportId: null, reason: null, format: null });
    const id = randomUUID();
    await rawAudit({ id, action: 'DOWNLOAD', exportId: id, reason: '사유', format: 'XLSX' });
  });

  test('A2-19 core_partner는 접속기록을 고치거나 지우지 못하고 다른 테넌트 행을 읽지 못한다 [ASVS v5.0.0-8.4.1]', async () => {
    const v = view();
    await store.recordView(v);
    await expect(partner.transaction(async (tx) => tx.execute(sql`update attendee_export_audit set count = 0 where id = ${v.auditId}`), { tenantId: A, accessMode: 'read write' })).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await expect(partner.transaction(async (tx) => tx.execute(sql`delete from attendee_export_audit where id = ${v.auditId}`), { tenantId: A, accessMode: 'read write' })).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    expect((await auditRow(v.auditId))?.count).toBe(49);

    const seenByB = await partner.transaction(async (tx) => tx.execute(sql`select id from attendee_export_audit where promoter_id = ${A}`), { tenantId: B });
    expect(seenByB.rows).toHaveLength(0);
    const seenByA = await partner.transaction(async (tx) => tx.execute(sql`select id from attendee_export_audit where id = ${v.auditId}`), { tenantId: A });
    expect(seenByA.rows).toHaveLength(1);
  });

  test('A2-19 R2 K1 0021 뒤 접속지 없는 새 행도 DB는 받고(이전 판 호환), IP 모양이 아닌 값은 inet이 거절한다', async () => {
    // 웨이브 끝 리뷰 K1: 0021은 칸만 더한다(NULL 허용). 접속지 칸 없이 넣기도 DB는 받는다(접속지 빠짐 거절은 앱이 한다. CHECK는 다음 출시, docs/data.md §2 source_ip)
    const noIp = randomUUID();
    await admin.pool.query(
      `insert into attendee_export_audit (id, action, export_id, promoter_id, event_id, actor_account_id, actor_display_name, actor_role, reason, format, count, filter, created_at, retain_until)
       values ($1, 'LIST', null, $2, $3, $4, '관리자', 'partner_admin', null, null, 1, '{}'::jsonb, $5, $6)`,
      [noIp, A, EVENT, ACCOUNT, createdAt, new Date('2028-11-15T00:00:00Z')],
    );
    expect(await sourceIpOf(noIp)).toBeNull();
    // IP 모양이 아닌 값은 inet이 거절한다
    await expect(rawAudit({ action: 'LIST', exportId: null, reason: null, format: null, sourceIp: 'abc' })).rejects.toMatchObject({ code: '22P02' });
    // IPv6는 들어가고 같은 값으로 읽힌다
    const v6 = randomUUID();
    await rawAudit({ id: v6, action: 'LIST', exportId: null, reason: null, format: null, sourceIp: '2001:db8::1' });
    expect(await sourceIpOf(v6)).toBe('2001:db8::1');

    // 저장소로 넣은 LIST·DOWNLOAD 행의 접속지는 넘긴 IP다
    const v = view({ clientIp: '203.0.113.7' });
    await store.recordView(v);
    expect(await sourceIpOf(v.auditId)).toBe('203.0.113.7');
    const r = record();
    await store.recordExport(r, { clientIp: '2001:db8::5' });
    expect(await sourceIpOf(r.exportId)).toBe('2001:db8::5');
  });

  test('A2-19 K1 0021 뒤에도 이전 판(N-1) 코드의 내려받기 기록 모양이 들어간다', async () => {
    // 853758eb 판의 DrizzleAttendeeExportStore.audit가 쓰던 칸만(action·filter·source_ip 없이), 운영과 같은 core_partner·테넌트로 넣는다(docs/devops.md §7.3 적용 시험 ③의 작은 꼴)
    const id = randomUUID();
    await partner.transaction(
      async (tx) =>
        tx.execute(sql`insert into attendee_export_audit (id, export_id, promoter_id, event_id, actor_account_id, actor_display_name, actor_role, reason, format, count, created_at, retain_until)
          values (${id}, ${id}, ${A}, ${EVENT}, ${ACCOUNT}, '이전 판', 'partner_admin', '이전 판 내려받기', 'CSV', 3, ${createdAt}, ${new Date('2028-11-15T00:00:00Z')})`),
      { tenantId: A, accessMode: 'read write' },
    );
    const row = (await admin.pool.query('select action, filter, host(source_ip) as ip from attendee_export_audit where id = $1', [id])).rows[0];
    expect(row).toEqual({ action: 'DOWNLOAD', filter: {}, ip: null });
  });

  test('A2-19 K6 0019 행이 있는 DB에 0021·0022를 적용해도 실패하지 않고 옛 행은 그대로다', async () => {
    // 새 DB에 0020까지 적용 → 0019 모양 행 하나 → 나머지(0021·0022) 적용(정확성 리뷰 C3과 같은 시험)
    const dbName = `k6_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await admin.pool.query(`create database ${dbName}`);
    const url = `postgres://postgres:peaket-test@${pg.host}:${pg.port}/${dbName}`;
    const folder = mkdtempSync(join(tmpdir(), 'core-mig-0020-'));
    try {
      const all = fileURLToPath(new URL('../migrations', import.meta.url));
      const journal = JSON.parse(readFileSync(join(all, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
      const upTo20 = { ...journal, entries: journal.entries.filter((e) => e.idx <= 20) };
      expect(upTo20.entries.map((e) => e.idx).at(-1)).toBe(20);
      mkdirSync(join(folder, 'meta'));
      writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(upTo20));
      for (const e of upTo20.entries) copyFileSync(join(all, `${e.tag}.sql`), join(folder, `${e.tag}.sql`));
      await migrateFolder(url, folder);

      const old = new pgLib.Client({ connectionString: url });
      await old.connect();
      const id = randomUUID();
      try {
        await old.query(
          `insert into attendee_export_audit (id, export_id, promoter_id, event_id, actor_account_id, actor_display_name, actor_role, reason, format, count, created_at, retain_until)
           values ($1, $1, $2, $3, $4, '0019 행', 'partner_admin', '옛 내려받기', 'XLSX', 5, $5, $6)`,
          [id, A, EVENT, ACCOUNT, createdAt, new Date('2028-11-15T00:00:00Z')],
        );
        // 0021·0022 적용(실패하지 않는다)
        await migrateCore(url);
        const row = (await old.query('select action, filter, host(source_ip) as ip, reason, format, count from attendee_export_audit where id = $1', [id])).rows[0];
        expect(row).toEqual({ action: 'DOWNLOAD', filter: {}, ip: null, reason: '옛 내려받기', format: 'XLSX', count: 5 });
        // action·모양 CHECK 둘은 NOT VALID로 더해져 아직 검증되지 않았다
        const checks = (
          await old.query(
            `select conname, convalidated from pg_constraint where conrelid = 'attendee_export_audit'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%action%'`,
          )
        ).rows as { conname: string; convalidated: boolean }[];
        expect(checks).toHaveLength(2);
        for (const c of checks) expect(c.convalidated, c.conname).toBe(false);
      } finally {
        await old.end();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

/** 지정한 마이그레이션 폴더를 적용한다(scripts/migrate.mjs의 migrateCore와 같은 방식, 폴더만 다르다) */
async function migrateFolder(url: string, folder: string): Promise<void> {
  const client = new pgLib.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: folder });
  } finally {
    await client.end();
  }
}
