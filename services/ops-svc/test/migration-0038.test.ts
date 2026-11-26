// F-04-14 마이그레이션 0038 정적 시험(동결 로컬, LCH-290·LCH-300, FX-T13·FX-T20).
// 정본: docs/data.md evidence_bundle·evidence_custody_log·external_post·evidence_export, docs/features/forensic-replay.md §6.7.6.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const sql = (() => {
  try {
    return readFileSync(new URL('../migrations/0038_fraud_evidence.sql', import.meta.url), 'utf8');
  } catch {
    return '';
  }
})();

describe('F-04-14 마이그레이션 0038', () => {
  test('FX-T13 ⑨ [ASVS v5.0.0-16.4.2] 마이그레이션 0038은 증거 표 넷·덧붙이기 트리거·권한·멱등 작업 이름을 만든다', () => {
    expect(sql).not.toBe('');
    for (const table of ['evidence_bundle', 'evidence_custody_log', 'external_post', 'evidence_export']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const column of ['hold_reason', 'hold_end_requested_by', 'hold_end_requested_at', 'hold_end_basis', 'hold_end_confirmed_by', 'hold_ended_at', 'manifest_sha256', 's3_prefix']) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain('evidence_custody_log_no_update');
    expect(sql).toContain('BEFORE UPDATE OR DELETE');
    expect(sql).toContain('prev_hash');
    expect(sql).toContain('row_hash');
    expect(sql).toMatch(/hold_reason IN \('OBJECTION', 'DISPUTE', 'INVESTIGATION'\)/);
    expect(sql).toMatch(/status IN \('BUILDING', 'SEALED', 'DISPOSED'\)/);
    expect(sql).toMatch(/scan_status IN \('PENDING', 'CLEAN', 'THREAT'\)/);
    expect(sql).toMatch(/source IN \('REPORT', 'MANUAL'\)/);
    expect(sql).toMatch(/kind IN \('AUTHORITY', 'PROMOTER', 'COMPLAINT'\)/);
    expect(sql).toContain('CREATE_EXTERNAL_POST');
    expect(sql).toContain('CREATE_EVIDENCE_BUNDLE');
    expect(sql).toContain('CREATE_EVIDENCE_EXPORT');
    expect(sql).toContain('GRANT');
    expect(sql).toContain('ops_app');
  });

  test('FX-T20 ⑩ [ASVS v5.0.0-13.2.2] evidence_export의 kind·data_request 조건과 증거 표 권한을 만든다', () => {
    expect(sql).toContain('data_request_id');
    expect(sql).toContain('document_id');
    expect(sql).toContain('sha256');
    expect(sql).toContain('evidence_export_authority_request_check');
    expect(sql).toMatch(/kind <> 'AUTHORITY' OR data_request_id IS NOT NULL|kind = 'AUTHORITY' AND data_request_id IS NOT NULL/);
    expect(sql).toContain('evidence_export_kind_check');
  });
});
