// purchase DB의 좌석 표 넷(seat_sale·purchase_quota·seat_hold·seat_rebuild)의 모양을 DB 없이 본다(docs/data.md §4 'purchase DB의 좌석 표 마이그레이션'·
// '다시 만들기 표와 원장 칸'(BUILD_ORDER PRF-143), §2 ERD, BUILD_ORDER PRF-140 ①).
// ① Drizzle 표 정의(schema.ts)를 getTableConfig로 읽어 표·열·기본 키·부분 유일 인덱스·check 제약 이름과 식이 정본과 같은지 보고,
// ② 마이그레이션 SQL 파일(0000 좌석 표, 0002 다시 만들기 표·원장 칸)을 글로 읽어 파티션 선언(seat_hold만, DEFAULT 파티션 없음)과 표 정의 ↔ SQL 일치를 보고,
// ③ 마이그레이션 기록(meta)이 맞물리는지 본다. 네 번째 마이그레이션(0003 주문 표·Outbox, BUILD_ORDER PRF-160), 다섯 번째(0004 주문의 홀드·구매 세션 칸과
// hold_id 유일 인덱스, BUILD_ORDER PRF-161), 여섯 번째(0005 결제 접수의 결제 참조 칸·seat_gen·order_saga_job, BUILD_ORDER PRF-162),
// 일곱 번째(0006 Saga 1단계의 purchase_order.failure_reason·order_saga_job.confirm_sent_at·step CHECK, BUILD_ORDER PRF-165),
// 여덟 번째(0007 발권 재시도 큐 ticket_issue_job, BUILD_ORDER PRF-163)도 기록·파일 목록에 있고,
// 마지막 스냅샷(0007)의 주문 표 일곱(booking schema.ts)이 표 정의와 같은지 본다.
// ④ 0004 SQL의 칸(hold_id·purchase_session_id)과 유일 인덱스(purchase_order_hold_key)가 schema.ts와 같은지 본다.
// ⑤ 0005 SQL의 칸(payment_attempt 다섯·purchase_order.seat_gen)과 order_saga_job 표·외래 키·색인이 schema.ts와 같은지 본다.
// ⑥ 0006 SQL의 칸(purchase_order.failure_reason·order_saga_job.confirm_sent_at)과 order_saga_job_step_check가 schema.ts·도메인 SAGA_STEPS와 같은지 본다.
// ⑦ 0007 SQL의 ticket_issue_job 표(칸·기본 키·기본값)·외래 키·쓸기 색인이 schema.ts와 같은지 본다(data.md §2 ERD ticket_issue_job·§4 여덟 번째 마이그레이션).
// 실제 PostgreSQL에서 돌려 보는 것은 test-int/purchase-migration.int.test.ts(주문 표는 test-int/order-store.int.test.ts)다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import { orderEvent, orderIdempotency, orderItem, orderSagaJob, paymentAttempt, purchaseOrder, ticketIssueJob } from '../src/modules/booking/adapters/db/schema.js';
import { SAGA_STEPS } from '../src/modules/booking/domain/saga.js';
import { purchaseQuota, seatHold, seatRebuild, seatSale } from '../src/modules/inventory/adapters/db/schema.js';
import { SEAT_SALE_STATUSES } from '../src/modules/inventory/domain/seat-sale.js';

const MIGRATIONS = join(fileURLToPath(new URL('..', import.meta.url)), 'migrations');
const TAG = '0000_purchase_seat_tables';
/** 보류 표 held_event·정비 통계 stat_snapshot(platform 템플릿 0003을 옮김, BUILD_ORDER PRF-141) */
const HELD_TAG = '0001_held_event_and_stat_snapshot';
/** 다시 만들기 표 seat_rebuild와 원장 칸 seat_hold.hold_id·purchase_session_id(BUILD_ORDER PRF-143) */
const REBUILD_TAG = '0002_seat_rebuild_and_hold_ids';
/** 주문 표 다섯과 Outbox 부모 표(BUILD_ORDER PRF-160) */
const ORDER_TAG = '0003_order_tables';
/** 주문을 만든 홀드·구매 세션 칸과 hold_id 유일 인덱스(BUILD_ORDER PRF-161) */
const ORDER_HOLD_TAG = '0004_order_hold_and_session';
/** 결제 접수의 결제 참조 칸 다섯·주문의 판 번호 seat_gen·Saga 작업 표 order_saga_job(BUILD_ORDER PRF-162) */
const PAY_TAG = '0005_payment_acceptance';
/** Saga 1단계의 주문 실패 사유 칸과 작업 단계 CHECK(BUILD_ORDER PRF-165) */
const SAGA_TAG = '0006_saga_step_one';
/** 발권 재시도 큐 ticket_issue_job(BUILD_ORDER PRF-163) */
const TICKET_TAG = '0007_ticket_issue_job';
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

  test('_journal.json은 0000(좌석 표)·0001(보류 표, PRF-141)·0002(다시 만들기 표·원장 칸, PRF-143)·0003(주문 표·Outbox, PRF-160)·0004(주문의 홀드·구매 세션 칸, PRF-161)·0005(결제 접수, PRF-162)·0006(Saga 1단계, PRF-165)·0007(발권 재시도 큐, PRF-163) 차례이고 tag가 SQL 파일 이름과 맞으며 when이 차례대로 커진다 [ASVS v5.0.0-2.3.4]', () => {
    expect(journal.dialect).toBe('postgresql');
    expect(journal.entries.map((e) => [e.idx, e.tag])).toEqual([
      [0, TAG],
      [1, HELD_TAG],
      [2, REBUILD_TAG],
      [3, ORDER_TAG],
      [4, ORDER_HOLD_TAG],
      [5, PAY_TAG],
      [6, SAGA_TAG],
      [7, TICKET_TAG],
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
    expect(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))).toEqual([
      `${TAG}.sql`,
      `${HELD_TAG}.sql`,
      `${REBUILD_TAG}.sql`,
      `${ORDER_TAG}.sql`,
      `${ORDER_HOLD_TAG}.sql`,
      `${PAY_TAG}.sql`,
      `${SAGA_TAG}.sql`,
      `${TICKET_TAG}.sql`,
    ]);
  });

  type Snapshot = {
    id: string;
    prevId: string;
    tables: Record<
      string,
      {
        columns: Record<string, { type: string; notNull: boolean; primaryKey: boolean }>;
        checkConstraints?: Record<string, unknown>;
        compositePrimaryKeys?: Record<string, { name: string; columns: string[] }>;
        foreignKeys?: Record<string, unknown>;
        indexes?: Record<string, { isUnique: boolean }>;
      }
    >;
  };
  const snapshotFiles = readdirSync(join(MIGRATIONS, 'meta'))
    .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
    .sort();
  const snapshotOf = (f: string) => JSON.parse(readFileSync(join(MIGRATIONS, 'meta', f), 'utf8')) as Snapshot;

  test('스냅샷은 기록마다 하나이고 prevId로 이어진다(0000 → 0001 → 0002 → 0003 → 0004 → 0005 → 0006 → 0007)', () => {
    expect(snapshotFiles).toEqual(journal.entries.map((e) => `${String(e.idx).padStart(4, '0')}_snapshot.json`));
    let prev = '00000000-0000-0000-0000-000000000000';
    for (const f of snapshotFiles) {
      const s = snapshotOf(f);
      expect(s.prevId, f).toBe(prev);
      prev = s.id;
    }
  });

  /** booking schema.ts의 주문 표 일곱(PRF-160 다섯 + PRF-162 order_saga_job + PRF-163 ticket_issue_job). Outbox 부모 표는 손으로 쓴 SQL이라 스냅샷에 없다 */
  const ORDER_TABLES = [purchaseOrder, orderItem, orderEvent, orderIdempotency, paymentAttempt, orderSagaJob, ticketIssueJob];
  const ORDER_SHAPES = ORDER_TABLES.map(shapeOf);

  test('마지막 스냅샷(0007_snapshot.json)의 표·열·열 기본 키·check 이름이 schema.ts(좌석 표 넷, 주문 표 일곱)와 같다(표 정의만 고치고 마이그레이션을 안 만든 어긋남을 막는다)', () => {
    expect(snapshotFiles.at(-1)).toBe('0007_snapshot.json');
    const snap = snapshotOf(snapshotFiles.at(-1)!);
    expect(Object.keys(snap.tables).sort()).toEqual([...SHAPES, ...ORDER_SHAPES].map((s) => `public.${s.name}`).sort());
    for (const s of [...SHAPES, ...ORDER_SHAPES]) {
      const t = snap.tables[`public.${s.name}`]!;
      expect(Object.entries(t.columns).map(([n, c]) => [n, c.type, c.notNull]), s.name).toEqual(cols(s));
      expect(Object.entries(t.columns).filter(([, c]) => c.primaryKey).map(([n]) => n), `${s.name} 열 기본 키`).toEqual(s.columns.filter((c) => c.primary).map((c) => c.name));
      expect(Object.keys(t.checkConstraints ?? {}), `${s.name} check`).toEqual(s.checks.map((k) => k.name));
    }
  });

  test('마지막 스냅샷(0007)의 주문 표 일곱은 여러 열 기본 키·외래 키·인덱스의 이름(과 기본 키 열 차례, 유일 여부)도 schema.ts와 같다(PRF-160, 0004의 purchase_order_hold_key는 PRF-161, 0005의 order_saga_job은 PRF-162, 0007의 ticket_issue_job은 PRF-163) [ASVS v5.0.0-2.3.4]', () => {
    const snap = snapshotOf('0007_snapshot.json');
    expect(ORDER_SHAPES.map((s) => s.name)).toEqual(['purchase_order', 'order_item', 'order_event', 'order_idempotency', 'payment_attempt', 'order_saga_job', 'ticket_issue_job']);
    ORDER_TABLES.forEach((table, i) => {
      const s = ORDER_SHAPES[i]!;
      const t = snap.tables[`public.${s.name}`]!;
      expect(Object.values(t.compositePrimaryKeys ?? {}).map((p) => [p.name, p.columns]), `${s.name} 기본 키`).toEqual(s.primaryKeys.map((p) => [p.name, p.columns]));
      expect(Object.keys(t.foreignKeys ?? {}), `${s.name} 외래 키`).toEqual(getTableConfig(table).foreignKeys.map((f) => f.getName()));
      expect(Object.entries(t.indexes ?? {}).map(([n, x]) => [n, x.isUnique]), `${s.name} 인덱스`).toEqual(s.indexes.map((x) => [x.name, x.unique]));
    });
  });

  test('0003 스냅샷에는 0004가 더한 칸·인덱스가 없다: 0004 스냅샷의 purchase_order만 hold_id·purchase_session_id 두 칸과 purchase_order_hold_key 하나가 늘었다(다른 표는 같다) [ASVS v5.0.0-2.3.4]', () => {
    const before = snapshotOf('0003_snapshot.json');
    const after = snapshotOf('0004_snapshot.json');
    expect(Object.keys(after.tables).sort()).toEqual(Object.keys(before.tables).sort());
    for (const name of Object.keys(after.tables)) {
      if (name === 'public.purchase_order') continue;
      expect(after.tables[name], name).toEqual(before.tables[name]);
    }
    const b = before.tables['public.purchase_order']!;
    const a = after.tables['public.purchase_order']!;
    expect(Object.keys(a.columns).filter((c) => !(c in b.columns))).toEqual(['hold_id', 'purchase_session_id']);
    expect(Object.keys(a.indexes ?? {}).filter((i) => !(i in (b.indexes ?? {})))).toEqual(['purchase_order_hold_key']);
  });

  test('0004 → 0005 스냅샷: order_saga_job이 새로 생기고, payment_attempt에 결제 참조 칸 다섯, purchase_order에 seat_gen 하나가 늘었다. 인덱스·외래 키·check는 그대로이고 다른 표는 같다 [ASVS v5.0.0-2.3.4]', () => {
    const before = snapshotOf('0004_snapshot.json');
    const after = snapshotOf('0005_snapshot.json');
    expect(Object.keys(after.tables).filter((n) => !(n in before.tables))).toEqual(['public.order_saga_job']);
    expect(Object.keys(before.tables).filter((n) => !(n in after.tables))).toEqual([]);
    const changed: Record<string, string[]> = { 'public.payment_attempt': ['pg_payment_key', 'pg_tx_id', 'pg_payment_token', 'authenticated_at', 'accepted_at'], 'public.purchase_order': ['seat_gen'] };
    for (const name of Object.keys(before.tables)) {
      const b = before.tables[name]!;
      const a = after.tables[name]!;
      if (!(name in changed)) {
        expect(a, name).toEqual(b);
        continue;
      }
      expect(Object.keys(a.columns).filter((c) => !(c in b.columns)), name).toEqual(changed[name]);
      // 앞에 있던 칸은 그대로다(바꾸거나 지우지 않는다)
      for (const [c, col] of Object.entries(b.columns)) expect(a.columns[c], `${name}.${c}`).toEqual(col);
      expect(a.indexes, `${name} 인덱스`).toEqual(b.indexes);
      expect(a.foreignKeys, `${name} 외래 키`).toEqual(b.foreignKeys);
      expect(a.checkConstraints, `${name} check`).toEqual(b.checkConstraints);
      // 더한 칸은 모두 널 허용(접수 전에는 비어 있다)
      for (const c of changed[name]!) expect({ c, notNull: a.columns[c]!.notNull }).toEqual({ c, notNull: false });
    }
  });

  test('0005 → 0006 스냅샷(PRF-165): 표는 같고, purchase_order에 failure_reason 한 칸(text·널 허용), order_saga_job에 confirm_sent_at 한 칸(timestamptz·널 허용, 리뷰 H1)과 order_saga_job_step_check 하나만 늘었다. 인덱스·외래 키는 그대로이고 다른 표는 같다 [ASVS v5.0.0-2.3.4]', () => {
    const before = snapshotOf('0005_snapshot.json');
    const after = snapshotOf('0006_snapshot.json');
    expect(Object.keys(after.tables).sort()).toEqual(Object.keys(before.tables).sort());
    for (const name of Object.keys(after.tables)) {
      const b = before.tables[name]!;
      const a = after.tables[name]!;
      if (name !== 'public.purchase_order' && name !== 'public.order_saga_job') {
        expect(a, name).toEqual(b);
        continue;
      }
      for (const [c, col] of Object.entries(b.columns)) expect(a.columns[c], `${name}.${c}`).toEqual(col);
      expect(a.indexes, `${name} 인덱스`).toEqual(b.indexes);
      expect(a.foreignKeys, `${name} 외래 키`).toEqual(b.foreignKeys);
    }
    const po = { b: before.tables['public.purchase_order']!, a: after.tables['public.purchase_order']! };
    expect(Object.keys(po.a.columns).filter((c) => !(c in po.b.columns))).toEqual(['failure_reason']);
    expect(po.a.columns['failure_reason']).toMatchObject({ type: 'text', notNull: false });
    // 실패 사유는 값 목록이 PRF-163에서 늘어나므로 CHECK를 두지 않는다
    expect(po.a.checkConstraints).toEqual(po.b.checkConstraints);
    const job = { b: before.tables['public.order_saga_job']!, a: after.tables['public.order_saga_job']! };
    expect(Object.keys(job.a.columns).filter((c) => !(c in job.b.columns))).toEqual(['confirm_sent_at']);
    expect(job.a.columns['confirm_sent_at']).toMatchObject({ type: TZ, notNull: false });
    expect(Object.keys(job.a.checkConstraints ?? {}).filter((k) => !(k in (job.b.checkConstraints ?? {})))).toEqual(['order_saga_job_step_check']);
  });

  test('0006 → 0007 스냅샷(PRF-163): ticket_issue_job 표 하나만 새로 생기고 다른 표는 모두 같다(purchase_order.failure_reason은 0006 칸 그대로, CHECK 없음) [ASVS v5.0.0-2.3.4]', () => {
    const before = snapshotOf('0006_snapshot.json');
    const after = snapshotOf('0007_snapshot.json');
    expect(Object.keys(after.tables).filter((n) => !(n in before.tables))).toEqual(['public.ticket_issue_job']);
    expect(Object.keys(before.tables).filter((n) => !(n in after.tables))).toEqual([]);
    for (const name of Object.keys(before.tables)) expect(after.tables[name], name).toEqual(before.tables[name]);
    const t = after.tables['public.ticket_issue_job']!;
    expect(Object.keys(t.foreignKeys ?? {})).toEqual(['ticket_issue_job_order_id_purchase_order_id_fk']);
    expect(Object.entries(t.indexes ?? {}).map(([n, x]) => [n, x.isUnique])).toEqual([['ticket_issue_job_next_attempt_idx', false]]);
    expect(t.checkConstraints ?? {}).toEqual({});
    expect(Object.values(t.compositePrimaryKeys ?? {})).toEqual([]);
  });
});

/** booking schema.ts의 purchase_order(0004가 칸 둘·유일 인덱스 하나를 더한다, PRF-161) */
const orderShape = shapeOf(purchaseOrder);
const holdFile = readFileSync(join(MIGRATIONS, `${ORDER_HOLD_TAG}.sql`), 'utf8');
const holdBody = holdFile
  .split('\n')
  .filter((l) => !/^\s*--(?!>)/.test(l))
  .join('\n');
const holdStatements = statementsOf(holdFile);

describe('마이그레이션 SQL 파일(0004_order_hold_and_session.sql, PRF-161)', () => {
  test('문 셋뿐이다: purchase_order에 hold_id·purchase_session_id를 더하고 유일 인덱스 하나를 만든다(지우거나 바꾸는 문이 없다) [ASVS v5.0.0-2.3.4]', () => {
    expect(holdStatements).toHaveLength(3);
    expect(holdStatements.map((s) => /^ALTER TABLE "([a-z_]+)" ADD COLUMN "([a-z_]+)" /.exec(s)?.slice(1).join('.'))).toEqual(['purchase_order.hold_id', 'purchase_order.purchase_session_id', undefined]);
    expect(holdStatements[2]).toMatch(/^CREATE UNIQUE INDEX "purchase_order_hold_key" /);
    expect(holdBody).not.toMatch(/\b(DROP|TRUNCATE|DELETE|INSERT|UPDATE|RENAME)\b/i);
    expect(holdBody).not.toMatch(/ALTER\s+COLUMN|USING\s+\(|\bDEFAULT\b/i);
    expect(holdBody.split(BREAKPOINT)).toHaveLength(3);
  });

  test('더한 두 칸은 schema.ts purchase_order의 같은 이름·종류이고 둘 다 널 불허·기본값 없음이다(hold_id uuid, purchase_session_id text) [ASVS v5.0.0-2.3.4]', () => {
    const added = holdStatements.flatMap((x) => {
      const m = /^ALTER TABLE "purchase_order" ADD COLUMN "([a-z_]+)" /.exec(x);
      return m ? [[m[1]!, x] as [string, string]] : [];
    });
    expect(added.map(([c]) => c)).toEqual(['hold_id', 'purchase_session_id']);
    for (const [col, stmt] of added) {
      const c = orderShape.columns.find((x) => x.name === col);
      expect(c, `schema.ts purchase_order.${col}`).toBeDefined();
      expect({ col, notNull: c!.notNull, hasDefault: c!.hasDefault }).toEqual({ col, notNull: true, hasDefault: false });
      expect(canon(stmt).replace(/;$/, ''), col).toBe(`alter table purchase_order add column ${col} ${c!.type} not null`);
    }
    expect(orderShape.columns.find((c) => c.name === 'hold_id')!.type).toBe('uuid');
    expect(orderShape.columns.find((c) => c.name === 'purchase_session_id')!.type).toBe('text');
  });

  test('ADD COLUMN이 표 끝에 붙으므로 schema.ts purchase_order에서 0004 앞 칸 뒤의 두 칸이 hold_id·purchase_session_id이고, 그 뒤는 0005의 seat_gen, 0006의 failure_reason 차례다(DB 칸 차례와 같다)', () => {
    expect(orderShape.columns.slice(-4).map((c) => c.name)).toEqual(['hold_id', 'purchase_session_id', 'seat_gen', 'failure_reason']);
  });

  test('한 홀드에 주문 하나: purchase_order_hold_key는 purchase_order (hold_id)의 btree 유일 인덱스이고 WHERE가 없다. schema.ts의 purchase_order 인덱스는 이것 하나다 [ASVS v5.0.0-2.3.4]', () => {
    expect(orderShape.indexes).toEqual([{ name: 'purchase_order_hold_key', unique: true, columns: ['hold_id'], where: undefined }]);
    const c = canon(holdStatements[2]!).replace(/;$/, '');
    expect(c).toBe('create unique index purchase_order_hold_key on purchase_order using btree(hold_id)');
  });
});

/** booking schema.ts의 payment_attempt·order_saga_job(0005가 칸 다섯·표 하나를 더한다, PRF-162) */
const attemptShape = shapeOf(paymentAttempt);
const sagaShape = shapeOf(orderSagaJob);
const payFile = readFileSync(join(MIGRATIONS, `${PAY_TAG}.sql`), 'utf8');
const payBody = payFile
  .split('\n')
  .filter((l) => !/^\s*--(?!>)/.test(l))
  .join('\n');
const payStatements = statementsOf(payFile);
/** 0005의 ALTER TABLE … ADD COLUMN: [표, 열, 그 문] */
const payAdded = (): [string, string, string][] =>
  payStatements.flatMap((x) => {
    const m = /^ALTER TABLE "([a-z_]+)" ADD COLUMN "([a-z_]+)" /.exec(x);
    return m ? [[m[1]!, m[2]!, x] as [string, string, string]] : [];
  });
const ATTEMPT_REF_COLUMNS = ['pg_payment_key', 'pg_tx_id', 'pg_payment_token', 'authenticated_at', 'accepted_at'];

describe('마이그레이션 SQL 파일(0005_payment_acceptance.sql, PRF-162)', () => {
  test('문 아홉뿐이다: order_saga_job을 만들고, payment_attempt에 다섯·purchase_order에 하나를 더하고, 외래 키 하나와 색인 하나(지우거나 바꾸는 문이 없다) [ASVS v5.0.0-2.3.4]', () => {
    expect(payStatements).toHaveLength(9);
    expect(payStatements[0]).toMatch(/^CREATE TABLE "order_saga_job" /);
    expect(payAdded().map(([t, c]) => `${t}.${c}`)).toEqual([...ATTEMPT_REF_COLUMNS.map((c) => `payment_attempt.${c}`), 'purchase_order.seat_gen']);
    expect(payStatements.filter((s) => /^ALTER TABLE "order_saga_job" ADD CONSTRAINT /.test(s))).toHaveLength(1);
    expect(payStatements.filter((s) => /^CREATE (UNIQUE )?INDEX /.test(s))).toHaveLength(1);
    expect(payBody).not.toMatch(/\b(DROP|TRUNCATE|DELETE|INSERT|UPDATE|RENAME)\b(?! no action)/i);
    expect(payBody).not.toMatch(/ALTER\s+COLUMN|SET\s+NOT\s+NULL|USING\s+\(/i);
    expect(payBody.split(BREAKPOINT)).toHaveLength(9);
  });

  test('payment_attempt에 더한 다섯 칸은 schema.ts의 같은 이름·종류이고 널 허용·기본값 없음이며, 표 끝 다섯 칸이 이 차례다(ADD COLUMN이 끝에 붙는다) [ASVS v5.0.0-2.3.4]', () => {
    for (const [table, col, stmt] of payAdded().filter(([t]) => t === 'payment_attempt')) {
      const c = attemptShape.columns.find((x) => x.name === col);
      expect(c, `schema.ts ${table}.${col}`).toBeDefined();
      expect({ col, notNull: c!.notNull, hasDefault: c!.hasDefault }).toEqual({ col, notNull: false, hasDefault: false });
      expect(canon(stmt).replace(/;$/, ''), col).toBe(`alter table payment_attempt add column ${col} ${c!.type}`);
    }
    expect(attemptShape.columns.slice(-5).map((c) => [c.name, c.type])).toEqual([
      ['pg_payment_key', 'text'],
      ['pg_tx_id', 'text'],
      ['pg_payment_token', 'text'],
      ['authenticated_at', TZ],
      ['accepted_at', TZ],
    ]);
  });

  test('purchase_order.seat_gen은 integer·널 허용·기본값 없음이고 0006의 failure_reason 바로 앞 칸이다(접수 전에는 비어 있다) [ASVS v5.0.0-2.3.4]', () => {
    const [, , stmt] = payAdded().find(([t]) => t === 'purchase_order')!;
    expect(canon(stmt).replace(/;$/, '')).toBe('alter table purchase_order add column seat_gen integer');
    const c = orderShape.columns.at(-2)!;
    expect({ name: c.name, type: c.type, notNull: c.notNull, hasDefault: c.hasDefault }).toEqual({ name: 'seat_gen', type: 'integer', notNull: false, hasDefault: false });
    // 쓰기가 많은 purchase_order에 새 인덱스를 두지 않는다(data.md §5.1)
    expect(orderShape.indexes.map((i) => i.name)).toEqual(['purchase_order_hold_key']);
  });

  test('order_saga_job의 열 이름·종류·널 허용이 schema.ts와 같고 0005 SQL의 만드는 문에는 0006이 더한 confirm_sent_at을 뺀 열뿐이다(lease_until·confirm_sent_at만 비울 수 있다) [ASVS v5.0.0-2.3.4]', () => {
    expect(cols(sagaShape)).toEqual([
      ['order_id', 'uuid', true],
      ['event_id', 'uuid', true],
      ['step', 'text', true],
      ['attempts', 'integer', true],
      ['next_attempt_at', TZ, true],
      ['lease_until', TZ, false],
      ['created_at', TZ, true],
      ['confirm_sent_at', TZ, false],
    ]);
    const in0005 = sagaShape.columns.filter((c) => c.name !== 'confirm_sent_at');
    const body = payStatements[0]!;
    expect([...body.matchAll(/^\t"([a-z_]+)" /gm)].map((m) => m[1])).toEqual(in0005.map((c) => c.name));
    const c = canon(body);
    for (const col of in0005) expect(c, col.name).toContain(`${col.name} ${col.type}`);
  });

  test('order_saga_job은 order_id 하나의 기본 키(한 주문에 작업 행 하나)이고, 기본값은 attempts의 0 하나이며 0005 SQL에는 step CHECK가 없다(값 목록은 0006이 더한다, PRF-165) [ASVS v5.0.0-2.3.4]', () => {
    expect(sagaShape.columns.filter((x) => x.primary).map((x) => x.name)).toEqual(['order_id']);
    expect(sagaShape.primaryKeys).toEqual([]);
    const c = canon(payStatements[0]!);
    expect(c).toContain('order_id uuid primary key not null');
    expect((c.match(/primary key/g) ?? []).length).toBe(1);
    expect(sagaShape.columns.filter((x) => x.hasDefault).map((x) => x.name)).toEqual(['attempts']);
    expect(getTableConfig(orderSagaJob).columns.find((x) => x.name === 'attempts')!.default).toBe(0);
    expect(c).toContain('attempts integer default 0 not null');
    expect([...payBody.matchAll(/\bDEFAULT\b/gi)]).toHaveLength(1);
    // schema.ts의 check는 0006이 더한 step CHECK 하나뿐이다(아래 0006 절)
    expect(sagaShape.checks.map((k) => k.name)).toEqual(['order_saga_job_step_check']);
    expect(payBody).not.toMatch(/\bCHECK\b/i);
    expect(c).not.toMatch(/partition/);
  });

  test('order_saga_job.order_id는 purchase_order.id를 가리키는 외래 키 하나이고, 이름이 schema.ts와 같다 [ASVS v5.0.0-2.3.4]', () => {
    const fks = getTableConfig(orderSagaJob).foreignKeys;
    expect(fks.map((f) => f.getName())).toEqual(['order_saga_job_order_id_purchase_order_id_fk']);
    const ref = fks[0]!.reference();
    expect({ from: ref.columns.map((x) => x.name), to: getTableConfig(ref.foreignTable).name, toCols: ref.foreignColumns.map((x) => x.name) }).toEqual({
      from: ['order_id'],
      to: 'purchase_order',
      toCols: ['id'],
    });
    const stmt = payStatements.find((s) => s.includes('ADD CONSTRAINT'))!;
    // canon은 "public". 한정자와 괄호 둘레 공백을 지운다
    expect(canon(stmt).replace(/;$/, '')).toBe(
      'alter table order_saga_job add constraint order_saga_job_order_id_purchase_order_id_fk foreign key(order_id)references purchase_order(id)on delete no action on update no action',
    );
    expect(stmt).toContain('REFERENCES "public"."purchase_order"("id")');
  });

  test('쓸기 색인: order_saga_job_next_attempt_idx는 order_saga_job (next_attempt_at)의 btree 일반 색인이고 WHERE가 없다. 이 표의 색인은 이것 하나다 [ASVS v5.0.0-2.3.4]', () => {
    expect(sagaShape.indexes).toEqual([{ name: 'order_saga_job_next_attempt_idx', unique: false, columns: ['next_attempt_at'], where: undefined }]);
    const stmt = payStatements.find((s) => /^CREATE INDEX /.test(s))!;
    expect(canon(stmt).replace(/;$/, '')).toBe('create index order_saga_job_next_attempt_idx on order_saga_job using btree(next_attempt_at)');
  });
});

/** 0006(Saga 1단계, PRF-165): purchase_order.failure_reason과 order_saga_job_step_check */
const sagaFile = readFileSync(join(MIGRATIONS, `${SAGA_TAG}.sql`), 'utf8');
const sagaBody = sagaFile
  .split('\n')
  .filter((l) => !/^\s*--(?!>)/.test(l))
  .join('\n');
const sagaStatements = statementsOf(sagaFile);

describe('마이그레이션 SQL 파일(0006_saga_step_one.sql, PRF-165)', () => {
  test('문 셋뿐이다: order_saga_job에 confirm_sent_at을 더하고(리뷰 H1), purchase_order에 failure_reason을 더하고, order_saga_job에 step CHECK를 더한다(지우거나 바꾸는 문·기본값·색인이 없다) [ASVS v5.0.0-2.3.4]', () => {
    expect(sagaStatements).toHaveLength(3);
    expect(sagaStatements[0]).toMatch(/^ALTER TABLE "order_saga_job" ADD COLUMN "confirm_sent_at" /);
    expect(sagaStatements[1]).toMatch(/^ALTER TABLE "purchase_order" ADD COLUMN "failure_reason" /);
    expect(sagaStatements[2]).toMatch(/^ALTER TABLE "order_saga_job" ADD CONSTRAINT "order_saga_job_step_check" CHECK /);
    expect(sagaBody).not.toMatch(/\b(DROP|TRUNCATE|DELETE|INSERT|UPDATE|RENAME)\b/i);
    expect(sagaBody).not.toMatch(/ALTER\s+COLUMN|SET\s+NOT\s+NULL|USING\s+\(|\bDEFAULT\b|\bINDEX\b/i);
    expect(sagaBody.split(BREAKPOINT)).toHaveLength(3);
  });

  test('order_saga_job.confirm_sent_at은 timestamptz·널 허용·기본값 없음이고 표 끝 칸이다(승인 명령을 처음 보내기 바로 전에 적는다, 리뷰 H1) [ASVS v5.0.0-2.3.4]', () => {
    expect(canon(sagaStatements[0]!).replace(/;$/, '')).toBe('alter table order_saga_job add column confirm_sent_at timestamp with time zone');
    const c = sagaShape.columns.at(-1)!;
    expect({ name: c.name, type: c.type, notNull: c.notNull, hasDefault: c.hasDefault }).toEqual({ name: 'confirm_sent_at', type: TZ, notNull: false, hasDefault: false });
  });

  test('purchase_order.failure_reason은 text·널 허용·기본값 없음이고 표 끝 칸이며, 값 목록 CHECK를 두지 않는다(결제 쪽 사유가 PRF-163에서 늘어난다) [ASVS v5.0.0-2.3.4]', () => {
    expect(canon(sagaStatements[1]!).replace(/;$/, '')).toBe('alter table purchase_order add column failure_reason text');
    const c = orderShape.columns.at(-1)!;
    expect({ name: c.name, type: c.type, notNull: c.notNull, hasDefault: c.hasDefault }).toEqual({ name: 'failure_reason', type: 'text', notNull: false, hasDefault: false });
    expect(orderShape.checks.map((k) => k.expr).join(' ')).not.toContain('failure_reason');
    expect(orderShape.indexes.map((i) => i.name)).toEqual(['purchase_order_hold_key']);
  });

  test('order_saga_job_step_check는 schema.ts와 같은 이름·식(step in RESERVE·CONFIRM·RELEASE, RELEASE는 리뷰 M4)이고, 값 목록이 도메인 SAGA_STEPS와 같은 값·차례다 [ASVS v5.0.0-2.3.2]', () => {
    expect(sagaShape.checks).toEqual([{ name: 'order_saga_job_step_check', expr: canon("step in ('RESERVE','CONFIRM','RELEASE')") }]);
    // canon은 표 한정자("order_saga_job".)와 따옴표를 지운다
    expect(canon(sagaStatements[2]!).replace(/;$/, '')).toBe(`alter table order_saga_job add constraint order_saga_job_step_check check(${sagaShape.checks[0]!.expr})`);
    expect(literalsOf(sagaShape.checks[0]!.expr)).toEqual([...SAGA_STEPS]);
  });
});

/** 0007(결제 결과 반영, PRF-163): 발권 재시도 큐 ticket_issue_job */
const ticketShape = shapeOf(ticketIssueJob);
const ticketFile = readFileSync(join(MIGRATIONS, `${TICKET_TAG}.sql`), 'utf8');
const ticketBody = ticketFile
  .split('\n')
  .filter((l) => !/^\s*--(?!>)/.test(l))
  .join('\n');
const ticketStatements = statementsOf(ticketFile);

describe('마이그레이션 SQL 파일(0007_ticket_issue_job.sql, PRF-163)', () => {
  test('문 셋뿐이다: ticket_issue_job을 만들고, 외래 키 하나와 쓸기 색인 하나를 더한다(다른 표를 바꾸거나 지우는 문·CHECK가 없다) [ASVS v5.0.0-2.3.4]', () => {
    expect(ticketStatements).toHaveLength(3);
    expect(ticketStatements[0]).toMatch(/^CREATE TABLE "ticket_issue_job" /);
    expect(ticketStatements[1]).toMatch(/^ALTER TABLE "ticket_issue_job" ADD CONSTRAINT "ticket_issue_job_order_id_purchase_order_id_fk" FOREIGN KEY /);
    expect(ticketStatements[2]).toMatch(/^CREATE INDEX "ticket_issue_job_next_attempt_idx" /);
    expect(ticketBody).not.toMatch(/\b(DROP|TRUNCATE|DELETE|INSERT|UPDATE|RENAME)\b(?! no action)/i);
    expect(ticketBody).not.toMatch(/ALTER\s+COLUMN|ADD\s+COLUMN|SET\s+NOT\s+NULL|USING\s+\(|\bCHECK\b|PARTITION/i);
    expect(ticketBody).not.toMatch(/ALTER TABLE "(?!ticket_issue_job")/);
    expect(ticketBody.split(BREAKPOINT)).toHaveLength(3);
  });

  test('ticket_issue_job의 열 이름·종류·널 허용이 정본 ERD(data.md §2)·schema.ts와 같고 SQL의 만드는 문도 같은 차례다(next_attempt_at·last_error만 비울 수 있다) [ASVS v5.0.0-2.3.4]', () => {
    expect(cols(ticketShape)).toEqual([
      ['order_id', 'uuid', true],
      ['event_id', 'uuid', true],
      ['attempts', 'integer', true],
      ['next_attempt_at', TZ, false],
      ['issue_due_at', TZ, true],
      ['last_error', 'text', false],
      ['created_at', TZ, true],
    ]);
    const body = ticketStatements[0]!;
    expect([...body.matchAll(/^\t"([a-z_]+)" /gm)].map((m) => m[1])).toEqual(ticketShape.columns.map((c) => c.name));
    const c = canon(body);
    for (const col of ticketShape.columns) expect(c, col.name).toContain(`${col.name} ${col.type}`);
    for (const col of ticketShape.columns.filter((x) => x.notNull && !x.primary)) expect(c, `${col.name} not null`).toMatch(new RegExp(`${col.name} ${col.type}( default \\d+)? not null`));
    for (const col of ticketShape.columns.filter((x) => !x.notNull)) expect(c, `${col.name} 널 허용`).not.toMatch(new RegExp(`${col.name} ${col.type}[^,]*not null`));
  });

  test('ticket_issue_job은 order_id 하나의 기본 키(한 주문에 행 하나)이고, 기본값은 attempts의 0 하나다 [ASVS v5.0.0-2.3.4]', () => {
    expect(ticketShape.columns.filter((x) => x.primary).map((x) => x.name)).toEqual(['order_id']);
    expect(ticketShape.primaryKeys).toEqual([]);
    const c = canon(ticketStatements[0]!);
    expect(c).toContain('order_id uuid primary key not null');
    expect((c.match(/primary key/g) ?? []).length).toBe(1);
    expect(ticketShape.columns.filter((x) => x.hasDefault).map((x) => x.name)).toEqual(['attempts']);
    expect(getTableConfig(ticketIssueJob).columns.find((x) => x.name === 'attempts')!.default).toBe(0);
    expect(c).toContain('attempts integer default 0 not null');
    expect([...ticketBody.matchAll(/\bDEFAULT\b/gi)]).toHaveLength(1);
    expect(ticketShape.checks).toEqual([]);
  });

  test('ticket_issue_job.order_id는 purchase_order.id를 가리키는 외래 키 하나이고, 이름·SQL이 schema.ts와 같다 [ASVS v5.0.0-2.3.4]', () => {
    const fks = getTableConfig(ticketIssueJob).foreignKeys;
    expect(fks.map((f) => f.getName())).toEqual(['ticket_issue_job_order_id_purchase_order_id_fk']);
    const ref = fks[0]!.reference();
    expect({ from: ref.columns.map((x) => x.name), to: getTableConfig(ref.foreignTable).name, toCols: ref.foreignColumns.map((x) => x.name) }).toEqual({
      from: ['order_id'],
      to: 'purchase_order',
      toCols: ['id'],
    });
    expect(canon(ticketStatements[1]!).replace(/;$/, '')).toBe(
      'alter table ticket_issue_job add constraint ticket_issue_job_order_id_purchase_order_id_fk foreign key(order_id)references purchase_order(id)on delete no action on update no action',
    );
    expect(ticketStatements[1]).toContain('REFERENCES "public"."purchase_order"("id")');
  });

  test('쓸기 색인: ticket_issue_job_next_attempt_idx는 ticket_issue_job (next_attempt_at)의 btree 일반 색인이고 WHERE가 없다. 이 표의 색인은 이것 하나다 [ASVS v5.0.0-2.3.4]', () => {
    expect(ticketShape.indexes).toEqual([{ name: 'ticket_issue_job_next_attempt_idx', unique: false, columns: ['next_attempt_at'], where: undefined }]);
    expect(canon(ticketStatements[2]!).replace(/;$/, '')).toBe('create index ticket_issue_job_next_attempt_idx on ticket_issue_job using btree(next_attempt_at)');
  });
});
