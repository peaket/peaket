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

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<string, { name: string; columns: Record<string, unknown>; indexes: Record<string, unknown>; foreignKeys: Record<string, unknown>; checkConstraints: Record<string, unknown> }>;
  views?: Record<string, unknown>;
};

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

  // FIX-invariant-m3: 정본 docs/data.md §4 '미수금 이동 기록 표 이름 맞추기' ① 확장 — 표·기본 키·CHECK 둘·외래 키 둘·인덱스 하나는 이름만 바꾸고(다시 쓰기·다시 검증 없음)
  // 옛 이름은 security_invoker를 켠 자동 갱신 뷰로 남긴다. 문장은 계획 docs/review/plans/FIX-invariant-m3.md 'SQL 0028'이다
  test('PRF180 M3 ⑥ 0028은 이름만 바꾸는 문장 일곱과 옛 이름 뷰 하나뿐이고, 기록·스냅샷이 0027 뒤에 정본 이름 표를 담는다', () => {
    const sql28 = read('migrations/0028_receivable_movement_rename.sql').replace(/\r\n/g, '\n');
    const statements = sql28
      .replace(/^--.*$/gm, '')
      .split('--> statement-breakpoint')
      .map((x) => x.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    expect(statements).toEqual([
      'ALTER TABLE "receivable_move" RENAME TO "receivable_movement";',
      'ALTER INDEX "receivable_move_pkey" RENAME TO "receivable_movement_pkey";',
      'ALTER INDEX "receivable_move_receivable_idx" RENAME TO "receivable_movement_receivable_idx";',
      'ALTER TABLE "receivable_movement" RENAME CONSTRAINT "receivable_move_amount_check" TO "receivable_movement_amount_check";',
      'ALTER TABLE "receivable_movement" RENAME CONSTRAINT "receivable_move_kind_check" TO "receivable_movement_kind_check";',
      'ALTER TABLE "receivable_movement" RENAME CONSTRAINT "receivable_move_receivable_id_partner_receivable_id_fk" TO "receivable_movement_receivable_id_partner_receivable_id_fk";',
      'ALTER TABLE "receivable_movement" RENAME CONSTRAINT "receivable_move_statement_id_settlement_statement_id_fk" TO "receivable_movement_statement_id_settlement_statement_id_fk";',
      'CREATE VIEW "receivable_move" WITH (security_invoker = true) AS SELECT "id", "receivable_id", "statement_id", "amount", "kind", "moved_at" FROM "receivable_movement";',
    ]);
    // drizzle-kit이 만든 그대로(제약 지우고 다시 걸기·인덱스 다시 만들기·새 표)가 아니다
    for (const banned of [/\bDROP\b/i, /ADD CONSTRAINT/i, /CREATE (UNIQUE )?INDEX/i, /CREATE TABLE/i]) expect(sql28).not.toMatch(banned);
    expect(journal.entries.find((e) => e.idx === 28)?.tag).toBe('0028_receivable_movement_rename');
    const snap27 = JSON.parse(read('migrations/meta/0027_snapshot.json')) as Snapshot;
    const snap28 = JSON.parse(read('migrations/meta/0028_snapshot.json')) as Snapshot;
    expect(snap28.prevId).toBe(snap27.id);
    expect(snap28.id).not.toBe(snap27.id);
    expect(Object.keys(snap28.tables)).toContain('public.receivable_movement');
    expect(Object.keys(snap28.tables)).not.toContain('public.receivable_move');
    expect(Object.keys(snap28.views ?? {})).toEqual([]);
    const t = snap28.tables['public.receivable_movement']!;
    expect(t.name).toBe('receivable_movement');
    expect(Object.keys(t.indexes)).toEqual(['receivable_movement_receivable_idx']);
    expect(Object.keys(t.checkConstraints).sort()).toEqual(['receivable_movement_amount_check', 'receivable_movement_kind_check']);
    expect(Object.keys(t.foreignKeys).sort()).toEqual(['receivable_movement_receivable_id_partner_receivable_id_fk', 'receivable_movement_statement_id_settlement_statement_id_fk']);
    // 칸은 그대로다(이름만 바꾼다). 0027의 옛 이름 표와 칸 정의가 같다
    expect(t.columns).toEqual(snap27.tables['public.receivable_move']!.columns);
    // 다른 표는 0027과 같다
    const others = (snap: Snapshot) => Object.fromEntries(Object.entries(snap.tables).filter(([k]) => k !== 'public.receivable_move' && k !== 'public.receivable_movement'));
    expect(others(snap28)).toEqual(others(snap27));
  });
});
