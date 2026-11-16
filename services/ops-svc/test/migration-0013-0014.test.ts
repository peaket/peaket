// 0013·0014 마이그레이션 파일(BAT-420 GAT-110 P3, data.md ops ERD event_cancellation_request·서비스마다 둔 멱등 기록 표).
// 파일에 칸·작업 이름이 있는지만 가볍게 본다. 제약이 실제로 거절하는지는 통합 시험(test-int/event-cancellations.int.test.ts의 P3)이
// PostgreSQL 18로 본다. 손으로 쓴 SQL과 drizzle-kit이 만든 SQL(큰따옴표 이름) 둘 다 받도록 따옴표를 지우고 본다. 시험 담당이 구현 전에 썼다.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const dir = new URL('../migrations/', import.meta.url);
/** 번호로 시작하는 마이그레이션 파일의 글(큰따옴표를 지움). 없으면 빈 글(시험이 단언에서 실패하게) */
const migration = (prefix: string): string => {
  const name = readdirSync(dir).find((n) => n.startsWith(`${prefix}_`) && n.endsWith('.sql'));
  return name ? readFileSync(new URL(name, dir), 'utf8').replaceAll('"', '') : '';
};

describe('0013·0014 ops 마이그레이션 파일 [BAT-420 GAT-110 P3]', () => {
  test('GAT-110 P3 0013은 event_cancellation_request에 요청 경로·테넌트·귀책 의견·증빙·연기 일시·미리보기·반려 사유 칸을 더한다', () => {
    const sql = migration('0013');
    expect(sql).not.toBe('');
    expect(sql).toContain('event_cancellation_request');
    for (const column of ['requested_via', 'promoter_id', 'fault_opinion', 'evidence_ref', 'new_starts_at', 'dry_run', 'rejection_reason']) {
      expect(sql, column).toContain(column);
    }
    expect(sql).toMatch(/dry_run\s+jsonb/i);
    expect(sql).toMatch(/new_starts_at\s+(timestamptz|timestamp with time zone)/i);
    expect(sql).toMatch(/DEFAULT\s+'COMMANDER'/i);
    expect(sql).toContain("'PARTNER'");
  });

  test('GAT-110 P3 0014는 멱등 기록 표를 두 작업 이름으로 묶어 만든다', () => {
    const sql = migration('0014');
    expect(sql).not.toBe('');
    expect(sql).toContain('idempotency_record');
    for (const column of ['account_ref', 'operation', 'idempotency_key', 'request_hash', 'result_ref', 'created_at']) {
      expect(sql, column).toContain(column);
    }
    expect(sql).toContain("'CREATE_EVENT_CANCELLATION'");
    expect(sql).toContain("'CREATE_PARTNER_EVENT_CANCELLATION'");
  });
});
