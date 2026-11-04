// purchase DB의 좌석 표 셋(seat_sale·purchase_quota·seat_hold)의 모양을 DB 없이 본다(docs/data.md §4 'purchase DB의 좌석 표 마이그레이션', §2 ERD, BUILD_ORDER PRF-140 ①).
// ① Drizzle 표 정의(schema.ts)를 getTableConfig로 읽어 표·열·기본 키·부분 유일 인덱스·check 제약 이름과 식이 정본과 같은지 보고,
// ② 마이그레이션 SQL 파일을 글로 읽어 파티션 선언(seat_hold만, DEFAULT 파티션 없음)과 표 정의 ↔ SQL 일치를 보고, ③ 마이그레이션 기록(meta)이 맞물리는지 본다.
// 실제 PostgreSQL에서 돌려 보는 것은 test-int/purchase-migration.int.test.ts다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import { purchaseQuota, seatHold, seatSale } from '../src/modules/inventory/adapters/db/schema.js';
import { SEAT_SALE_STATUSES } from '../src/modules/inventory/domain/seat-sale.js';

const MIGRATIONS = join(fileURLToPath(new URL('..', import.meta.url)), 'migrations');
const TAG = '0000_purchase_seat_tables';
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
  columns: { name: string; type: string; notNull: boolean; hasDefault: boolean }[];
  primaryKeys: { name: string; columns: string[] }[];
  indexes: { name: string; unique: boolean; columns: string[]; where: string | undefined }[];
  checks: { name: string; expr: string }[];
}
function shapeOf(table: PgTable): Shape {
  const c = getTableConfig(table);
  return {
    name: c.name,
    columns: c.columns.map((col) => ({ name: col.name, type: col.getSQLType(), notNull: col.notNull, hasDefault: col.hasDefault })),
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
const SHAPES = [sale, quota, hold];

const TZ = 'timestamp with time zone';
/** [열 이름, 종류, 널 불허] */
const cols = (s: Shape): [string, string, boolean][] => s.columns.map((c) => [c.name, c.type, c.notNull]);

describe('표 정의(schema.ts)', () => {
  test('표는 seat_sale·purchase_quota·seat_hold 셋이고 모두 기본 스키마(public)에 있다', () => {
    expect(SHAPES.map((s) => s.name)).toEqual(['seat_sale', 'purchase_quota', 'seat_hold']);
    for (const t of [seatSale, purchaseQuota, seatHold]) expect(getTableConfig(t).schema).toBeUndefined();
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

  test('seat_hold의 열 이름·종류·널 허용이 정본과 같다(priority_grant_id·held_at만 비울 수 있다)', () => {
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
    ]);
  });

  test('기본값은 seat_sale.reserved_at(now())과 seat_hold.kind(\'FAN\') 둘뿐이다', () => {
    const defaults = SHAPES.flatMap((s) => s.columns.filter((c) => c.hasDefault).map((c) => `${s.name}.${c.name}`));
    expect(defaults).toEqual(['seat_sale.reserved_at', 'seat_hold.kind']);
    const reservedAt = getTableConfig(seatSale).columns.find((c) => c.name === 'reserved_at')!;
    expect(canon(sqlText(reservedAt.default as SQL))).toBe('now()');
    const kind = getTableConfig(seatHold).columns.find((c) => c.name === 'kind')!;
    expect(kind.default).toBe('FAN');
  });

  test('기본 키의 이름과 열 차례가 정본과 같다', () => {
    expect(sale.primaryKeys).toEqual([{ name: 'seat_sale_pkey', columns: ['event_id', 'seat_id', 'order_id'] }]);
    expect(quota.primaryKeys).toEqual([{ name: 'purchase_quota_pkey', columns: ['account_id', 'event_id'] }]);
    expect(hold.primaryKeys).toEqual([{ name: 'seat_hold_pkey', columns: ['event_id', 'seat_id', 'fencing_token'] }]);
  });

  test('활성 판매 유일 부분 인덱스: seat_sale_active_key는 (event_id, seat_id) WHERE status IN (PENDING, SOLD)다 [ASVS v5.0.0-2.3.4]', () => {
    expect(sale.indexes).toEqual([
      { name: 'seat_sale_active_key', unique: true, columns: ['event_id', 'seat_id'], where: canon("status IN ('PENDING','SOLD')") },
    ]);
  });

  test('활성 홀드 유일 부분 인덱스: seat_hold_active_key는 (event_id, seat_id) WHERE status = HELD다 [ASVS v5.0.0-2.3.4]', () => {
    expect(hold.indexes).toEqual([{ name: 'seat_hold_active_key', unique: true, columns: ['event_id', 'seat_id'], where: canon("status = 'HELD'") }]);
  });

  test('인덱스는 이 둘뿐이다: 주문 ID만으로 찾는 인덱스 같은 것을 더 두지 않는다(쓰기가 많은 표는 인덱스를 아낀다) [ASVS v5.0.0-2.3.4]', () => {
    expect(sale.indexes.map((i) => i.name)).toEqual(['seat_sale_active_key']);
    expect(quota.indexes).toEqual([]);
    expect(hold.indexes.map((i) => i.name)).toEqual(['seat_hold_active_key']);
  });

  test('파티션 표 seat_hold의 기본 키와 유일 인덱스는 파티션 키 열(event_id)을 담는다 [ASVS v5.0.0-2.3.4]', () => {
    expect(hold.primaryKeys[0]!.columns).toContain('event_id');
    for (const i of hold.indexes.filter((x) => x.unique)) expect(i.columns, i.name).toContain('event_id');
  });

  test('check 제약의 이름과 식이 정본과 같다: 상태·종류 목록, 한도(used >= 0, limit_count >= 0, used <= limit_count) [ASVS v5.0.0-2.3.2]', () => {
    expect(sale.checks).toEqual([{ name: 'seat_sale_status_check', expr: canon("status IN ('PENDING','SOLD','RETURNED')") }]);
    expect(quota.checks).toEqual([{ name: 'purchase_quota_used_within_limit', expr: canon('used >= 0 AND limit_count >= 0 AND used <= limit_count') }]);
    expect(hold.checks).toEqual([
      { name: 'seat_hold_status_check', expr: canon("status IN ('HELD','RELEASED','EXPIRED')") },
      { name: 'seat_hold_kind_check', expr: canon("kind IN ('FAN','PRIORITY')") },
    ]);
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
const createTable = (name: string): string => {
  const s = statements.find((x) => new RegExp(`^CREATE TABLE "${name}" `).test(x));
  expect(s, `${name}을 만드는 문이 있어야 한다`).toBeDefined();
  return s!;
};

describe('마이그레이션 SQL 파일(0000_purchase_seat_tables.sql)', () => {
  test('표 셋을 만들고 유일 인덱스 둘을 더하는 문 다섯뿐이다(다른 문이 끼지 않는다)', () => {
    expect(statements).toHaveLength(5);
    expect(statements.filter((s) => /^CREATE TABLE /.test(s))).toHaveLength(3);
    expect(statements.filter((s) => /^CREATE UNIQUE INDEX /.test(s))).toHaveLength(2);
    expect(sqlBody).not.toMatch(/\b(ALTER|DROP|TRUNCATE|DELETE|INSERT|UPDATE)\b/i);
    // 문 사이마다 표시가 있어야 마이그레이터가 문 하나씩 실행한다
    expect(sqlBody.split(BREAKPOINT)).toHaveLength(5);
  });

  test('만드는 표 이름이 schema.ts의 표와 같다', () => {
    const created = [...sqlBody.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(created).toEqual(SHAPES.map((s) => s.name).sort());
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
        const stmt = statements.find((x) => x.includes(`INDEX "${i.name}"`));
        expect(stmt, `인덱스 ${i.name}`).toBeDefined();
        const c = canon(stmt!);
        expect(c.startsWith(`create ${i.unique ? 'unique ' : ''}index ${i.name} on ${s.name} using btree(${i.columns.join(',')})`), `${i.name}: ${c}`).toBe(true);
        expect(c.replace(/;$/, '').endsWith(`where ${i.where}`), `${i.name} WHERE: ${c}`).toBe(true);
      }
    }
  });

  test('schema.ts의 기본 키가 같은 이름·같은 열 차례로 SQL에 있다', () => {
    for (const s of SHAPES) {
      const c = canon(createTable(s.name));
      for (const p of s.primaryKeys) expect(c, p.name).toContain(`constraint ${p.name} primary key(${p.columns.join(',')})`);
    }
  });

  test('schema.ts의 check 제약이 같은 이름·같은 식으로 SQL에 있다 [ASVS v5.0.0-2.3.2]', () => {
    for (const s of SHAPES) {
      const c = canon(createTable(s.name));
      for (const k of s.checks) expect(c, k.name).toContain(`constraint ${k.name} check(${k.expr})`);
    }
  });

  test('schema.ts의 열이 모두 SQL의 표 정의에 있고 그 밖의 열은 없다', () => {
    for (const s of SHAPES) {
      const body = createTable(s.name);
      const inSql = [...body.matchAll(/^\t"([a-z_]+)" /gm)].map((m) => m[1]);
      expect(inSql, s.name).toEqual(s.columns.map((c) => c.name));
    }
  });
});

describe('마이그레이션 기록(migrations/meta)', () => {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    version: string;
    dialect: string;
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };

  test('_journal.json은 0000 한 항목이고 tag가 SQL 파일 이름과 맞는다 [ASVS v5.0.0-2.3.4]', () => {
    expect(journal.dialect).toBe('postgresql');
    expect(journal.entries).toHaveLength(1);
    const [e] = journal.entries;
    expect(e!.idx).toBe(0);
    expect(e!.tag).toBe(TAG);
    expect(e!.breakpoints).toBe(true);
    expect(Number.isSafeInteger(e!.when) && e!.when > 0).toBe(true);
    expect(existsSync(join(MIGRATIONS, `${e!.tag}.sql`))).toBe(true);
  });

  test('migrations 폴더의 SQL 파일은 기록에 있는 그 하나뿐이다(기록에 없는 SQL이 몰래 쌓이지 않는다)', () => {
    expect(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))).toEqual([`${TAG}.sql`]);
  });

  test('0000_snapshot.json의 표·열이 schema.ts와 같다(표 정의만 고치고 마이그레이션을 안 만든 어긋남을 막는다)', () => {
    const snap = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '0000_snapshot.json'), 'utf8')) as {
      tables: Record<string, { columns: Record<string, { type: string; notNull: boolean }> }>;
    };
    expect(Object.keys(snap.tables).sort()).toEqual(SHAPES.map((s) => `public.${s.name}`).sort());
    for (const s of SHAPES) {
      const t = snap.tables[`public.${s.name}`]!;
      expect(Object.entries(t.columns).map(([n, c]) => [n, c.type, c.notNull]), s.name).toEqual(cols(s));
    }
  });
});
