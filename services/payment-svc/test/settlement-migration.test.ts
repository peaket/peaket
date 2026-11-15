// 정산·지급·KYC 마이그레이션 정적 시험(BUILD_ORDER BAT-610 잔여).
// Docker test-int는 heavy gate에서 돌리므로, 여기서는 SQL·journal·snapshot이 서로 맞는지만 본다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const sql15 = read('migrations/0015_settlement.sql');
const sql17 = read('migrations/0017_settlement_guards.sql');
const journal = JSON.parse(read('migrations/meta/_journal.json')) as { entries: { idx: number; tag: string }[] };

describe('정산·지급·KYC 마이그레이션', () => {
  test('journal이 0015_settlement를 갖는다', () => {
    expect(journal.entries.find((e) => e.idx === 15)?.tag).toBe('0015_settlement');
    expect(sql15.charCodeAt(0)).toBe('C'.charCodeAt(0));
  });

  test('정산서·원본·이의·지급 묶음·지급·KYC·계좌 표를 만든다', () => {
    for (const table of ['settlement_statement', 'statement_source', 'statement_dispute', 'payout_batch', 'payout', 'seller_kyc', 'payout_account']) {
      expect(sql15).toContain(`CREATE TABLE "${table}"`);
    }
  });

  test('상태·금액·KYC·지급 조건 CHECK와 유일 인덱스가 있다', () => {
    expect(sql15).toContain('settlement_statement_status_check');
    expect(sql15).toContain('payout_batch_status_check');
    expect(sql15).toContain('seller_kyc_status_check');
    expect(sql15).toContain('payout_ref_key');
    expect(sql15).toContain('payout_batch_key');
  });

  test('기존 payment 표를 건드리지 않는다', () => {
    expect(sql15).not.toContain('ALTER TABLE "payment"');
    expect(sql15).not.toMatch(/DROP TABLE/i);
  });

  test('snapshot이 새 표를 담는다', () => {
    const snap = JSON.parse(read('migrations/meta/0015_snapshot.json')) as { tables: Record<string, unknown> };
    expect(Object.keys(snap.tables)).toEqual(
      expect.arrayContaining(['public.settlement_statement', 'public.statement_source', 'public.statement_dispute', 'public.payout_batch', 'public.payout', 'public.seller_kyc', 'public.payout_account']),
    );
  });

  test('0017이 정산서 부분 유일 인덱스와 지급 묶음 결속 열을 더한다', () => {
    expect(journal.entries.find((e) => e.idx === 17)?.tag).toBe('0017_settlement_guards');
    expect(sql17).toContain('settlement_statement_event_key');
    expect(sql17).toContain('settlement_statement_product_key');
    expect(sql17).toContain(`WHERE "settlement_statement"."kind" = 'EVENT' and "settlement_statement"."status" <> 'SUPERSEDED'`);
    expect(sql17).toContain(`WHERE "settlement_statement"."kind" = 'PRODUCT' and "settlement_statement"."status" <> 'SUPERSEDED'`);
    expect(sql17).toContain('"payout_batch_id" uuid');
    expect(sql17).toContain('settlement_statement_payout_batch_id_payout_batch_id_fk');
    const snap = JSON.parse(read('migrations/meta/0017_snapshot.json')) as { tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }> };
    expect(snap.tables['public.settlement_statement']!.columns).toHaveProperty('payout_batch_id');
    expect(snap.tables['public.settlement_statement']!.indexes).toHaveProperty('settlement_statement_event_key');
    expect(snap.tables['public.settlement_statement']!.indexes).toHaveProperty('settlement_statement_product_key');
  });
});
