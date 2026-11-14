// 0003 마이그레이션이 운영 경보 표와 회차 취소 환불 수동 명령 유형을 더하는지 파일로 확인한다(Docker test-int는 heavy gate).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const sql = readFileSync(new URL('../migrations/0003_ops_alert_and_refund_commands.sql', import.meta.url), 'utf8');

describe('0003 ops 마이그레이션', () => {
  test('GAT130_운영_경보_표와_회차_취소_환불_수동_명령을_더한다', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS ops_alert');
    expect(sql).toContain('ops_alert_event_kind_key');
    expect(sql).toContain("'SEV1', 'SEV2', 'SEV3'");
    expect(sql).toContain("'EVENT_REFUND_PAUSE'");
    expect(sql).toContain("'EVENT_REFUND_RESUME'");
  });
});
