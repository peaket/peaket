// F-06-5 ops-svc 팬 조회·문의 마이그레이션 정적 검사(시험 담당 lane2-freeze-F-06-5-opencode).
// 구현 전에는 파일이 없어 실패한다. 실제 PostgreSQL 적용은 구현 뒤 통합 시험(계획 §6)에서 한 번 본다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const sql = (): string => {
  try {
    return readFileSync(join(process.cwd(), 'migrations', '0041_admin_data_access_inquiry.sql'), 'utf8');
  } catch {
    throw new Error('migrations/0041_admin_data_access_inquiry.sql이 없다(계획 §3)');
  }
};

describe('ops 0041 admin_data_access·cs_case.account_id', () => {
  test('admin_data_access 표를 만들고 고시 접속기록 칸과 2년 보존 칸을 둔다', () => {
    const t = sql();
    expect(t).toMatch(/CREATE TABLE IF NOT EXISTS "?admin_data_access"?/i);
    for (const col of ['id', 'admin_account_id', 'actor_role', 'promoter_id', 'action', 'target_kind', 'event_id', 'filter', 'occurred_at', 'reason', 'target_count', 'format', 'source_ip', 'source_service', 'recorded_at', 'retain_until']) {
      expect(t).toMatch(new RegExp(`"?${col}"?\\s`, 'i'));
    }
    expect(t).toMatch(/action[^;]*CHECK[^;]*LIST[^;]*DOWNLOAD[^;]*VIEW_UNMASKED[^;]*DATA_EXPORT/i);
    expect(t).toMatch(/target_kind[^;]*CHECK[^;]*ATTENDEE_LIST[^;]*SHIPPING_LIST[^;]*FAN_PROFILE[^;]*DATA_REQUEST/i);
    expect(t).toMatch(/source_ip[^;]*inet/i);
  });

  test('관리 계정·대상·계정 조회 인덱스를 만든다', () => {
    const t = sql();
    expect(t).toMatch(/CREATE INDEX IF NOT EXISTS[^;]*admin_data_access_admin_idx[^;]*ON "?admin_data_access"?\s*\(\s*"?admin_account_id"?\s*,\s*"?recorded_at"?/i);
    expect(t).toMatch(/CREATE INDEX IF NOT EXISTS[^;]*admin_data_access_target_idx[^;]*ON "?admin_data_access"?\s*\(\s*"?target_kind"?\s*,\s*"?occurred_at"?/i);
  });

  test('cs_case에 account_id를 더하고 문의 건을 그 계정으로 찾는 인덱스를 만든다', () => {
    const t = sql();
    expect(t).toMatch(/ALTER TABLE "?cs_case"? ADD COLUMN IF NOT EXISTS "?account_id"? uuid/i);
    expect(t).toMatch(/CREATE INDEX IF NOT EXISTS[^;]*cs_case_account_idx[^;]*ON "?cs_case"?\s*\(\s*"?account_id"?\s*,\s*"?created_at"?/i);
  });

  test('다시 돌려도 같은 결과이고 booking_restriction 표는 만들지 않는다', () => {
    const t = sql();
    expect(t).toMatch(/IF NOT EXISTS/i);
    expect(t).not.toMatch(/CREATE TABLE[^;]*booking_restriction/i);
    expect(t).not.toMatch(/ALTER TABLE "?appeal"?/i);
  });
});
