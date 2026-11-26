// F-06-4 core-svc support 마이그레이션 정적 검사(시험 담당 lane2-freeze-F-06-4-reviewfix, 시험 리뷰 TR-18 반영).
// 구현 전에는 파일이 없어 실패한다. 실제 PostgreSQL 적용은 구현 뒤 통합 시험(계획 §6)에서 한 번 본다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const sql = (): string => {
  try {
    return readFileSync(join(process.cwd(), 'migrations', '0049_support_appeal.sql'), 'utf8');
  } catch {
    throw new Error('migrations/0049_support_appeal.sql이 없다(계획 §3)');
  }
};

describe('core 0049 support appeal 표', () => {
  test('appeal 표를 만들고 kind·status·result CHECK와 필요한 칸을 둔다', () => {
    const t = sql();
    expect(t).toMatch(/CREATE TABLE IF NOT EXISTS "?appeal"?/i);
    for (const col of ['id', 'account_id', 'kind', 'target_id', 'body', 'status', 'result', 'result_note', 'dispatch_state', 'dispatch_attempts', 'next_dispatch_at', 'dispatched_at', 'case_id', 'submitted_at', 'decided_at']) {
      expect(t).toMatch(new RegExp(`"?${col}"?\\s`, 'i'));
    }
    expect(t).toMatch(/kind[^;]*CHECK[^;]*RESTRICTION[^;]*FRAUD_CASE/i);
    expect(t).toMatch(/status[^;]*CHECK[^;]*SUBMITTED[^;]*DECIDED[^;]*INVALID/i);
    expect(t).toMatch(/result[^;]*CHECK[^;]*LIFTED[^;]*KEPT[^;]*ACCEPTED[^;]*REJECTED/i);
  });

  test('계정·제출 순서와 다시 보내기 조회 인덱스를 만든다', () => {
    const t = sql();
    expect(t).toMatch(/CREATE INDEX IF NOT EXISTS[^;]*appeal_account_submitted_idx[^;]*ON "?appeal"?\s*\(\s*"?account_id"?\s*,\s*"?submitted_at"?\s*\)/i);
    expect(t).toMatch(/CREATE INDEX IF NOT EXISTS[^;]*appeal_dispatch_idx[^;]*ON "?appeal"?\s*\(\s*"?status"?\s*,\s*"?next_dispatch_at"?\s*\)/i);
  });

  test('core_app 권한을 주고 booking_restriction 표는 만들지 않는다', () => {
    const t = sql();
    expect(t).toMatch(/GRANT[^;]*ON "?appeal"?[^;]*TO core_app/i);
    expect(t).not.toMatch(/CREATE TABLE[^;]*booking_restriction/i);
  });

  test('dispatch_state는 PENDING·SENT·RETRY·FAILED 넷만 받는다', () => {
    const t = sql();
    expect(t).toMatch(/dispatch_state[^;]*CHECK[^;]*PENDING[^;]*SENT[^;]*RETRY[^;]*FAILED/i);
  });
});
