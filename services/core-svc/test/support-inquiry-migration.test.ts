// F-06-5 core-svc 문의 마이그레이션 정적 검사(시험 담당 lane2-freeze-F-06-5-opencode).
// 구현 전에는 파일이 없어 실패한다. 실제 PostgreSQL 적용은 구현 뒤 통합 시험(계획 §6)에서 한 번 본다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const sql = (): string => {
  try {
    return readFileSync(join(process.cwd(), 'migrations', '0055_support_inquiry.sql'), 'utf8');
  } catch {
    throw new Error('migrations/0055_support_inquiry.sql이 없다(계획 §3)');
  }
};

describe('core 0055 support inquiry 표', () => {
  test('inquiry 표를 만들고 유형·상태 CHECK와 접수 번호·기한·열람 칸을 둔다', () => {
    const t = sql();
    expect(t).toMatch(/CREATE TABLE IF NOT EXISTS "?inquiry"?/i);
    for (const col of ['id', 'number', 'account_id', 'category', 'order_ref', 'title', 'status', 'case_id', 'request_key', 'created_at', 'answered_at', 'fan_viewed_at', 'closed_at', 'purge_at']) {
      expect(t).toMatch(new RegExp(`"?${col}"?\\s`, 'i'));
    }
    expect(t).toMatch(/category[^;]*CHECK[^;]*BOOKING_PAYMENT[^;]*CANCEL_REFUND[^;]*TRANSFER[^;]*ENTRY[^;]*ACCOUNT[^;]*AUTOMATED_DECISION[^;]*SELLER_DISPUTE[^;]*MINOR_CONTRACT_CANCEL[^;]*MERCH[^;]*MODERATION_APPEAL[^;]*RESALE_POST_REPORT[^;]*OTHER/i);
    expect(t).toMatch(/status[^;]*CHECK[^;]*RECEIVED[^;]*IN_PROGRESS[^;]*ANSWERED[^;]*CLOSED/i);
    expect(t).toMatch(/number[^;]*UNIQUE/i);
  });

  test('inquiry_message 표를 만들고 작성자·종류 CHECK와 문의 외래키를 둔다', () => {
    const t = sql();
    expect(t).toMatch(/CREATE TABLE IF NOT EXISTS "?inquiry_message"?/i);
    for (const col of ['id', 'inquiry_id', 'author_kind', 'kind', 'body', 'created_at']) expect(t).toMatch(new RegExp(`"?${col}"?\\s`, 'i'));
    expect(t).toMatch(/author_kind[^;]*CHECK[^;]*FAN[^;]*AGENT[^;]*SYSTEM/i);
    expect(t).toMatch(/kind[^;]*CHECK[^;]*MESSAGE[^;]*PROGRESS[^;]*ANSWER/i);
    expect(t).toMatch(/REFERENCES "?inquiry"?/i);
  });

  test('계정·상태·건·멱등 조회 인덱스를 만든다', () => {
    const t = sql();
    expect(t).toMatch(/CREATE INDEX IF NOT EXISTS[^;]*inquiry_account_created_idx[^;]*ON "?inquiry"?\s*\(\s*"?account_id"?\s*,\s*"?created_at"?/i);
    expect(t).toMatch(/CREATE INDEX IF NOT EXISTS[^;]*inquiry_status_purge_idx[^;]*ON "?inquiry"?\s*\(\s*"?status"?\s*,\s*"?purge_at"?/i);
    expect(t).toMatch(/CREATE INDEX IF NOT EXISTS[^;]*inquiry_case_idx[^;]*ON "?inquiry"?\s*\(\s*"?case_id"?/i);
    expect(t).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS[^;]*inquiry_request_key_idx[^;]*ON "?inquiry"?\s*\(\s*"?account_id"?\s*,\s*"?request_key"?/i);
  });

  test('core_app 권한을 주고 appeal 표는 건드리지 않는다', () => {
    const t = sql();
    expect(t).toMatch(/GRANT[^;]*ON "?inquiry"?[^;]*TO core_app/i);
    expect(t).toMatch(/GRANT[^;]*ON "?inquiry_message"?[^;]*TO core_app/i);
    expect(t).not.toMatch(/ALTER TABLE "?appeal"?/i);
    expect(t).not.toMatch(/CREATE TABLE[^;]*booking_restriction/i);
  });
});
