// payment DB 표 셋(payment·payment_event·payment_confirm_job)의 모양을 DB 없이 본다(docs/data.md §2 ERD·§4 '결제 표 마이그레이션', BUILD_ORDER PRF-180).
// 마이그레이션 0001(payment.failure_category, BUILD_ORDER PRF-181)과 0002(UNKNOWN 조회 칸 셋과 부분 인덱스, BUILD_ORDER PRF-182), 0003(명령 행 결제사 칸, BUILD_ORDER PRF-183), 0004(payment.pg_tx_id, BUILD_ORDER HOT-140)까지 본다.
// ① Drizzle 표 정의(schema.ts)를 getTableConfig로 읽어 정본과 같은지 보고, ② 마이그레이션 SQL(0000_payment.sql·0001_payment_failure_category.sql·0002_payment_unknown_query.sql)을 글로 읽어 표 정의 ↔ SQL 일치를 보고,
// ③ 마이그레이션 기록(meta)이 맞물리는지 본다(purchase-svc purchase-schema.test.ts와 같은 방식). 실제 PostgreSQL에 적용하는 것은 test-int가 본다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { PaymentEvent } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import { payment, paymentConfirmJob, paymentEvent, reconciliationDiff, reconciliationRun, reconciliationSeen, webhookReceipt, pgSwitch, eventPgConfig } from '../src/modules/payment/adapters/db/schema.js';
import { PAYMENT_LEDGER_STATUSES } from '../src/modules/payment/domain/confirm-command.js';

const SERVICE = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = join(SERVICE, 'migrations');
const TAG = '0000_payment';
const TAG_0001 = '0001_payment_failure_category';
const TAG_0002 = '0002_payment_unknown_query';
const TAG_0003 = '0003_payment_confirm_job_pg';
const TAG_0004 = '0004_payment_pg_tx_id';
const TAG_0005 = '0005_payment_webhook_receipt';
const TAG_0006 = '0006_payment_query_due';
const TAG_0007 = '0007_payment_deposit_reversal';
const TAG_0008 = '0008_payment_reconciliation';
const TAG_0009 = '0009_payment_pg_selection';
const ADDED_COLUMN_0009 = 'entry_opens_at';
const ADDED_COLUMN_0004 = 'pg_tx_id';
const ADDED_COLUMN_0005 = 'query_touched_at';
const ADDED_COLUMN_0006 = 'deposit_notified_at';
const JOB_PG_CHECK = 'payment_confirm_job_pg_check';
const JOB_CLAIM_INDEX = 'payment_confirm_job_claim_idx';
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
const receiptShape = shapeOf(webhookReceipt);
const reconShapes = [shapeOf(reconciliationRun), shapeOf(reconciliationSeen), shapeOf(reconciliationDiff)];
const selectionShapes = [shapeOf(pgSwitch), shapeOf(eventPgConfig)];
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
const ADDED_INDEX_0005 = 'payment_pg_ref_idx';
const ADDED_CHECK_0002 = 'payment_unknown_next_query_check';
/** 0006이 0002의 잡기 인덱스·CHECK를 바꾼 이름(입금 대기까지 넓혔다, BUILD_ORDER HOT-151) */
const QUERY_DUE_INDEX = 'payment_query_due_idx';
const NEXT_QUERY_CHECK = 'payment_next_query_check';
/** 0008이 더한 payment 인덱스(대사의 원장 쪽 단계와 해시 지우기, BUILD_ORDER HOT-153) */
const RECON_INDEX_0008 = 'payment_recon_approved_idx';
const HASH_INDEX_0008 = 'payment_deposit_hash_idx';
const SHAPES_0000 = SHAPES.map((s) => ({
  ...s,
  columns: s.columns.filter((c) => c.name !== ADDED_COLUMN && c.name !== ADDED_COLUMN_0004 && c.name !== ADDED_COLUMN_0005 && c.name !== ADDED_COLUMN_0006 && c.name !== ADDED_COLUMN_0009 && !ADDED_COLUMNS_0002.includes(c.name) && !(s.name === 'payment_confirm_job' && c.name === 'pg')),
  checks: s.checks.filter((k) => k.name !== ADDED_CHECK && k.name !== NEXT_QUERY_CHECK && k.name !== JOB_PG_CHECK),
  // 0003이 잡기 색인을 바꾼다(0000은 next_attempt_at 하나짜리다)
  indexes: s.name === 'payment_confirm_job' ? [{ name: 'payment_confirm_job_next_idx', unique: false, columns: ['next_attempt_at'] }] : s.indexes.filter((i) => i.name !== QUERY_DUE_INDEX && i.name !== ADDED_OVERDUE_INDEX_0002 && i.name !== ADDED_INDEX_0005 && i.name !== RECON_INDEX_0008 && i.name !== HASH_INDEX_0008),
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
      ['deposit_notified_at', TZ, false],
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
      ['pg_tx_id', 'text', false],
      ['query_touched_at', TZ, false],
      ['entry_opens_at', TZ, false],
    ]);
  });

  test('P-T16_리뷰 고침 H4: 결제 시도를 묶는 pg_tx_id는 비울 수 있는 글 칸이고 기본값이 없다 [ASVS v5.0.0-2.2.3]', () => {
    expect(cols(paymentShape)).toContainEqual(['pg_tx_id', 'text', false]);
    expect(paymentShape.columns.find((c) => c.name === 'pg_tx_id')?.hasDefault).toBe(false);
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
      ['pg', 'text', true],
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

  test('PRF180_PRF182_인덱스는 정본의 일곱뿐이다(쓰기가 많은 표라 아낀다, 승인 명령과 UNKNOWN 조회는 잡기 인덱스, 1시간 표시는 상태 쓸기 인덱스, 웹훅은 참조 찾기 인덱스, 대사의 원장 쪽과 해시 지우기는 부분 인덱스)', () => {
    expect(paymentShape.indexes).toEqual([
      { name: 'payment_order_id_key', unique: true, columns: ['order_id'] },
      { name: QUERY_DUE_INDEX, unique: false, columns: ['next_query_at'] },
      { name: ADDED_OVERDUE_INDEX_0002, unique: false, columns: ['status_changed_at'] },
      { name: ADDED_INDEX_0005, unique: false, columns: ['pg', 'pg_payment_ref'] },
      { name: RECON_INDEX_0008, unique: false, columns: ['pg', 'approved_at', 'id'] },
      { name: HASH_INDEX_0008, unique: false, columns: ['approved_at'] },
    ]);
    expect(eventShape.indexes).toEqual([]);
    expect(jobShape.indexes).toEqual([{ name: JOB_CLAIM_INDEX, unique: false, columns: ['pg', 'next_attempt_at', 'payment_id'] }]);
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

  test('PRF181_failure_category CHECK는 분석용 실패 범주 일곱 값이고 asyncapi PaymentEvent와 같은 값이다(입금 전 취소, 0007)', () => {
    const values = literalsOf(checkOf(paymentShape, ADDED_CHECK));
    expect(values).toEqual(['CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR', 'THROTTLED', 'DEPOSIT_CANCELED']);
    expect(values).toEqual(PaymentEvent.shape.failureCategory.unwrap().options);
  });

  test('PRF181_failure_category는 비울 수 있고(FAILED일 때만 채운다) 기본값이 없다', () => {
    expect(paymentShape.columns.find((c) => c.name === ADDED_COLUMN)).toEqual({ name: 'failure_category', type: 'text', notNull: false, hasDefault: false, primary: false });
  });

  test('P-T36_단독 조회 인덱스는 UNKNOWN·입금 대기와 조회를 건 FAILED·APPROVED 행만 담는 부분 인덱스다(0006·0007)', () => {
    const idx = getTableConfig(payment).indexes.find((i) => i.config.name === QUERY_DUE_INDEX)!;
    expect(canon(sqlText(idx.config.where!))).toBe("status in('UNKNOWN','AWAITING_DEPOSIT')or(status in('FAILED','APPROVED')and next_query_at is not null)");
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

  test('P-T3_P-T36_UNKNOWN과 입금 대기 행은 다음 조회 시각 없이 있을 수 없다(CHECK, 0006) [ASVS v5.0.0-2.3.3]', () => {
    expect(checkOf(paymentShape, NEXT_QUERY_CHECK)).toBe("status not in('UNKNOWN','AWAITING_DEPOSIT')or next_query_at is not null");
  });

  test('PRF181_PRF182_PRF183_CHECK 제약은 0000의 일곱에 0001의 failure_category, 0002의 다음 조회 시각, 0003의 명령 행 결제사를 더한 열뿐이다', () => {
    expect(SHAPES.flatMap((s) => s.checks.map((k) => k.name))).toEqual([
      NEXT_QUERY_CHECK,
      'payment_status_check',
      'payment_pg_check',
      'payment_amount_check',
      'payment_attempt_no_check',
      'payment_method_ref_card_bin_check',
      'payment_failure_category_check',
      'payment_event_seq_check',
      'payment_confirm_job_attempts_check',
      JOB_PG_CHECK,
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
    // 0001의 목록은 여섯 값이다(일곱째 DEPOSIT_CANCELED는 0007이 더했다)
    expect(canon(statements[1]!).replace(/;$/, '')).toBe(`alter table payment add constraint ${ADDED_CHECK} check(${checkOf(paymentShape, ADDED_CHECK).replace(",'DEPOSIT_CANCELED'", '')})`);
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
    expect(canon(statements[4]!).replace(/;$/, '')).toBe(`alter table payment add constraint ${ADDED_CHECK_0002} check(status <> 'UNKNOWN' or next_query_at is not null)`);
    expect(canon(statements[5]!).replace(/;$/, '')).toBe("create index payment_unknown_query_idx on payment using btree(next_query_at)where status = 'UNKNOWN'");
    expect(canon(statements[6]!).replace(/;$/, '')).toBe("create index payment_unknown_status_changed_idx on payment using btree(status_changed_at)where status = 'UNKNOWN'");
  });

  test('PRF182_지우거나 바꾸는 문이 없고 표를 더 만들지 않는다', () => {
    expect(noComments).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM|UPDATE "|RENAME|CREATE TABLE)\b/);
  });
});

describe('마이그레이션 SQL(0006_payment_query_due.sql)', () => {
  const statements = readFileSync(join(MIGRATIONS, `${TAG_0006}.sql`), 'utf8').replace(/\r\n/g, '\n').replace(/^-- .*$/gm, '').split(BREAKPOINT).map((s) => canon(s));

  test('P-T36_0002의 CHECK와 인덱스를 지우고 입금 대기·늦은 입금 확인까지 넓히며 통보 시각 칸을 더한다(리뷰 고침 M3·M6) [ASVS v5.0.0-2.3.3]', () => {
    expect(statements).toEqual([
      `alter table payment drop constraint ${ADDED_CHECK_0002};`,
      `drop index ${ADDED_INDEX_0002};`,
      `alter table payment add column deposit_notified_at ${TZ};`,
      `create index ${QUERY_DUE_INDEX} on payment using btree(next_query_at)where status in('UNKNOWN','AWAITING_DEPOSIT')or(status = 'FAILED' and next_query_at is not null);`,
      `alter table payment add constraint ${NEXT_QUERY_CHECK} check(status not in('UNKNOWN','AWAITING_DEPOSIT')or next_query_at is not null);`,
    ]);
  });
});

describe('마이그레이션 SQL(0003_payment_confirm_job_pg.sql)', () => {
  const file = join(MIGRATIONS, `${TAG_0003}.sql`);
  const sqlFile = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
  const noComments = sqlFile.replace(/^--.*$/gm, '');
  const statements = noComments
    .split(BREAKPOINT)
    .map((s) => s.trim())
    .filter(Boolean);
  const canonOf = (needle: string): string => canon(statements.find((s) => s.includes(needle)) ?? '').replace(/;$/, '');

  test('P-T40_리뷰 고침 H1: 문은 옛 잡기 색인 지우기, 칸 더하기, CHECK 더하기, 새 잡기 색인 만들기 넷이다', () => {
    expect(statements.map((s) => /^(DROP INDEX "[a-z_]+"|ALTER TABLE "payment_confirm_job" ADD (COLUMN|CONSTRAINT) "[a-z_]+"|CREATE INDEX "[a-z_]+")/.exec(s)?.[0]).sort()).toEqual(
      [
        'ALTER TABLE "payment_confirm_job" ADD COLUMN "pg"',
        `ALTER TABLE "payment_confirm_job" ADD CONSTRAINT "${JOB_PG_CHECK}"`,
        `CREATE INDEX "${JOB_CLAIM_INDEX}"`,
        'DROP INDEX "payment_confirm_job_next_idx"',
      ].sort(),
    );
  });

  test('P-T40_리뷰 고침 H1: 칸은 text NOT NULL이고 기본값이 없다(원장의 결제사를 접수 때 그대로 쓴다)', () => {
    expect(canonOf('ADD COLUMN "pg"')).toBe('alter table payment_confirm_job add column pg text not null');
  });

  test('P-T40_리뷰 고침 H1: CHECK는 결제사 셋이고 schema.ts와 같은 이름·식이다 [ASVS v5.0.0-2.2.1]', () => {
    expect(checkOf(jobShape, JOB_PG_CHECK)).toBe("pg in('TOSS','PORTONE','SIMULATOR')");
    expect(canonOf(`ADD CONSTRAINT "${JOB_PG_CHECK}"`)).toBe(`alter table payment_confirm_job add constraint ${JOB_PG_CHECK} check(${checkOf(jobShape, JOB_PG_CHECK)})`);
  });

  test('P-T40_리뷰 고침 H1: 잡기 색인은 (pg, next_attempt_at, payment_id)다(채널마다 그 채널의 행만 본다) [ASVS v5.0.0-15.1.3]', () => {
    expect(jobShape.indexes).toEqual([{ name: JOB_CLAIM_INDEX, unique: false, columns: ['pg', 'next_attempt_at', 'payment_id'] }]);
    expect(canonOf(`CREATE INDEX "${JOB_CLAIM_INDEX}"`)).toBe(`create index ${JOB_CLAIM_INDEX} on payment_confirm_job using btree(pg,next_attempt_at,payment_id)`);
  });

  test('P-T40_리뷰 고침 H1: 표에 행이 없는 전제를 머리 주석에 적고, 표를 지우거나 다른 표를 건드리지 않는다', () => {
    expect(sqlFile).toMatch(/행이 없다/);
    expect(noComments).not.toMatch(/\b(TRUNCATE|DELETE FROM|UPDATE "|RENAME|CREATE TABLE|DROP TABLE)\b/);
  });
});

describe('웹훅 수신 기록 webhook_receipt(0005, BUILD_ORDER HOT-150)', () => {
  test('P-T17_열은 결제사·중복 제거 키·찾은 결제·받은 시각이고 찾은 결제만 비울 수 있다', () => {
    expect(cols(receiptShape)).toEqual([
      ['pg', 'text', true],
      ['dedup_key', 'text', true],
      ['payment_id', 'uuid', false],
      ['received_at', TZ, true],
    ]);
  });

  test('P-T17_(pg, dedup_key)가 기본 키라 같은 결제사의 같은 키는 한 줄이다 [ASVS v5.0.0-2.3.3]', () => {
    expect(receiptShape.primaryKeys.map((p) => p.columns)).toEqual([['pg', 'dedup_key']]);
  });

  test('P-T8_먼저 온 웹훅을 받으려고 결제에 외래 키를 걸지 않는다', () => {
    expect(getTableConfig(webhookReceipt).foreignKeys).toEqual([]);
  });

  test('P-T17_결제사는 셋만 받고 지우기 인덱스가 있다', () => {
    expect(literalsOf(checkOf(receiptShape, 'webhook_receipt_pg_check'))).toEqual(['TOSS', 'PORTONE', 'SIMULATOR']);
    expect(receiptShape.indexes).toEqual([{ name: 'webhook_receipt_received_at_idx', unique: false, columns: ['received_at'] }]);
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
  const third = snapshotOf('0002_snapshot.json');
  const fourth = snapshotOf('0003_snapshot.json');
  const fifth = snapshotOf('0004_snapshot.json');
  const sixth = snapshotOf('0005_snapshot.json');
  const seventh = snapshotOf('0006_snapshot.json');
  const eighth = snapshotOf('0007_snapshot.json');
  const ninth = snapshotOf('0008_snapshot.json');
  const latest = snapshotOf('0009_snapshot.json');

  test('PRF182_PRF183_기록은 0000~0009 차례이고 SQL 파일과 맞는다', () => {
    expect(journal.dialect).toBe('postgresql');
    expect(journal.entries.map((e) => [e.idx, e.tag])).toEqual([
      [0, TAG],
      [1, TAG_0001],
      [2, TAG_0002],
      [3, TAG_0003],
      [4, TAG_0004],
      [5, TAG_0005],
      [6, TAG_0006],
      [7, TAG_0007],
      [8, TAG_0008],
      [9, TAG_0009],
    ]);
    for (const e of journal.entries) {
      expect(e.breakpoints, e.tag).toBe(true);
      expect(e.when, e.tag).toBeGreaterThan(0);
      expect(existsSync(join(MIGRATIONS, `${e.tag}.sql`)), e.tag).toBe(true);
    }
    expect(journal.entries[1]!.when).toBeGreaterThan(journal.entries[0]!.when);
    expect(journal.entries[2]!.when).toBeGreaterThan(journal.entries[1]!.when);
    expect(journal.entries[3]!.when).toBeGreaterThan(journal.entries[2]!.when);
    expect(journal.entries[4]!.when).toBeGreaterThan(journal.entries[3]!.when);
    expect(journal.entries[5]!.when).toBeGreaterThan(journal.entries[4]!.when);
    expect(journal.entries[6]!.when).toBeGreaterThan(journal.entries[5]!.when);
    expect(journal.entries[7]!.when).toBeGreaterThan(journal.entries[6]!.when);
    expect(journal.entries[8]!.when).toBeGreaterThan(journal.entries[7]!.when);
    expect(journal.entries[9]!.when).toBeGreaterThan(journal.entries[8]!.when);
  });

  test('PRF180_migrations 폴더의 SQL과 스냅샷은 기록에 있는 것뿐이다', () => {
    expect(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))).toEqual([`${TAG}.sql`, `${TAG_0001}.sql`, `${TAG_0002}.sql`, `${TAG_0003}.sql`, `${TAG_0004}.sql`, `${TAG_0005}.sql`, `${TAG_0006}.sql`, `${TAG_0007}.sql`, `${TAG_0008}.sql`, `${TAG_0009}.sql`]);
    expect(readdirSync(join(MIGRATIONS, 'meta')).filter((f) => f.endsWith('_snapshot.json'))).toEqual(['0000_snapshot.json', '0001_snapshot.json', '0002_snapshot.json', '0003_snapshot.json', '0004_snapshot.json', '0005_snapshot.json', '0006_snapshot.json', '0007_snapshot.json', '0008_snapshot.json', '0009_snapshot.json']);
  });

  test('P-T16_리뷰 고침 H4: 0004 스냅샷의 앞은 0003 스냅샷이고, SQL은 pg_tx_id 칸만 더한다 [ASVS v5.0.0-2.2.3]', () => {
    expect(fifth.prevId).toBe(fourth.id);
    expect(Object.keys(fourth.tables['public.payment']!.columns)).not.toContain(ADDED_COLUMN_0004);
    const statements = readFileSync(join(MIGRATIONS, `${TAG_0004}.sql`), 'utf8').replace(/\r\n/g, '\n').replace(/^--.*$/gm, '').split(BREAKPOINT).map((s) => canon(s));
    expect(statements).toEqual(['alter table payment add column pg_tx_id text;']);
  });

  test('PRF180_첫 스냅샷은 앞이 없다', () => {
    expect(snapshot.prevId).toBe('00000000-0000-0000-0000-000000000000');
  });

  test('PRF181_0001 스냅샷의 앞은 0000 스냅샷이다', () => {
    expect(second.prevId).toBe(snapshot.id);
  });

  test('PRF182_0002 스냅샷의 앞은 0001 스냅샷이다', () => {
    expect(third.prevId).toBe(second.id);
  });

  test('P-T40_리뷰 고침 H1: 0003 스냅샷의 앞은 0002 스냅샷이고, 0002는 명령 행의 결제사 칸을 모른다', () => {
    expect(fourth.prevId).toBe(third.id);
    expect(Object.keys(third.tables['public.payment_confirm_job']!.columns)).not.toContain('pg');
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

  test('P-T17_0005 스냅샷의 앞은 0004 스냅샷이고, SQL은 수신 기록 표와 조회 신호 시각 칸, 인덱스 둘만 더한다 [ASVS v5.0.0-2.3.3]', () => {
    expect(sixth.prevId).toBe(fifth.id);
    expect(Object.keys(fifth.tables)).not.toContain('public.webhook_receipt');
    expect(Object.keys(fifth.tables['public.payment']!.indexes)).not.toContain(ADDED_INDEX_0005);
    expect(Object.keys(fifth.tables['public.payment']!.columns)).not.toContain(ADDED_COLUMN_0005);
    // 머리 주석만 지운다(`--> statement-breakpoint` 줄은 남긴다)
    const statements = readFileSync(join(MIGRATIONS, `${TAG_0005}.sql`), 'utf8').replace(/\r\n/g, '\n').replace(/^-- .*$/gm, '').split(BREAKPOINT).map((s) => canon(s));
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^create table webhook_receipt\(/);
    expect(statements[0]).toContain('primary key(pg,dedup_key)');
    expect(statements[1]).toBe('alter table payment add column query_touched_at timestamp with time zone;');
    expect(statements[2]).toBe('create index webhook_receipt_received_at_idx on webhook_receipt using btree(received_at);');
    expect(statements[3]).toBe('create index payment_pg_ref_idx on payment using btree(pg,pg_payment_ref);');
  });

  test('P-T36_0006 스냅샷의 앞은 0005 스냅샷이다', () => {
    expect(seventh.prevId).toBe(sixth.id);
    expect(Object.keys(sixth.tables['public.payment']!.indexes)).not.toContain(QUERY_DUE_INDEX);
  });

  test('P-T36_0007 스냅샷의 앞은 0006 스냅샷이다', () => {
    expect(eighth.prevId).toBe(seventh.id);
  });

  test('P-T26_0009 스냅샷의 앞은 0008 스냅샷이고, 선택 표 둘과 payment의 입장 시각 칸만 더한다', () => {
    expect(latest.prevId).toBe(ninth.id);
    for (const name of ['pg_switch', 'event_pg_config']) expect(Object.keys(ninth.tables)).not.toContain(`public.${name}`);
    expect(Object.keys(ninth.tables['public.payment']!.columns)).not.toContain(ADDED_COLUMN_0009);
    expect(Object.keys(latest.tables['public.payment']!.columns)).toContain(ADDED_COLUMN_0009);
    const sqlOf = readFileSync(join(MIGRATIONS, `${TAG_0009}.sql`), 'utf8').replace(/\r\n/g, '\n');
    expect(sqlOf).toContain('ALTER TABLE "payment" ADD COLUMN "entry_opens_at" timestamp with time zone;');
    expect(sqlOf).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM|UPDATE "|RENAME)\b/);
  });

  test('P-T32_0008 스냅샷의 앞은 0007 스냅샷이고, 대사 표 셋과 payment 부분 인덱스 둘을 더한다', () => {
    expect(ninth.prevId).toBe(eighth.id);
    for (const name of ['reconciliation_run', 'reconciliation_seen', 'reconciliation_diff']) expect(Object.keys(eighth.tables)).not.toContain(`public.${name}`);
    expect(Object.keys(eighth.tables['public.payment']!.indexes)).not.toContain(RECON_INDEX_0008);
    const sqlOf = readFileSync(join(MIGRATIONS, `${TAG_0008}.sql`), 'utf8').replace(/\r\n/g, '\n');
    expect(sqlOf).toContain('WHERE "payment"."status" = \'APPROVED\'');
    expect(sqlOf).toContain('WHERE "payment"."deposit_secret_hash" IS NOT NULL');
  });

  test('P-T32_불일치 기록은 결제사·결제 참조·종류로 유일하다(건마다 SEV1 한 번) [ASVS v5.0.0-2.3.4]', () => {
    expect(reconShapes[2]!.indexes).toContainEqual({ name: 'reconciliation_diff_pg_ref_kind_key', unique: true, columns: ['pg', 'payment_ref', 'kind'] });
    expect(reconShapes[0]!.indexes).toContainEqual({ name: 'reconciliation_run_pg_date_key', unique: true, columns: ['pg', 'recon_date'] });
  });

  test('PRF181_마지막 스냅샷의 표·열·기본 키·check가 schema.ts와 같다(Outbox는 손으로 쓴 SQL이라 스냅샷에 없다)', () => {
    const shapes = [...SHAPES, receiptShape, ...reconShapes, ...selectionShapes];
    expect(Object.keys(latest.tables).sort()).toEqual(shapes.map((s) => `public.${s.name}`).sort());
    for (const s of shapes) {
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
