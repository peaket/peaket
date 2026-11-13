// 0000 마이그레이션이 운영 명령·감사 체인·CS 처리함 표를 만드는지 파일로 확인한다(Docker test-int는 heavy gate).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const sql = readFileSync(new URL('../migrations/0000_ops_command_audit.sql', import.meta.url), 'utf8');

describe('0000 ops 마이그레이션', () => {
  test('GAT110_운영_명령·승인·감사_체인·CS_처리함_표를_만든다', () => {
    for (const table of ['ops_command', 'command_event', 'command_approval', 'audit_chain', 'audit_chain_head', 'cs_case']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS cs_case_open_key');
    expect(sql).toContain("INSERT INTO audit_chain_head");
    expect(sql).toContain("CHECK (state IN ('DRAFTED'");
  });
});
