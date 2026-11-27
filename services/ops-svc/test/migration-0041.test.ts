// F-04-19 마이그레이션 0041 정적 시험(동결 로컬, LCH-330).
// 소유자 결정(2026-11-27): research_export_denial은 90일 보존하고 전용 ops_research_purger만 지운다.
// 실제 PostgreSQL 실행은 Docker 잠금(lane4-F-08-5) 때문에 미실행이며, 이 시험은 SQL 술어·권한을 고정한다.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const sql = (() => {
  try {
    return readFileSync(new URL('../migrations/0041_research_export_purge.sql', import.meta.url), 'utf8');
  } catch {
    return '';
  }
})();

describe('F-04-19 마이그레이션 0041 research_export_denial 90일 purge', () => {
  test('90일 보존·전용 purge 역할·함수·ops_app DELETE 금지를 만든다', () => {
    expect(sql).not.toBe('');
    expect(sql).toContain('CREATE ROLE ops_research_purger NOLOGIN NOSUPERUSER NOBYPASSRLS');
    expect(sql).toContain('REVOKE DELETE ON research_export_denial FROM ops_app');
    expect(sql).toContain('REVOKE DELETE ON research_export_denial FROM ops_research_purger');
    expect(sql).toContain('GRANT USAGE ON SCHEMA public TO ops_research_purger');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION research_export_denial_purge()');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain('REVOKE ALL ON FUNCTION research_export_denial_purge() FROM PUBLIC');
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION research_export_denial_purge() FROM ops_app');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION research_export_denial_purge() TO ops_research_purger');
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*research_export_denial/);
  });

  test('89일은 남기고 91일은 지우는 경계를 SQL 술어로 고정한다', () => {
    expect(sql).toContain('DELETE FROM research_export_denial');
    expect(sql).toContain("WHERE at < now() - interval '90 days'");
    expect(sql).not.toContain('at <= now()');
    expect(sql).not.toContain("interval '89 days'");
    expect(sql).not.toContain("interval '91 days'");

    // 술어의 뜻: 나이가 90일보다 크면 지우고, 90일 이하(89·90일)는 남긴다.
    const purgeable = (ageDays: number): boolean => ageDays > 90;
    expect(purgeable(89)).toBe(false);
    expect(purgeable(90)).toBe(false);
    expect(purgeable(91)).toBe(true);
  });

  test('감사·가명처리·연구 내보내기 메타데이터는 이 정리에서 지우지 않는다', () => {
    expect(sql).not.toContain('DELETE FROM research_export ');
    expect(sql).not.toContain('DELETE FROM pseudonymization_log');
    expect(sql).not.toContain('DELETE FROM audit_chain');
    expect(sql).toContain('research_export_denial');
    expect(sql).toContain('COMMENT ON TABLE research_export_denial');
  });
});
