// F-04-12 마이그레이션 0035의 정적 검사(동결 로컬, LCH-260, FX-T12).
// 표·기본 키·검사 제약·권한·멱등 작업 이름·사건 기록 덧붙이기 트리거가 SQL에 있는지 본다.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const sql = readFileSync(new URL('../migrations/0035_fraud_investigation.sql', import.meta.url), 'utf8');

describe('0035 부정 예매 조사 마이그레이션', () => {
  test('FX-T12 ㉒ 마이그레이션 0035는 fraud_* 표와 제약·권한을 만든다', () => {
    for (const table of ['fraud_snapshot', 'fraud_cluster_run', 'fraud_cluster', 'fraud_cluster_member', 'fraud_case', 'fraud_case_event']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    // 판·시도·계정·묶음의 기본 키와 한 묶음 한 사건
    expect(sql).toContain('PRIMARY KEY (event_id, version)');
    expect(sql).toContain('PRIMARY KEY (event_id, generation, attempt)');
    expect(sql).toContain('PRIMARY KEY (cluster_id, account_id)');
    expect(sql).toContain('cluster_id uuid NOT NULL UNIQUE');
    // 상태·종류·점수 범주의 허용 값
    expect(sql).toContain("CHECK (status IN ('RUNNING', 'DONE', 'FAILED'))");
    expect(sql).toContain("CHECK (trigger IN ('SCHEDULED', 'SNAPSHOT', 'AUTO_RETRY', 'MANUAL'))");
    expect(sql).toContain("CHECK (score_band IN ('HIGH', 'MEDIUM', 'LOW'))");
    expect(sql).toContain("CHECK (verify_status IN ('OK', 'MISMATCH'))");
    expect(sql).toContain('verify_status text');
    expect(sql).toContain('verified_at timestamp with time zone');
    // 사건 기록은 덧붙이기만 한다
    expect(sql).toContain('fraud_case_event_append_only');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON fraud_case_event');
    // 멱등 작업 이름
    expect(sql).toContain('CREATE_FRAUD_CASE');
    expect(sql).toContain('CREATE_FRAUD_APPEAL_REQUEST');
    // 로컬·CI 사용자 권한
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON fraud_snapshot, fraud_cluster_run, fraud_cluster, fraud_cluster_member, fraud_case TO ops_app');
    expect(sql).toContain('GRANT SELECT, INSERT ON fraud_case_event TO ops_app');
  });
});
