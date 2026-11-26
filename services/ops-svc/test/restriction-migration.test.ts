// F-06-4 ops 마이그레이션 정적 검사(시험 담당 lane2-freeze-F-06-4-reviewfix, 시험 리뷰 TR-18 반영).
// 이 가지에는 booking_restriction 표가 없으므로(F-04-13 0037 소유) 실행이 아니라 SQL 구조를 본다.
// 실제 적용·행·판은 합성 트리에서 통합 시험으로 한 번 본다(계획 §6·§9).
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
    expect(t).toMatch(/ALTER TABLE "?approval_request"? ADD COLUMN IF NOT EXISTS "?restriction_ends_at"?/i);
    expect(t).not.toMatch(/CREATE TABLE[^;]*booking_restriction/i);
  });

  test('DO $$ 블록 안에서 booking_restriction이 있을 때만 reason_code CHECK를 넓힌다(FRAUD + 일반 사유 넷)', () => {
    const t = sql();
    // 구조: DO $$ ... BEGIN ... IF to_regclass('booking_restriction') IS NOT NULL THEN ... END IF; ... END $$;
    expect(t).toMatch(/DO \$\$/i);
    expect(t).toMatch(/BEGIN[\s\S]*IF\s+to_regclass\('booking_restriction'\)\s+IS\s+NOT\s+NULL\s+THEN[\s\S]*END\s+IF;[\s\S]*END\s+\$\$/i);
    const thenBlock = /IF\s+to_regclass\('booking_restriction'\)\s+IS\s+NOT\s+NULL\s+THEN([\s\S]*?)END\s+IF;/i.exec(t)?.[1] ?? '';
    expect(thenBlock, 'THEN ... END IF 안에 ALTER가 있어야 한다').toMatch(/ALTER TABLE "?booking_restriction"? DROP CONSTRAINT IF EXISTS "?booking_restriction_reason_code_check"?/i);
    expect(thenBlock).toMatch(/ALTER TABLE "?booking_restriction"? ADD CONSTRAINT "?booking_restriction_reason_code_check"? CHECK/i);
    for (const code of ['FRAUD', 'ABUSE_CANCEL', 'ABUSE_TRANSFER', 'ABUSE_MULTI_ACCOUNT', 'ABUSE_RESALE']) expect(thenBlock).toContain(`'${code}'`);
    // END IF 뒤에 ALTER가 밀려나면 표 없는 이 가지에서 0040이 실패한다
    const afterIf = /END\s+IF;([\s\S]*?)END\s+\$\$/i.exec(t)?.[1] ?? '';
    expect(afterIf).not.toMatch(/ALTER TABLE "?booking_restriction"?/i);
  });

  test('같은 계정에 열린 BOOKING_RESTRICTION 하나를 (kind, target_ref) 열의 부분 유일 인덱스로 막는다', () => {
    const t = sql();
    expect(t).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS[^;]*approval_request_booking_restriction_open_uq[^;]*ON "?approval_request"?\s*\(\s*"?kind"?\s*,\s*"?target_ref"?\s*\)/i);
    expect(t).toMatch(/WHERE kind = 'BOOKING_RESTRICTION' AND status IN \('PENDING_APPROVAL', 'EXECUTING', 'FAILED'\)/i);
  });

  test('restriction_ends_at은 timestamptz이고 다른 종류에는 뜻이 없다는 주석이 있다', () => {
    const t = sql();
    expect(t).toMatch(/restriction_ends_at"?\s+timestamp with time zone/i);
    expect(t).toMatch(/BOOKING_RESTRICTION/);
  });
});
