// purchase DB의 좌석 표 넷(seat_sale·purchase_quota·seat_hold·seat_rebuild)의 모양을 DB 없이 본다(docs/data.md §4 'purchase DB의 좌석 표 마이그레이션'·
// '다시 만들기 표와 원장 칸'(BUILD_ORDER PRF-143), §2 ERD, BUILD_ORDER PRF-140 ①).
// ① Drizzle 표 정의(schema.ts)를 getTableConfig로 읽어 표·열·기본 키·부분 유일 인덱스·check 제약 이름과 식이 정본과 같은지 보고,
// ② 마이그레이션 SQL 파일(0000 좌석 표, 0002 다시 만들기 표·원장 칸)을 글로 읽어 파티션 선언(seat_hold만, DEFAULT 파티션 없음)과 표 정의 ↔ SQL 일치를 보고,
// ③ 마이그레이션 기록(meta)이 맞물리는지 본다.
// 실제 PostgreSQL에서 돌려 보는 것은 test-int/purchase-migration.int.test.ts다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import { purchaseQuota, seatHold, seatRebuild, seatSale } from '../src/modules/inventory/adapters/db/schema.js';
import { SEAT_SALE_STATUSES } from '../src/modules/inventory/domain/seat-sale.js';

const MIGRATIONS = join(fileURLToPath(new URL('..', import.meta.url)), 'migrations');
const TAG = '0000_purchase_seat_tables';
/** 보류 표 held_event·정비 통계 stat_snapshot(platform 템플릿 0003을 옮김, BUILD_ORDER PRF-141) */
const HELD_TAG = '0001_held_event_and_stat_snapshot';
/** 다시 만들기 표 seat_rebuild와 원장 칸 seat_hold.hold_id·purchase_session_id(BUILD_ORDER PRF-143) */
const REBUILD_TAG = '0002_seat_rebuild_and_hold_ids';
const BREAKPOINT = '--> statement-breakpoint';
const dialect = new PgDialect();

/**
 * SQL 글을 견주기 좋게 줄인다: 표 이름 한정자("t".)와 따옴표를 지우고, 따옴표 밖 글만 소문자로, 공백을 접고, 괄호·쉼표 둘레 공백을 없앤다.
 * 작은따옴표 안의 값('PENDING' 등)은 대소문자까지 그대로 둔다
 */
function canon(s: string): string {
  return s
    .split("'")
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/"[a-z_]+"\./g, '').replace(/"/g, '').replace(/\s+/g, ' ').toLowerCase().replace(/ ?([(),]) ?/g, '$1')))
    .join("'")
    .trim();
}
const sqlText = (s: SQL): string => dialect.sqlToQuery(s).sql;
/** 작은따옴표로 싼 값들(in 목록) */
const literalsOf = (s: string): string[] => [...s.matchAll(/'([^']*)'/g)].map((m) => m[1]!);

interface Shape {
  name: string;
  columns: { name: string; type: string; notNull: boolean; hasDefault: boolean; primary: boolean }[];
  primaryKeys: { name: string; columns: string[] }[];
  indexes: { name: string; unique: boolean; columns: string[]; where: string | undefined }[];
  checks: { name: string; expr: string }[];
}
function shapeOf(table: PgTable): Shape {
  const c = getTableConfig(table);
  return {
    name: c.name,
    columns: c.columns.map((col) => ({ name: col.name, type: col.getSQLType(), notNull: col.notNull, hasDefault: col.hasDefault, primary: col.primary })),
    primaryKeys: c.primaryKeys.map((p) => ({ name: p.getName(), columns: p.columns.map((x) => x.name) })),
    indexes: c.indexes.map((i) => ({
      name: i.config.name ?? '(이름 없음)',
      unique: i.config.unique,
      columns: i.config.columns.map((x) => (x as { name: string }).name),
      where: i.config.where ? canon(sqlText(i.config.where)) : undefined,
    })),
    checks: c.checks.map((k) => ({ name: k.name, expr: canon(sqlText(k.value)) })),
  };
}
const sale = shapeOf(seatSale);
const quota = shapeOf(purchaseQuota);
const hold = shapeOf(seatHold);
const rebuild = shapeOf(seatRebuild);
const SHAPES = [sale, quota, hold, rebuild];

const TZ = 'timestamp with time zone';
/** [열 이름, 종류, 널 불허] */
const cols = (s: Shape): [string, string, boolean][] => s.columns.map((c) => [c.name, c.type, c.notNull]);

describe('표 정의(schema.ts)', () => {
  test('표는 seat_sale·purchase_quota·seat_hold·seat_rebuild 넷이고 모두 기본 스키마(public)에 있다', () => {
    expect(SHAPES.map((s) => s.name)).toEqual(['seat_sale', 'purchase_quota', 'seat_hold', 'seat_rebuild']);
    for (const t of [seatSale, purchaseQuota, seatHold, seatRebuild]) expect(getTableConfig(t).schema).toBeUndefined();
  });

  test('모든 열 이름은 소문자 snake_case다', () => {
    for (const s of SHAPES) for (const c of s.columns) expect(c.name, `${s.name}.${c.name}`).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  test('seat_sale의 열 이름·종류·널 허용이 정본과 같다(pending_until만 비울 수 있다)', () => {
    expect(cols(sale)).toEqual([
      ['event_id', 'uuid', true],
      ['seat_id', 'uuid', true],
      ['order_id', 'uuid', true],
      ['account_id', 'uuid', true],
      ['status', 'text', true],
      ['reserved_at', TZ, true],
      ['pending_until', TZ, false],
    ]);
  });

  test('purchase_quota의 열 이름·종류·널 허용이 정본과 같다(모두 널 불허, used·limit_count는 int)', () => {
    expect(cols(quota)).toEqual([
      ['account_id', 'uuid', true],
      ['event_id', 'uuid', true],
      ['used', 'integer', true],
      ['limit_count', 'integer', true],
    ]);
  });

  test('seat_hold의 열 이름·종류·널 허용이 정본과 같다(priority_grant_id·held_at·hold_id·purchase_session_id만 비울 수 있다. hold_id uuid·purchase_session_id text는 PRF-143) [ASVS v5.0.0-2.3.4]', () => {
    expect(cols(hold)).toEqual([
      ['event_id', 'uuid', true],
      ['seat_id', 'uuid', true],
      ['account_id', 'uuid', true],
      ['fencing_token', 'bigint', true],
      ['status', 'text', true],
      ['kind', 'text', true],
      ['priority_grant_id', 'uuid', false],
      ['held_at', TZ, false],
      ['expires_at', TZ, true],
      // 0002의 ADD COLUMN이 표 끝에 붙이므로 DB 칸 차례와 같게 expires_at 뒤다(PRF-143)
      ['hold_id', 'uuid', false],
      ['purchase_session_id', 'text', false],
    ]);
  });

  test('seat_rebuild의 열 이름·종류·널 허용이 정본과 같다(event_id uuid·gen int는 널 불허, holder·lease_until은 비울 수 있다, PRF-143)', () => {
    expect(cols(rebuild)).toEqual([
      ['event_id', 'uuid', true],
      ['gen', 'integer', true],
      ['holder', 'text', false],
      ['lease_until', TZ, false],
    ]);
  });

  test('기본값은 seat_sale.reserved_at(now())·seat_hold.kind(\'FAN\')·seat_rebuild.gen(1, 판매 열기의 판 번호) 셋뿐이다', () => {
    const defaults = SHAPES.flatMap((s) => s.columns.filter((c) => c.hasDefault).map((c) => `${s.name}.${c.name}`));
    expect(defaults).toEqual(['seat_sale.reserved_at', 'seat_hold.kind', 'seat_rebuild.gen']);
    expect(getTableConfig(seatRebuild).columns.find((c) => c.name === 'gen')!.default).toBe(1);
    const reservedAt = getTableConfig(seatSale).columns.find((c) => c.name === 'reserved_at')!;
    expect(canon(sqlText(reservedAt.default as SQL))).toBe('now()');
    const kind = getTableConfig(seatHold).columns.find((c) => c.name === 'kind')!;
    expect(kind.default).toBe('FAN');
  });

  test('기본 키의 이름과 열 차례가 정본과 같다(seat_rebuild는 회차마다 한 행: event_id 열 하나의 기본 키) [ASVS v5.0.0-2.3.4]', () => {
    expect(sale.primaryKeys).toEqual([{ name: 'seat_sale_pkey', columns: ['event_id', 'seat_id', 'order_id'] }]);
    expect(quota.primaryKeys).toEqual([{ name: 'purchase_quota_pkey', columns: ['account_id', 'event_id'] }]);
    expect(hold.primaryKeys).toEqual([{ name: 'seat_hold_pkey', columns: ['event_id', 'seat_id', 'fencing_token'] }]);
    expect(rebuild.primaryKeys).toEqual([]);
    expect(rebuild.columns.filter((c) => c.primary).map((c) => c.name)).toEqual(['event_id']);
    for (const s of [sale, quota, hold]) expect(s.columns.filter((c) => c.primary), s.name).toEqual([]);
  });

  test('활성 판매 유일 부분 인덱스: seat_sale_active_key는 (event_id, seat_id) WHERE status IN (PENDING, SOLD)다 [ASVS v5.0.0-2.3.4]', () => {
    expect(sale.indexes).toEqual([
      { name: 'seat_sale_active_key', unique: true, columns: ['event_id', 'seat_id'], where: canon("status IN ('PENDING','SOLD')") },
    ]);
  });

  test('활성 홀드 유일 부분 인덱스: seat_hold_active_key는 (event_id, seat_id) WHERE status = HELD다 [ASVS v5.0.0-2.3.4]', () => {
    expect(hold.indexes).toEqual([{ name: 'seat_hold_active_key', unique: true, columns: ['event_id', 'seat_id'], where: canon("status = 'HELD'") }]);
  });

  test('인덱스는 이 둘뿐이다: 주문 ID만으로 찾는 인덱스 같은 것을 더 두지 않는다(쓰기가 많은 표는 인덱스를 아낀다. 원장의 hold_id·seat_rebuild에도 두지 않는다) [ASVS v5.0.0-2.3.4]', () => {
    expect(sale.indexes.map((i) => i.name)).toEqual(['seat_sale_active_key']);
    expect(quota.indexes).toEqual([]);
    expect(hold.indexes.map((i) => i.name)).toEqual(['seat_hold_active_key']);
    expect(rebuild.indexes).toEqual([]);
  });

  test('파티션 표 seat_hold의 기본 키와 유일 인덱스는 파티션 키 열(event_id)을 담는다 [ASVS v5.0.0-2.3.4]', () => {
    expect(hold.primaryKeys[0]!.columns).toContain('event_id');
    for (const i of hold.indexes.filter((x) => x.unique)) expect(i.columns, i.name).toContain('event_id');
  });

  test('check 제약의 이름과 식이 정본과 같다: 상태·종류 목록, 한도(used >= 0, limit_count >= 0, used <= limit_count), 판 번호(gen >= 1) [ASVS v5.0.0-2.3.2]', () => {
    expect(sale.checks).toEqual([{ name: 'seat_sale_status_check', expr: canon("status IN ('PENDING','SOLD','RETURNED')") }]);
    expect(quota.checks).toEqual([{ name: 'purchase_quota_used_within_limit', expr: canon('used >= 0 AND limit_count >= 0 AND used <= limit_count') }]);
    expect(hold.checks).toEqual([
      { name: 'seat_hold_status_check', expr: canon("status IN ('HELD','RELEASED','EXPIRED')") },
      { name: 'seat_hold_kind_check', expr: canon("kind IN ('FAN','PRIORITY')") },
    ]);
    expect(rebuild.checks).toEqual([{ name: 'seat_rebuild_gen_check', expr: canon('gen >= 1') }]);
  });

  test('seat_sale의 status check는 도메인 상수 SEAT_SALE_STATUSES와 같은 목록이다 [ASVS v5.0.0-2.3.2]', () => {
    expect(literalsOf(sale.checks[0]!.expr)).toEqual([...SEAT_SALE_STATUSES]);
    expect(literalsOf(sale.indexes[0]!.where!)).toEqual(['PENDING', 'SOLD']);
  });
});

/** 주석 줄(`-- …`)을 빼고, drizzle의 문 사이 표시로 나눈 문들 */
function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !/^\s*--(?!>)/.test(l))
    .join('\n')
    .split(BREAKPOINT)
    .map((s) => s.trim())
    .filter(Boolean);
}
const sqlFile = readFileSync(join(MIGRATIONS, `${TAG}.sql`), 'utf8');
const sqlBody = sqlFile
  .split('\n')
  .filter((l) => !/^\s*--(?!>)/.test(l))
  .join('\n');
const statements = statementsOf(sqlFile);
const rebuildFile = readFileSync(join(MIGRATIONS, `${REBUILD_TAG}.sql`), 'utf8');
const rebuildBody = rebuildFile
  .split('\n')
  .filter((l) => !/^\s*--(?!>)/.test(l))
  .join('\n');
const rebuildStatements = statementsOf(rebuildFile);
/** schema.ts의 표를 만들고 바꾸는 문 모두(0000 → 0002 차례. 0001은 보류·통계 표다) */
const seatStatements = [...statements, ...rebuildStatements];
const createTable = (name: string): string => {
  const s = seatStatements.find((x) => new RegExp(`^CREATE TABLE "${name}" `).test(x));
  expect(s, `${name}을 만드는 문이 있어야 한다`).toBeDefined();
  return s!;
};
/** ALTER TABLE … ADD COLUMN으로 더한 열: [표, 열, 그 문] */
const addedColumns = (): [string, string, string][] =>
  seatStatements.flatMap((x) => {
    const m = /^ALTER TABLE "([a-z_]+)" ADD COLUMN "([a-z_]+)" /.exec(x);
    return m ? [[m[1]!, m[2]!, x] as [string, string, string]] : [];
  });

describe('마이그레이션 SQL 파일(0000_purchase_seat_tables.sql)', () => {
  test('표 셋을 만들고 유일 인덱스 둘을 더하는 문 다섯뿐이다(다른 문이 끼지 않는다)', () => {
    expect(statements).toHaveLength(5);
    expect(statements.filter((s) => /^CREATE TABLE /.test(s))).toHaveLength(3);
    expect(statements.filter((s) => /^CREATE UNIQUE INDEX /.test(s))).toHaveLength(2);
    expect(sqlBody).not.toMatch(/\b(ALTER|DROP|TRUNCATE|DELETE|INSERT|UPDATE)\b/i);
    // 문 사이마다 표시가 있어야 마이그레이터가 문 하나씩 실행한다
    expect(sqlBody.split(BREAKPOINT)).toHaveLength(5);
  });

  test('0000은 seat_sale·purchase_quota·seat_hold를 만들고, 0002가 만드는 seat_rebuild와 합치면 schema.ts의 표와 같다', () => {
    const created = [...sqlBody.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(created).toEqual(['purchase_quota', 'seat_hold', 'seat_sale']);
    const all = [...`${sqlBody}\n${rebuildBody}`.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(all).toEqual(SHAPES.map((s) => s.name).sort());
  });

  test('seat_hold만 PARTITION BY RANGE ("event_id")로 만든다 [ASVS v5.0.0-2.3.4]', () => {
    expect(createTable('seat_hold')).toMatch(/\)\s*PARTITION\s+BY\s+RANGE\s*\(\s*"event_id"\s*\)\s*;?\s*$/i);
  });

  test('seat_sale·purchase_quota는 파티션 표가 아니다 [ASVS v5.0.0-2.3.4]', () => {
    expect(createTable('seat_sale')).not.toMatch(/PARTITION/i);
    expect(createTable('purchase_quota')).not.toMatch(/PARTITION/i);
  });

  test('DEFAULT 파티션도 날짜를 박은 파티션도 만들지 않는다(첫 월 파티션은 migrate.mjs가 만든다) [ASVS v5.0.0-2.3.4]', () => {
    expect(sqlBody).not.toMatch(/PARTITION\s+OF/i);
    expect(sqlBody).not.toMatch(/ATTACH\s+PARTITION/i);
    expect(sqlBody).not.toMatch(/FOR\s+VALUES/i);
    expect(sqlBody).not.toMatch(/seat_hold_p\d{6}/);
    expect(sqlBody).not.toMatch(/seat_hold_default/i);
    // 열 기본값 DEFAULT 'FAN'·DEFAULT now()만 있고, 문장 끝의 DEFAULT(= 기본 파티션 선언)는 없다
    expect(sqlBody).not.toMatch(/\bDEFAULT\s*[;)]/i);
    expect([...sqlBody.matchAll(/\bDEFAULT\b/gi)]).toHaveLength(2);
  });

  test('schema.ts의 인덱스가 같은 이름·같은 표·같은 열·같은 WHERE 조건의 유일 인덱스로 SQL에 있다 [ASVS v5.0.0-2.3.4]', () => {
    for (const s of SHAPES) {
      for (const i of s.indexes) {
        const stmt = seatStatements.find((x) => x.includes(`INDEX "${i.name}"`));
        expect(stmt, `인덱스 ${i.name}`).toBeDefined();
        const c = canon(stmt!);
        expect(c.startsWith(`create ${i.unique ? 'unique ' : ''}index ${i.name} on ${s.name} using btree(${i.columns.join(',')})`), `${i.name}: ${c}`).toBe(true);
        expect(c.replace(/;$/, '').endsWith(`where ${i.where}`), `${i.name} WHERE: ${c}`).toBe(true);
      }
    }
  });

  test('schema.ts의 기본 키가 같은 이름·같은 열 차례로 SQL에 있다(열 하나의 기본 키는 그 열 정의의 PRIMARY KEY)', () => {
    for (const s of SHAPES) {
      const c = canon(createTable(s.name));
      for (const p of s.primaryKeys) expect(c, p.name).toContain(`constraint ${p.name} primary key(${p.columns.join(',')})`);
      for (const col of s.columns.filter((x) => x.primary)) expect(c, `${s.name}.${col.name}`).toContain(`${col.name} ${col.type} primary key not null`);
      expect((c.match(/primary key/g) ?? []).length, s.name).toBe(s.primaryKeys.length + s.columns.filter((x) => x.primary).length);
    }
  });

  test('schema.ts의 check 제약이 같은 이름·같은 식으로 SQL에 있다 [ASVS v5.0.0-2.3.2]', () => {
    for (const s of SHAPES) {
      const c = canon(createTable(s.name));
      for (const k of s.checks) expect(c, k.name).toContain(`constraint ${k.name} check(${k.expr})`);
    }
  });

  test('schema.ts의 열이 모두 SQL에 있고 그 밖의 열은 없다(만드는 문의 열 + 0002가 ADD COLUMN으로 더한 열)', () => {
    const added = addedColumns();
    for (const s of SHAPES) {
      const body = createTable(s.name);
      const inSql = [...body.matchAll(/^\t"([a-z_]+)" /gm)].map((m) => m[1]!);
      const more = added.filter(([t]) => t === s.name).map(([, c]) => c);
      expect([...inSql, ...more].sort(), s.name).toEqual(s.columns.map((c) => c.name).sort());
      expect(new Set([...inSql, ...more]).size, `${s.name} 열이 겹친다`).toBe(inSql.length + more.length);
    }
  });
});

describe('마이그레이션 SQL 파일(0002_seat_rebuild_and_hold_ids.sql, PRF-143)', () => {
  test('문 셋뿐이다: seat_rebuild를 만들고 seat_hold에 hold_id·purchase_session_id를 더한다(지우거나 바꾸는 문이 없다) [ASVS v5.0.0-2.3.4]', () => {
    expect(rebuildStatements).toHaveLength(3);
    expect(rebuildStatements[0]).toMatch(/^CREATE TABLE "seat_rebuild" /);
    expect(addedColumns().map(([t, c]) => `${t}.${c}`)).toEqual(['seat_hold.hold_id', 'seat_hold.purchase_session_id']);
    expect(rebuildBody).not.toMatch(/\b(DROP|TRUNCATE|DELETE|INSERT|UPDATE|RENAME)\b/i);
    expect(rebuildBody).not.toMatch(/ALTER\s+COLUMN|SET\s+NOT\s+NULL|USING\b/i);
    expect(rebuildBody.split(BREAKPOINT)).toHaveLength(3);
  });

  test('seat_hold에 더한 두 열은 hold_id uuid·purchase_session_id text이고 널 허용·기본값 없음이다(옛 원장 행은 비어 있고, 파티션 표를 다시 쓰지 않는다) [ASVS v5.0.0-2.3.4]', () => {
    for (const [, col, stmt] of addedColumns()) {
      const c = hold.columns.find((x) => x.name === col)!;
      expect(canon(stmt).replace(/;$/, ''), col).toBe(`alter table seat_hold add column ${col} ${c.type}`);
      expect(stmt, col).not.toMatch(/NOT\s+NULL|DEFAULT/i);
    }
  });

  test('seat_rebuild는 파티션 표가 아니고, 기본값은 gen의 DEFAULT 1 하나다', () => {
    const c = createTable('seat_rebuild');
    expect(c).not.toMatch(/PARTITION/i);
    expect(canon(c)).toContain('gen integer default 1 not null');
    expect([...rebuildBody.matchAll(/\bDEFAULT\b/gi)]).toHaveLength(1);
  });
});

describe('마이그레이션 기록(migrations/meta)', () => {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };

  test('_journal.json은 0000(좌석 표)·0001(보류 표, PRF-141)·0002(다시 만들기 표·원장 칸, PRF-143) 차례이고 tag가 SQL 파일 이름과 맞으며 when이 차례대로 커진다 [ASVS v5.0.0-2.3.4]', () => {
    expect(journal.dialect).toBe('postgresql');
    expect(journal.entries.map((e) => [e.idx, e.tag])).toEqual([
      [0, TAG],
      [1, HELD_TAG],
      [2, REBUILD_TAG],
    ]);
    // 마이그레이터는 마지막으로 적용한 when보다 큰 것만 돌린다(작으면 새 마이그레이션을 건너뛴다)
    for (let i = 1; i < journal.entries.length; i++) expect(journal.entries[i]!.when, journal.entries[i]!.tag).toBeGreaterThan(journal.entries[i - 1]!.when);
    for (const e of journal.entries) {
      expect(e.breakpoints).toBe(true);
      expect(Number.isSafeInteger(e.when) && e.when > 0).toBe(true);
      expect(existsSync(join(MIGRATIONS, `${e.tag}.sql`))).toBe(true);
    }
  });

  test('migrations 폴더의 SQL 파일은 기록에 있는 것뿐이다(기록에 없는 SQL이 몰래 쌓이지 않는다)', () => {
    expect(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))).toEqual([`${TAG}.sql`, `${HELD_TAG}.sql`, `${REBUILD_TAG}.sql`]);
  });

  type Snapshot = {
    id: string;
    prevId: string;
    tables: Record<string, { columns: Record<string, { type: string; notNull: boolean; primaryKey: boolean }>; checkConstraints?: Record<string, unknown> }>;
  };
  const snapshotFiles = readdirSync(join(MIGRATIONS, 'meta'))
    .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
    .sort();
  const snapshotOf = (f: string) => JSON.parse(readFileSync(join(MIGRATIONS, 'meta', f), 'utf8')) as Snapshot;

  test('스냅샷은 기록마다 하나이고 prevId로 이어진다(0000 → 0001 → 0002)', () => {
    expect(snapshotFiles).toEqual(journal.entries.map((e) => `${String(e.idx).padStart(4, '0')}_snapshot.json`));
    let prev = '00000000-0000-0000-0000-000000000000';
    for (const f of snapshotFiles) {
      const s = snapshotOf(f);
      expect(s.prevId, f).toBe(prev);
      prev = s.id;
    }
  });

  test('마지막 스냅샷(0002_snapshot.json)의 표·열·열 기본 키·check 이름이 schema.ts와 같다(표 정의만 고치고 마이그레이션을 안 만든 어긋남을 막는다)', () => {
    expect(snapshotFiles.at(-1)).toBe('0002_snapshot.json');
    const snap = snapshotOf(snapshotFiles.at(-1)!);
    expect(Object.keys(snap.tables).sort()).toEqual(SHAPES.map((s) => `public.${s.name}`).sort());
    for (const s of SHAPES) {
      const t = snap.tables[`public.${s.name}`]!;
      expect(Object.entries(t.columns).map(([n, c]) => [n, c.type, c.notNull]), s.name).toEqual(cols(s));
      expect(Object.entries(t.columns).filter(([, c]) => c.primaryKey).map(([n]) => n), `${s.name} 열 기본 키`).toEqual(s.columns.filter((c) => c.primary).map((c) => c.name));
      expect(Object.keys(t.checkConstraints ?? {}), `${s.name} check`).toEqual(s.checks.map((k) => k.name));
    }
  });
});
