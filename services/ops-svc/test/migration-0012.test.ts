// 0012 마이그레이션이 감사 체인에 기록 원문과 직전 해시를 더하는지 파일로 확인한다(B3-H03, R-614).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const sql = readFileSync(new URL('../migrations/0012_audit_chain_record_json.sql', import.meta.url), 'utf8');

describe('0012 ops 감사 체인 마이그레이션', () => {
  test('R614_audit_chain에_record_json과_prev_hash를_더하고_기존_연쇄를_복원한다', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS record_json jsonb');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS prev_hash bytea');
    expect(sql).toContain('UPDATE audit_chain a');
    expect(sql).toContain('WHERE a.prev_hash IS NULL');
  });
});
