// 멱등 기록 표 행 보안 마이그레이션 0041의 옛 기록 옮김 시험(실제 PostgreSQL 18, AZ-T17 ⑦, W12-core-idem).
// 정본: ADR-0337 결정 2 — 0041은 이미 있는 파트너 기록의 테넌트 칸을 결과 참조로 채운다. 공연 등록은 productionId의 공연 판매자, 회차 더하기는 eventId의 회차 판매자,
// 아직 회차 행이 없는 변경분 회차는 그 eventId를 pending_revision.addedEvents에 가진 공연의 판매자다. JSON이 아닌 결과 참조는 건너뛴다(변환 오류로 멈추지 않게).
// 못 채운 행과 팬·관제 기록은 비어 있고(NULL) 어느 파트너에게도 보이지 않는다.
// 0040까지만 올린 DB(옮긴 마이그레이션 폴더의 사본, shop-migration.int.test.ts와 같은 꼴)에 옛 기록을 소유자로 넣고 전체를 올린다.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, type Database, requestFingerprint } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

let container: PostgresContainer;
let admin: Database;
let partner: Database;
let partial: string;

const A = randomUUID();
const B = randomUUID();
const PLACE = randomUUID();
const PA = randomUUID();
const EA = randomUUID();
const PB = randomUUID();
/** PB의 변경분 회차(아직 event 행이 없다) */
const EP = randomUUID();
const T = new Date('2026-12-08T03:20:00.000Z');

/** 옛 기록(0041 전). tenant는 0041 뒤 기대하는 테넌트 칸 값 */
const OLD = {
  production: { account: randomUUID(), operation: 'CREATE_PRODUCTION', key: randomUUID(), ref: JSON.stringify({ productionId: PA, eventIds: [EA], warnings: [] }), tenant: A },
  event: { account: randomUUID(), operation: 'CREATE_PRODUCTION_EVENT', key: randomUUID(), ref: JSON.stringify({ eventId: EA, pending: false, warnings: [] }), tenant: A },
  pendingEvent: { account: randomUUID(), operation: 'CREATE_PRODUCTION_EVENT', key: randomUUID(), ref: JSON.stringify({ eventId: EP, pending: true, warnings: [] }), tenant: B },
  notJson: { account: randomUUID(), operation: 'CREATE_PRODUCTION', key: randomUUID(), ref: 'x', tenant: null },
  /** JSON이지만 ID가 UUID 꼴이 아니다(글로 견주면 변환 오류 없이 건너뛴다) */
  badId: { account: randomUUID(), operation: 'CREATE_PRODUCTION_EVENT', key: randomUUID(), ref: JSON.stringify({ eventId: 'not-a-uuid', pending: false, warnings: [] }), tenant: null },
  fan: { account: randomUUID(), operation: 'CREATE_MERCH_ORDER', key: randomUUID(), ref: randomUUID(), tenant: null },
  ops: { account: randomUUID(), operation: 'CREATE_OPS_PROMOTER', key: randomUUID(), ref: A, tenant: null },
} as const;

/** 리뷰 RV5: 변경분 회차에 eventId가 빈(null) 원소를 가진 판매자 X의 공연. 정상 코드는 만들지 않지만 백필은 이런 행에도 엉뚱한 테넌트를 붙이지 않아야 한다 */
const X = randomUUID();
const PX = randomUUID();
/** 리뷰 RV5: eventId를 읽지 못하는 옛 회차 더하기 기록(어느 판매자도 정할 수 없어 비어 있어야 한다) */
const NO_EVENT = {
  nullEventId: { account: randomUUID(), operation: 'CREATE_PRODUCTION_EVENT', key: randomUUID(), ref: JSON.stringify({ eventId: null, pending: true, warnings: [] }) },
  missingEventId: { account: randomUUID(), operation: 'CREATE_PRODUCTION_EVENT', key: randomUUID(), ref: JSON.stringify({ pending: true, warnings: [] }) },
  notJson: { account: randomUUID(), operation: 'CREATE_PRODUCTION_EVENT', key: randomUUID(), ref: 'y' },
} as const;

/** 마이그레이션 폴더를 사본으로 옮기고 일지를 lastIdx까지로 자른다 */
function migrationsUpTo(lastIdx: number): string {
  const src = fileURLToPath(new URL('../migrations', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'core-mig-idem-'));
  cpSync(src, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= lastIdx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

async function migrateFolder(url: string, folder: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder: folder });
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  container = await startPostgres();
  partial = migrationsUpTo(40);
  await migrateFolder(container.url, partial);
  admin = createDatabase({ url: container.url, applicationName: 'core-svc-idempotency-migration-int', max: 2 });
  const q = (text: string, params: unknown[]) => admin.pool.query(text, params);
  await q('insert into promoter (id, legal_name) values ($1, $2), ($3, $4)', [A, '(주)에이', B, '(주)비']);
  await q("insert into place (id, name, address, region, created_by) values ($1, '피켓홀', '서울 어딘가 1', '서울', $2)", [PLACE, randomUUID()]);
  await q("insert into production (id, promoter_id, place_id, title, genre, sale_review) values ($1, $2, $3, 'A 공연', '콘서트', 'DRAFT')", [PA, A, PLACE]);
  await q('insert into event (id, production_id, promoter_id, venue_id, open_at, starts_at, ends_at) values ($1, $2, $3, null, $4, $5, $6)', [
    EA,
    PA,
    A,
    new Date('2027-01-05T11:00:00Z'),
    new Date('2027-02-01T10:00:00Z'),
    new Date('2027-02-01T12:00:00Z'),
  ]);
  // 승인된 B 공연의 변경분 회차(재승인 전이라 event 행이 없다, ADR-0198 결정 3)
  const added = { eventId: EP, openAt: '2027-01-06T11:00:00.000Z', startsAt: '2027-02-02T10:00:00.000Z', endsAt: '2027-02-02T12:00:00.000Z', addedAt: '2026-12-08T03:00:00.000Z' };
  await q("insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at, pending_revision) values ($1, $2, $3, 'B 공연', '콘서트', 'SUBMITTED', $4, $5::jsonb)", [
    PB,
    B,
    PLACE,
    new Date('2026-11-01T00:00:00Z'),
    JSON.stringify({ addedEvents: [added] }),
  ]);
  await q('insert into promoter (id, legal_name) values ($1, $2)', [X, '(주)엑스']);
  await q("insert into production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at, pending_revision) values ($1, $2, $3, 'X 공연', '콘서트', 'SUBMITTED', $4, $5::jsonb)", [
    PX,
    X,
    PLACE,
    new Date('2026-11-01T00:00:00Z'),
    JSON.stringify({ addedEvents: [{ ...added, eventId: null }, { ...added, eventId: randomUUID() }] }),
  ]);
  for (const r of [...Object.values(OLD), ...Object.values(NO_EVENT)]) {
    await q('insert into idempotency_record (account_ref, operation, idempotency_key, request_hash, result_ref, created_at) values ($1, $2, $3, $4, $5, $6)', [
      r.account,
      r.operation,
      r.key,
      Buffer.from(requestFingerprint('POST', `/az-t17-7/${r.key}`, undefined)),
      r.ref,
      T,
    ]);
  }
  await migrateCore(container.url);
  partner = await loginFor(admin, container, 'core_partner_login', 'core_partner', 1);
});
afterAll(async () => {
  await partner?.close();
  await admin?.close();
  container?.stop();
  if (partial) rmSync(partial, { recursive: true, force: true });
});

const keysIn = async (tenantId: string): Promise<string[]> =>
  partner.transaction(async (tx) => (await tx.execute(sql`select idempotency_key from idempotency_record`)).rows.map((r) => String(r.idempotency_key)).sort(), { tenantId });

describe('AZ-T17 멱등 기록 표 0041 옮김', () => {
  test('AZ-T17 ⑦ 0040까지 올린 DB의 파트너 기록은 0041 뒤 그 공연·회차의 판매자 테넌트가 들어 그 테넌트에서만 보이고 팬·관제 기록과 JSON이 아닌 기록은 비어 있다 [ASVS v5.0.0-8.4.1]', async () => {
    const rows = (await admin.pool.query('select idempotency_key, tenant_id, result_ref from idempotency_record')).rows as { idempotency_key: string; tenant_id: string | null; result_ref: string }[];
    const byKey = new Map(rows.map((r) => [r.idempotency_key, r]));
    for (const [name, r] of Object.entries(OLD)) {
      // 결과 참조는 그대로 두고 테넌트 칸만 채운다
      expect({ name, tenant: byKey.get(r.key)?.tenant_id, ref: byKey.get(r.key)?.result_ref }).toEqual({ name, tenant: r.tenant, ref: r.ref });
    }
    expect(rows).toHaveLength(Object.keys(OLD).length + Object.keys(NO_EVENT).length);
    expect(await keysIn(A)).toEqual([OLD.production.key, OLD.event.key].sort());
    expect(await keysIn(B)).toEqual([OLD.pendingEvent.key]);
    // 못 채운 행은 어느 테넌트에도 보이지 않는다
    const nobody: string[] = [OLD.notJson.key, OLD.badId.key, OLD.fan.key, OLD.ops.key];
    for (const t of [A, B, randomUUID()]) expect((await keysIn(t)).filter((k) => nobody.includes(k)), t).toEqual([]);
  });

  test('AZ-T17 ⑦ 리뷰 재현(RV5): eventId가 null이거나 없거나 JSON이 아닌 옛 회차 더하기 기록은 eventId가 빈 변경분 회차를 가진 다른 판매자의 공연에 붙지 않고 비어 있다 [ASVS v5.0.0-8.4.1]', async () => {
    const keys = Object.values(NO_EVENT).map((r) => r.key);
    const rows = (await admin.pool.query('select idempotency_key, tenant_id, result_ref from idempotency_record where idempotency_key = any($1::uuid[])', [keys])).rows as { idempotency_key: string; tenant_id: string | null; result_ref: string }[];
    const byKey = new Map(rows.map((r) => [r.idempotency_key, r]));
    for (const [name, r] of Object.entries(NO_EVENT)) {
      expect({ name, tenant: byKey.get(r.key)?.tenant_id, ref: byKey.get(r.key)?.result_ref }).toEqual({ name, tenant: null, ref: r.ref });
    }
    // 판매자 X의 파트너 트랜잭션에도, 다른 테넌트에도 보이지 않는다
    for (const t of [X, A, B]) expect((await keysIn(t)).filter((k) => (keys as string[]).includes(k)), t).toEqual([]);
  });
});
