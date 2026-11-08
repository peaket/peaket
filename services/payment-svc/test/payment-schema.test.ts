// payment DB 표 셋(payment·payment_event·payment_confirm_job)의 모양을 DB 없이 본다(docs/data.md §2 ERD·§4 '결제 표 마이그레이션', BUILD_ORDER PRF-180).
// 마이그레이션 0001(payment.failure_category, BUILD_ORDER PRF-181)과 0002(UNKNOWN 조회 칸 셋과 부분 인덱스, BUILD_ORDER PRF-182)까지 본다.
// ① Drizzle 표 정의(schema.ts)를 getTableConfig로 읽어 정본과 같은지 보고, ② 마이그레이션 SQL(0000_payment.sql·0001_payment_failure_category.sql·0002_payment_unknown_query.sql)을 글로 읽어 표 정의 ↔ SQL 일치를 보고,
// ③ 마이그레이션 기록(meta)이 맞물리는지 본다(purchase-svc purchase-schema.test.ts와 같은 방식). 실제 PostgreSQL에 적용하는 것은 test-int가 본다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { PaymentEvent } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import { payment, paymentConfirmJob, paymentEvent } from '../src/modules/payment/adapters/db/schema.js';
import { PAYMENT_LEDGER_STATUSES } from '../src/modules/payment/domain/confirm-command.js';

const SERVICE = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = join(SERVICE, 'migrations');
const TAG = '0000_payment';
const TAG_0001 = '0001_payment_failure_category';
const TAG_0002 = '0002_payment_unknown_query';
const BREAKPOINT = '--> statement-breakpoint';
const dialect = new PgDialect();
const TZ = 'timestamp with time zone';

/** SQL 글을 견주기 좋게 줄인다: 표 한정자·따옴표를 지우고 따옴표 밖만 소문자로, 공백을 접고, 괄호·쉼표 둘레 공백을 없앤다(작은따옴표 안의 값은 그대로) */
function canon(s: string): string {
  return s
    .split("'")
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/"[a-z_]+"\./g, '').replace(/"/g, '').replace(/\s+/g, ' ').toLowerCase().replace(/ ?([(),]) ?/g, '$1')))
    .join("'")
    .trim();
}
const sqlText = (s: SQL): string => dialect.sqlToQuery(s).sql;
const literalsOf = (s: string): string[] => [...s.matchAll(/'([^']*)'/g)].map((m) => m[1]!);

function shapeOf(table: PgTable) {
  const c = getTableConfig(table);
  return {
    name: c.name,
    columns: c.columns.map((col) => ({ name: col.name, type: col.getSQLType(), notNull: col.notNull, hasDefault: col.hasDefault, primary: col.primary })),
    primaryKeys: c.primaryKeys.map((p) => ({ name: p.getName(), columns: p.columns.map((x) => x.name) })),
    indexes: c.indexes.map((i) => ({ name: i.config.name ?? '(이름 없음)', unique: i.config.unique, columns: i.config.columns.map((x) => (x as { name: string }).name) })),
    checks: c.checks.map((k) => ({ name: k.name, expr: canon(sqlText(k.value)) })),
  };
}
const paymentShape = shapeOf(payment);
const eventShape = shapeOf(paymentEvent);
const jobShape = shapeOf(paymentConfirmJob);
const TABLES = [payment, paymentEvent, paymentConfirmJob];
const SHAPES = [paymentShape, eventShape, jobShape];
const cols = (s: ReturnType<typeof shapeOf>): [string, string, boolean][] => s.columns.map((c) => [c.name, c.type, c.notNull]);
const checkOf = (s: ReturnType<typeof shapeOf>, name: string): string => s.checks.find((k) => k.name === name)!.expr;
/** 0000이 만든 모양(0001·0002가 더한 칸·CHECK·인덱스를 뺀다) */
const ADDED_COLUMN = 'failure_category';
const ADDED_CHECK = 'payment_failure_category_check';
const ADDED_COLUMNS_0002 = ['next_query_at', 'query_attempts', 'overdue_at', 'anomaly_logged_at'];
const ADDED_INDEX_0002 = 'payment_unknown_query_idx';
const ADDED_OVERDUE_INDEX_0002 = 'payment_unknown_status_changed_idx';
const ADDED_CHECK_0002 = 'payment_unknown_next_query_check';
const SHAPES_0000 = SHAPES.map((s) => ({
  ...s,
  columns: s.columns.filter((c) => c.name !== ADDED_COLUMN && !ADDED_COLUMNS_0002.includes(c.name)),
  checks: s.checks.filter((k) => k.name !== ADDED_CHECK && k.name !== ADDED_CHECK_0002),
  indexes: s.indexes.filter((i) => i.name !== ADDED_INDEX_0002 && i.name !== ADDED_OVERDUE_INDEX_0002),
}));

describe('표 정의(schema.ts)', () => {
  test('PRF180_표는 payment·payment_event·payment_confirm_job 셋이고 기본 스키마에 있다', () => {
    expect(SHAPES.map((s) => s.name)).toEqual(['payment', 'payment_event', 'payment_confirm_job']);
    for (const t of TABLES) expect(getTableConfig(t).schema).toBeUndefined();
  });

  test('PRF180_payment의 열 이름·종류·널 허용이 ERD와 같다', () => {
    expect(cols(paymentShape)).toEqual([
      ['id', 'uuid', true],
      ['order_id', 'uuid', true],
      ['event_id', 'uuid', true],
      ['attempt_id', 'uuid', true],
      ['attempt_no', 'integer', true],
      ['pg', 'text', true],
      ['pg_payment_ref', 'text', true],
      ['pg_confirm_token', 'text', false],
      ['deposit_secret_hash', 'bytea', false],
      ['amount', 'integer', true],
      ['status', 'text', true],
      ['deposit_due_at', TZ, false],
      ['virtual_account_no', 'text', false],
      ['virtual_account_bank', 'text', false],
      ['idempotency_key', 'text', true],
      ['payment_method_ref', 'text', false],
      ['card_bin', 'text', false],
      ['authenticated_at', TZ, true],
      ['created_at', TZ, true],
      ['approved_at', TZ, false],
      ['status_changed_at', TZ, true],
      ['failure_category', 'text', false],
      ['next_query_at', TZ, false],
      ['query_attempts', 'integer', true],
      ['overdue_at', TZ, false],
      ['anomaly_logged_at', TZ, false],
    ]);
  });

  test('PRF180_payment_event의 열이 ERD와 같다', () => {
    expect(cols(eventShape)).toEqual([
      ['payment_id', 'uuid', true],
      ['seq', 'bigint', true],
      ['event_key', 'uuid', true],
      ['type', 'text', true],
      ['exported', 'boolean', true],
      ['occurred_at', TZ, true],
    ]);
  });

  test('PRF180_payment_confirm_job의 열이 ERD와 같다(임대 두 칸만 비울 수 있다)', () => {
    expect(cols(jobShape)).toEqual([
      ['payment_id', 'uuid', true],
      ['next_attempt_at', TZ, true],
      ['lease_owner', 'text', false],
      ['lease_until', TZ, false],
      ['attempts', 'integer', true],
      ['created_at', TZ, true],
    ]);
  });

  test('PRF180_기본값은 payment.created_at·payment.query_attempts·job.attempts·job.created_at뿐이다', () => {
    const withDefault = SHAPES.flatMap((s) => s.columns.filter((c) => c.hasDefault).map((c) => `${s.name}.${c.name}`));
    expect(withDefault).toEqual(['payment.created_at', 'payment.query_attempts', 'payment_confirm_job.attempts', 'payment_confirm_job.created_at']);
  });

  test('PRF180_기본 키는 payment.id·payment_event(payment_id, seq)·payment_confirm_job.payment_id다', () => {
    expect(paymentShape.columns.filter((c) => c.primary).map((c) => c.name)).toEqual(['id']);
    expect(eventShape.primaryKeys.map((p) => p.columns)).toEqual([['payment_id', 'seq']]);
    expect(jobShape.columns.filter((c) => c.primary).map((c) => c.name)).toEqual(['payment_id']);
  });

  test('P-T53_주문당 결제 1건은 payment.order_id 유일 인덱스가 정한다 [ASVS v5.0.0-2.3.4]', () => {
    expect(paymentShape.indexes.filter((i) => i.unique)).toEqual([{ name: 'payment_order_id_key', unique: true, columns: ['order_id'] }]);
  });

  test('PRF180_PRF182_인덱스는 정본의 넷뿐이다(쓰기가 많은 표라 아낀다, 승인 명령과 UNKNOWN 조회는 잡기 인덱스, 1시간 표시는 상태 쓸기 인덱스)', () => {
    expect(paymentShape.indexes).toEqual([
      { name: 'payment_order_id_key', unique: true, columns: ['order_id'] },
      { name: ADDED_INDEX_0002, unique: false, columns: ['next_query_at'] },
      { name: ADDED_OVERDUE_INDEX_0002, unique: false, columns: ['status_changed_at'] },
    ]);
    expect(eventShape.indexes).toEqual([]);
    expect(jobShape.indexes).toEqual([{ name: 'payment_confirm_job_next_idx', unique: false, columns: ['next_attempt_at'] }]);
  });

  test('P-T53_이력과 승인 명령은 결제에 외래 키를 건다(결제 없는 행이 남지 않는다) [ASVS v5.0.0-2.3.3]', () => {
    for (const t of [paymentEvent, paymentConfirmJob]) {
      const fks = getTableConfig(t).foreignKeys.map((f) => f.reference());
      expect(fks).toHaveLength(1);
      expect(fks[0]!.columns.map((c) => c.name)).toEqual(['payment_id']);
      expect(getTableConfig(fks[0]!.foreignTable).name).toBe('payment');
      expect(fks[0]!.foreignColumns.map((c) => c.name)).toEqual(['id']);
    }
    expect(getTableConfig(payment).foreignKeys).toEqual([]);
  });

  test('PRF180_status CHECK는 도메인의 일곱 값과 같은 값·같은 차례다', () => {
    expect(literalsOf(checkOf(paymentShape, 'payment_status_check'))).toEqual([...PAYMENT_LEDGER_STATUSES]);
    expect(PAYMENT_LEDGER_STATUSES).toEqual(['ACCEPTED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED']);
  });

  test('P-T53_CHECK가 결제사 셋·금액 양수·시도 순번을 막는다 [ASVS v5.0.0-2.2.1]', () => {
    expect(literalsOf(checkOf(paymentShape, 'payment_pg_check'))).toEqual(['TOSS', 'PORTONE', 'SIMULATOR']);
    expect(checkOf(paymentShape, 'payment_amount_check')).toBe('amount > 0');
    expect(checkOf(paymentShape, 'payment_attempt_no_check')).toBe('attempt_no >= 1');
  });

  test('PRF180_payment_method_ref와 card_bin은 함께 있거나 함께 빈다, 순번과 시도 횟수의 범위도 CHECK다', () => {
    expect(checkOf(paymentShape, 'payment_method_ref_card_bin_check')).toBe('(payment_method_ref is null)=(card_bin is null)');
    expect(checkOf(eventShape, 'payment_event_seq_check')).toBe('seq >= 1');
    expect(checkOf(jobShape, 'payment_confirm_job_attempts_check')).toBe('attempts >= 0');
  });

  test('PRF181_failure_category CHECK는 분석용 실패 범주 여섯 값이고 asyncapi PaymentEvent와 같은 값이다', () => {
    const values = literalsOf(checkOf(paymentShape, ADDED_CHECK));
    expect(values).toEqual(['CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR', 'THROTTLED']);
    expect(values).toEqual(PaymentEvent.shape.failureCategory.unwrap().options);
  });

  test('PRF181_failure_category는 비울 수 있고(FAILED일 때만 채운다) 기본값이 없다', () => {
    expect(paymentShape.columns.find((c) => c.name === ADDED_COLUMN)).toEqual({ name: 'failure_category', type: 'text', notNull: false, hasDefault: false, primary: false });
  });

  test('P-T3_UNKNOWN 조회 인덱스는 UNKNOWN 행만 담는 부분 인덱스다', () => {
    const idx = getTableConfig(payment).indexes.find((i) => i.config.name === ADDED_INDEX_0002)!;
    expect(canon(sqlText(idx.config.where!))).toBe("status = 'UNKNOWN'");
  });

  test('P-T3_UNKNOWN 조회 칸 셋: next_query_at·overdue_at은 비울 수 있고 query_attempts는 기본 0이다', () => {
    const col = (name: string) => paymentShape.columns.find((c) => c.name === name)!;
    expect(col('next_query_at')).toEqual({ name: 'next_query_at', type: TZ, notNull: false, hasDefault: false, primary: false });
    expect(col('overdue_at')).toEqual({ name: 'overdue_at', type: TZ, notNull: false, hasDefault: false, primary: false });
    expect(col('query_attempts')).toEqual({ name: 'query_attempts', type: 'integer', notNull: true, hasDefault: true, primary: false });
  });

  test('P-T3_리뷰 고침 M4: anomaly_logged_at은 비울 수 있고 기본값이 없다', () => {
    expect(paymentShape.columns.find((c) => c.name === 'anomaly_logged_at')).toEqual({ name: 'anomaly_logged_at', type: TZ, notNull: false, hasDefault: false, primary: false });
  });

  test('P-T3_리뷰 고침 M7: 1시간 표시 인덱스는 UNKNOWN 행의 status_changed_at만 담는 부분 인덱스다', () => {
    const idx = getTableConfig(payment).indexes.find((i) => i.config.name === 'payment_unknown_status_changed_idx')!;
    expect(idx.config.columns.map((x) => (x as { name: string }).name)).toEqual(['status_changed_at']);
    expect(canon(sqlText(idx.config.where!))).toBe("status = 'UNKNOWN'");
  });

  test('P-T3_리뷰 고침 M7: UNKNOWN 행은 다음 조회 시각 없이 있을 수 없다(CHECK) [ASVS v5.0.0-2.3.3]', () => {
    expect(checkOf(paymentShape, 'payment_unknown_next_query_check')).toBe("status <> 'UNKNOWN' or next_query_at is not null");
  });

  test('PRF181_PRF182_CHECK 제약은 0000의 일곱에 0001의 failure_category와 0002의 다음 조회 시각을 더한 아홉뿐이다', () => {
    expect(SHAPES.flatMap((s) => s.checks.map((k) => k.name))).toEqual([
      'payment_unknown_next_query_check',
      'payment_status_check',
      'payment_pg_check',
      'payment_amount_check',
      'payment_attempt_no_check',
      'payment_method_ref_card_bin_check',
      'payment_failure_category_check',
      'payment_event_seq_check',
      'payment_confirm_job_attempts_check',
    ]);
  });
});

describe('마이그레이션 SQL(0000_payment.sql)', () => {
  const sqlFile = readFileSync(join(MIGRATIONS, `${TAG}.sql`), 'utf8').replace(/\r\n/g, '\n');
  const statements = sqlFile
    .split(BREAKPOINT)
    .map((s) => s.trim())
    .filter(Boolean);
  const createTable = (name: string): string => statements.find((s) => s.startsWith(`CREATE TABLE "${name}"`))!;
  const OUTBOX_MARK = '-- Outbox 부모 표(docs/data.md';
  const drizzlePart = sqlFile.slice(0, sqlFile.indexOf(OUTBOX_MARK));
  const outboxPart = sqlFile.slice(sqlFile.indexOf(OUTBOX_MARK));

  test('PRF180_문 차례는 표 셋 → 외래 키 둘 → 인덱스 둘 → Outbox다', () => {
    expect(statements.map((s) => /^(CREATE TABLE "[a-z_]+"|ALTER TABLE "[a-z_]+" ADD CONSTRAINT "[a-z_]+"|CREATE (UNIQUE )?INDEX "[a-z_]+"|--)/.exec(s)?.[0])).toEqual([
      'CREATE TABLE "payment"',
      'CREATE TABLE "payment_confirm_job"',
      'CREATE TABLE "payment_event"',
      'ALTER TABLE "payment_confirm_job" ADD CONSTRAINT "payment_confirm_job_payment_id_payment_id_fk"',
      'ALTER TABLE "payment_event" ADD CONSTRAINT "payment_event_payment_id_payment_id_fk"',
      'CREATE UNIQUE INDEX "payment_order_id_key"',
      'CREATE INDEX "payment_confirm_job_next_idx"',
      '--',
    ]);
  });

  test('PRF180_지우거나 바꾸는 문이 없다', () => {
    expect(sqlFile).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM|UPDATE "|RENAME)\b/);
  });

  test('PRF180_schema.ts의 열이 모두 SQL에 있고 그 밖의 열은 없다', () => {
    for (const s of SHAPES_0000) {
      const inSql = [...createTable(s.name).matchAll(/^\t"([a-z_]+)" /gm)].map((m) => m[1]!);
      expect(inSql, s.name).toEqual(s.columns.map((c) => c.name));
    }
  });

  test('PRF180_열 종류와 널 불허가 schema.ts와 같다', () => {
    for (const s of SHAPES_0000) {
      const c = canon(createTable(s.name));
      for (const col of s.columns) {
        expect(c, `${s.name}.${col.name}`).toContain(`${col.name} ${col.type}`);
        const line = createTable(s.name).split('\n').find((l) => l.startsWith(`\t"${col.name}" `))!;
        expect(/NOT NULL/.test(line), `${s.name}.${col.name} 널 불허`).toBe(col.notNull);
      }
    }
  });

  test('PRF180_기본 키가 같은 이름·같은 열 차례로 SQL에 있다', () => {
    for (const s of SHAPES_0000) {
      const c = canon(createTable(s.name));
      for (const p of s.primaryKeys) expect(c, p.name).toContain(`constraint ${p.name} primary key(${p.columns.join(',')})`);
      for (const col of s.columns.filter((x) => x.primary)) expect(c, `${s.name}.${col.name}`).toContain(`${col.name} ${col.type} primary key not null`);
    }
  });

  test('P-T53_schema.ts의 check 제약이 같은 이름·같은 식으로 SQL에 있다 [ASVS v5.0.0-2.2.1]', () => {
    for (const s of SHAPES_0000) {
      const c = canon(createTable(s.name));
      for (const k of s.checks) expect(c, k.name).toContain(`constraint ${k.name} check(${k.expr})`);
    }
  });

  test('P-T53_인덱스가 같은 이름·같은 표·같은 열·같은 유일 여부로 SQL에 있다 [ASVS v5.0.0-2.3.4]', () => {
    for (const s of SHAPES_0000) {
      for (const i of s.indexes) {
        const stmt = statements.find((x) => x.includes(`INDEX "${i.name}"`));
        expect(stmt, i.name).toBeDefined();
        expect(canon(stmt!).replace(/;$/, '')).toBe(`create ${i.unique ? 'unique ' : ''}index ${i.name} on ${s.name} using btree(${i.columns.join(',')})`);
      }
    }
  });

  test('P-T53_이력과 승인 명령의 외래 키가 SQL에 있다 [ASVS v5.0.0-2.3.3]', () => {
    for (const t of ['payment_event', 'payment_confirm_job']) {
      const stmt = statements.find((s) => s.startsWith(`ALTER TABLE "${t}" ADD CONSTRAINT`));
      expect(stmt, t).toBeDefined();
      expect(canon(stmt!)).toContain('foreign key(payment_id)references payment(id)');
    }
  });

  test('PRF180_결제 표는 나누지 않는다(ADR-0114), 파티션 선언은 Outbox 하나뿐이고 파티션을 미리 만들지 않는다', () => {
    expect(drizzlePart).not.toMatch(/PARTITION/i);
    expect([...sqlFile.matchAll(/PARTITION BY/gi)]).toHaveLength(1);
    expect(outboxPart).toMatch(/\) PARTITION BY RANGE \("id"\);/);
    expect(sqlFile).not.toMatch(/PARTITION\s+OF|FOR\s+VALUES|ATTACH\s+PARTITION/i);
  });

  test('PRF180_Outbox 부분은 서비스 뼈대 템플릿 0002_outbox.sql과 글자까지 같다', () => {
    const template = readFileSync(join(SERVICE, '../../packages/platform/template/migrations/0002_outbox.sql'), 'utf8').replace(/\r\n/g, '\n');
    expect(outboxPart.trim()).toBe(template.trim());
  });

  test('PRF180_정본이 뒤 단계로 미룬 표를 만들지 않는다', () => {
    expect([...sqlFile.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual(['outbox', 'payment', 'payment_confirm_job', 'payment_event']);
  });
});

describe('마이그레이션 SQL(0001_payment_failure_category.sql)', () => {
  const sqlFile = readFileSync(join(MIGRATIONS, `${TAG_0001}.sql`), 'utf8').replace(/\r\n/g, '\n');
  const noComments = sqlFile.replace(/^--.*$/gm, '');
  const statements = noComments
    .split(BREAKPOINT)
    .map((s) => s.trim())
    .filter(Boolean);

  test('PRF181_문은 칸 더하기와 CHECK 더하기 둘뿐이고 칸을 먼저 더한다', () => {
    expect(statements.map((s) => /^ALTER TABLE "payment" ADD (COLUMN|CONSTRAINT) "[a-z_]+"/.exec(s)?.[0])).toEqual(['ALTER TABLE "payment" ADD COLUMN "failure_category"', 'ALTER TABLE "payment" ADD CONSTRAINT "payment_failure_category_check"']);
  });

  test('PRF181_칸의 종류와 널 허용이 schema.ts와 같다(NOT NULL·DEFAULT 없음)', () => {
    const col = paymentShape.columns.find((c) => c.name === ADDED_COLUMN)!;
    expect(canon(statements[0]!).replace(/;$/, '')).toBe(`alter table payment add column ${col.name} ${col.type}`);
    expect(statements[0]).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  test('P-T53_CHECK가 schema.ts와 같은 이름·같은 식으로 SQL에 있다 [ASVS v5.0.0-2.2.1]', () => {
    expect(canon(statements[1]!).replace(/;$/, '')).toBe(`alter table payment add constraint ${ADDED_CHECK} check(${checkOf(paymentShape, ADDED_CHECK)})`);
  });

  test('PRF181_지우거나 바꾸는 문이 없고 표·인덱스를 더 만들지 않는다', () => {
    expect(noComments).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM|UPDATE "|RENAME|CREATE (TABLE|INDEX|UNIQUE))\b/);
  });
});

describe('마이그레이션 SQL(0002_payment_unknown_query.sql)', () => {
  const sqlFile = readFileSync(join(MIGRATIONS, `${TAG_0002}.sql`), 'utf8').replace(/\r\n/g, '\n');
  const noComments = sqlFile.replace(/^--.*$/gm, '');
  const statements = noComments
    .split(BREAKPOINT)
    .map((s) => s.trim())
    .filter(Boolean);

  test('P-T3_문은 칸 넷을 더하고 CHECK를 건 뒤 부분 인덱스 둘을 만드는 일곱이다', () => {
    expect(statements.map((s) => /^(ALTER TABLE "payment" ADD (COLUMN|CONSTRAINT) "[a-z_]+"|CREATE INDEX "[a-z_]+")/.exec(s)?.[0])).toEqual([
      'ALTER TABLE "payment" ADD COLUMN "next_query_at"',
      'ALTER TABLE "payment" ADD COLUMN "query_attempts"',
      'ALTER TABLE "payment" ADD COLUMN "overdue_at"',
      'ALTER TABLE "payment" ADD COLUMN "anomaly_logged_at"',
      'ALTER TABLE "payment" ADD CONSTRAINT "payment_unknown_next_query_check"',
      'CREATE INDEX "payment_unknown_query_idx"',
      'CREATE INDEX "payment_unknown_status_changed_idx"',
    ]);
  });

  test('P-T3_칸의 종류·널 허용·기본값이 schema.ts와 같다', () => {
    const line = (name: string) => canon(statements.find((s) => s.includes(`ADD COLUMN "${name}"`))!).replace(/;$/, '');
    expect(line('next_query_at')).toBe(`alter table payment add column next_query_at ${TZ}`);
    expect(line('overdue_at')).toBe(`alter table payment add column overdue_at ${TZ}`);
    expect(line('anomaly_logged_at')).toBe(`alter table payment add column anomaly_logged_at ${TZ}`);
    expect(line('query_attempts')).toBe('alter table payment add column query_attempts integer default 0 not null');
  });

  test('P-T3_부분 인덱스 둘과 CHECK가 schema.ts와 같은 이름·열·조건으로 SQL에 있다', () => {
    expect(canon(statements[4]!).replace(/;$/, '')).toBe(`alter table payment add constraint ${ADDED_CHECK_0002} check(${checkOf(paymentShape, ADDED_CHECK_0002)})`);
    expect(canon(statements[5]!).replace(/;$/, '')).toBe("create index payment_unknown_query_idx on payment using btree(next_query_at)where status = 'UNKNOWN'");
    expect(canon(statements[6]!).replace(/;$/, '')).toBe("create index payment_unknown_status_changed_idx on payment using btree(status_changed_at)where status = 'UNKNOWN'");
  });

  test('PRF182_지우거나 바꾸는 문이 없고 표를 더 만들지 않는다', () => {
    expect(noComments).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM|UPDATE "|RENAME|CREATE TABLE)\b/);
  });
});

describe('마이그레이션 기록(migrations/meta)', () => {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { dialect: string; entries: { idx: number; tag: string; when: number; breakpoints: boolean }[] };
  interface SnapTable {
    columns: Record<string, { type: string; notNull: boolean; primaryKey: boolean }>;
    checkConstraints: Record<string, unknown>;
    compositePrimaryKeys: Record<string, { name: string; columns: string[] }>;
    foreignKeys: Record<string, unknown>;
    indexes: Record<string, { isUnique: boolean }>;
  }
  type Snapshot = { id: string; prevId: string; tables: Record<string, SnapTable> };
  const snapshotOf = (file: string): Snapshot => JSON.parse(readFileSync(join(MIGRATIONS, 'meta', file), 'utf8')) as Snapshot;
  const snapshot = snapshotOf('0000_snapshot.json');
  const second = snapshotOf('0001_snapshot.json');
  const latest = snapshotOf('0002_snapshot.json');

  test('PRF182_기록은 0000·0001·0002 차례이고 SQL 파일과 맞는다', () => {
    expect(journal.dialect).toBe('postgresql');
    expect(journal.entries.map((e) => [e.idx, e.tag])).toEqual([
      [0, TAG],
      [1, TAG_0001],
      [2, TAG_0002],
    ]);
    for (const e of journal.entries) {
      expect(e.breakpoints, e.tag).toBe(true);
      expect(e.when, e.tag).toBeGreaterThan(0);
      expect(existsSync(join(MIGRATIONS, `${e.tag}.sql`)), e.tag).toBe(true);
    }
    expect(journal.entries[1]!.when).toBeGreaterThan(journal.entries[0]!.when);
    expect(journal.entries[2]!.when).toBeGreaterThan(journal.entries[1]!.when);
  });

  test('PRF180_migrations 폴더의 SQL과 스냅샷은 기록에 있는 것뿐이다', () => {
    expect(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))).toEqual([`${TAG}.sql`, `${TAG_0001}.sql`, `${TAG_0002}.sql`]);
    expect(readdirSync(join(MIGRATIONS, 'meta')).filter((f) => f.endsWith('_snapshot.json'))).toEqual(['0000_snapshot.json', '0001_snapshot.json', '0002_snapshot.json']);
  });

  test('PRF180_첫 스냅샷은 앞이 없다', () => {
    expect(snapshot.prevId).toBe('00000000-0000-0000-0000-000000000000');
  });

  test('PRF181_0001 스냅샷의 앞은 0000 스냅샷이다', () => {
    expect(second.prevId).toBe(snapshot.id);
  });

  test('PRF182_0002 스냅샷의 앞은 0001 스냅샷이다', () => {
    expect(latest.prevId).toBe(second.id);
  });

  test('PRF182_0001 스냅샷은 0002가 더한 칸과 인덱스를 모른다', () => {
    const t = second.tables['public.payment']!;
    for (const name of ADDED_COLUMNS_0002) expect(Object.keys(t.columns)).not.toContain(name);
    expect(Object.keys(t.indexes)).not.toContain(ADDED_INDEX_0002);
    expect(Object.keys(t.columns)).toContain(ADDED_COLUMN);
  });

  test('PRF181_0000 스냅샷은 0001이 더한 칸과 CHECK를 모른다', () => {
    const t = snapshot.tables['public.payment']!;
    expect(Object.keys(t.columns)).toEqual(SHAPES_0000[0]!.columns.map((c) => c.name));
    expect(Object.keys(t.checkConstraints)).toEqual(SHAPES_0000[0]!.checks.map((k) => k.name));
  });

  test('PRF181_마지막 스냅샷의 표·열·기본 키·check가 schema.ts와 같다(Outbox는 손으로 쓴 SQL이라 스냅샷에 없다)', () => {
    expect(Object.keys(latest.tables).sort()).toEqual(SHAPES.map((s) => `public.${s.name}`).sort());
    for (const s of SHAPES) {
      const t = latest.tables[`public.${s.name}`]!;
      expect(Object.entries(t.columns).map(([n, c]) => [n, c.type, c.notNull]), s.name).toEqual(cols(s));
      expect(Object.entries(t.columns).filter(([, c]) => c.primaryKey).map(([n]) => n), s.name).toEqual(s.columns.filter((c) => c.primary).map((c) => c.name));
      expect(Object.keys(t.checkConstraints), s.name).toEqual(s.checks.map((k) => k.name));
      expect(Object.values(t.compositePrimaryKeys).map((p) => [p.name, p.columns]), s.name).toEqual(s.primaryKeys.map((p) => [p.name, p.columns]));
      expect(Object.entries(t.indexes).map(([n, x]) => [n, x.isUnique]), s.name).toEqual(s.indexes.map((x) => [x.name, x.unique]));
    }
  });

  test('PRF181_마지막 스냅샷의 외래 키 이름이 schema.ts와 같다', () => {
    TABLES.forEach((table, i) => {
      const t = latest.tables[`public.${SHAPES[i]!.name}`]!;
      expect(Object.keys(t.foreignKeys), SHAPES[i]!.name).toEqual(getTableConfig(table).foreignKeys.map((f) => f.getName()));
    });
  });
});
