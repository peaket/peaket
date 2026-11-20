// BAT-615 리뷰 2 RV-14: 0033이 `idempotency_record_operation_check`를 drop/re-add하면서 BAT-425(0032)가 더한
// `SHOP_CANCEL_REFUND_ACCOUNT`를 빠뜨리면 굿즈 지연 환급 계좌 다시 받기 경로의 멱등 기록 INSERT가 23514로 500이 된다.
// 0033 목록이 스키마(`schema.ts`의 `idempotencyRecord`)와 같고 0032까지의 모든 작업을 담는지 정적으로 본다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** 한 줄에서 작은따옴표로 감싼 작업 이름만 고른다 */
const operationsIn = (line: string): string[] => [...line.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]!);

/** 마이그레이션에서 멱등 작업 CHECK의 ADD CONSTRAINT 줄을 찾는다 */
const checkLine = (sql: string): string => {
  const line = sql.split('\n').find((l) => l.includes('ADD CONSTRAINT "idempotency_record_operation_check"'));
  if (!line) throw new Error('idempotency_record_operation_check ADD CONSTRAINT 줄이 없다');
  return line;
};

const sql32 = read('migrations/0032_merch_refund_replaces.sql');
const sql33 = read('migrations/0033_promoter_contract.sql');
const schema = read('src/modules/catalog/adapters/db/schema.ts');
const schemaStart = schema.indexOf('export const idempotencyRecord = idempotencyRecordTable([');
const schemaEnd = schema.indexOf(']);', schemaStart);
const schemaOps = operationsIn(schema.slice(schemaStart, schemaEnd));
const ops32 = operationsIn(checkLine(sql32));
const ops33 = operationsIn(checkLine(sql33));

describe('BAT-615 promoter_contract 마이그레이션', () => {
  test('스키마의 멱등 작업 목록에 BAT-425 환급 계좌 작업이 있다', () => {
    expect(schemaStart).toBeGreaterThanOrEqual(0);
    expect(schemaEnd).toBeGreaterThan(schemaStart);
    expect(schemaOps).toContain('SHOP_CANCEL_REFUND_ACCOUNT');
  });

  test('0033의 멱등 작업 CHECK는 스키마 목록과 같다(RV-14)', () => {
    expect(ops33).toEqual(schemaOps);
  });

  test('0033의 멱등 작업 CHECK는 0032까지의 모든 작업을 담는다(RV-14)', () => {
    expect(ops32).toContain('SHOP_CANCEL_REFUND_ACCOUNT');
    expect(ops33).toEqual(expect.arrayContaining(ops32));
  });
});
