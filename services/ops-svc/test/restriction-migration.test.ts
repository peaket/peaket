// F-06-4 ops 마이그레이션 정적 검사(시험 담당, 2026-11-26). 이 가지에는 booking_restriction 표가 없으므로(F-04-13 0037 소유)
// 실행이 아니라 SQL 글자를 본다. 실제 적용·행·판은 합성 트리에서 통합 시험으로 한 번 본다(계획 §6·§9).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const sql = (): string => {
  try {
    return readFileSync(join(process.cwd(), 'migrations', '0040_booking_restriction_abuse.sql'), 'utf8');
  } catch {
    throw new Error('migrations/0040_booking_restriction_abuse.sql이 없다(계획 §3)');
  }
};

describe('ops 0040 예매 제한 사유·요청 끝', () => {
  test('approval_request.restriction_ends_at을 더하고 표를 새로 만들지 않는다', () => {
    const t = sql();
    expect(t).toMatch(/ALTER TABLE "approval_request" ADD COLUMN IF NOT EXISTS "restriction_ends_at"/i);
    expect(t).not.toMatch(/CREATE TABLE[^;]*booking_restriction/i);
  });

  test('booking_restriction이 있는 합성 트리에서만 reason_code CHECK를 넓힌다(FRAUD + 일반 사유 넷)', () => {
    const t = sql();
    expect(t).toMatch(/to_regclass\('booking_restriction'\)/i);
    expect(t).toMatch(/booking_restriction_reason_code_check/i);
    for (const code of ['FRAUD', 'ABUSE_CANCEL', 'ABUSE_TRANSFER', 'ABUSE_MULTI_ACCOUNT', 'ABUSE_RESALE']) expect(t).toContain(`'${code}'`);
  });

  test('같은 계정에 열린 BOOKING_RESTRICTION은 하나인 부분 유일 인덱스를 만든다', () => {
    const t = sql();
    expect(t).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS[^;]*approval_request_booking_restriction_open_uq/i);
    expect(t).toMatch(/WHERE kind = 'BOOKING_RESTRICTION' AND status IN \('PENDING_APPROVAL', 'EXECUTING', 'FAILED'\)/i);
  });
});
