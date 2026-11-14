// 0002 마이그레이션이 명령 실행 칸·SUCCEEDED·SCALE_CHANGE·감사 체크포인트 표를 만드는지 파일로 확인한다(Docker test-int는 heavy gate).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const sql = readFileSync(new URL('../migrations/0002_command_execution_audit.sql', import.meta.url), 'utf8');

describe('0002 ops 마이그레이션', () => {
  test('GAT310_명령_실행_칸과_SUCCEEDED·SCALE_CHANGE·감사_체크포인트를_더한다', () => {
    for (const column of ['attempts', 'last_error', 'executed_at', 'result']) expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    expect(sql).toContain("'SUCCEEDED'");
    expect(sql).toContain("'SCALE_CHANGE'");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS audit_checkpoint');
    expect(sql).toContain('audit_checkpoint_range_check');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS audit_checkpoint_created_idx');
  });
});
