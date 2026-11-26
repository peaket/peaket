// MIG-02: F-07-11의 ops-svc 마이그레이션은 0040이다. 이 가지는 0034까지이고, 다른 동결 가지 최대는 0039다.
// 0040은 takedown_notice(칸은 docs/data.md 2186~2198행)와 takedown_notice_action(조치·철회·멱등 기록)을 만들고,
// status·deadline·action CHECK, (requested_by, idempotency_key)·(notice_id, action, idempotency_key) 유일,
// (status, due_at)·(due_at) 색인을 둔다. 기준 트리에는 0040 파일이 없어 이 시험이 실패한다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const sqlFiles = () => readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f));
const sqlOf = (f: string) => readFileSync(`${dir}${f}`, 'utf8');
const flat = (s: string) => s.toLowerCase().replace(/"/g, '').replace(/\btakedown_notice(_action)?\./g, '');

describe('F-07-11 ops 마이그레이션 번호와 표', () => {
  test('MIG-02 ops-svc 통보 표는 0040_compliance_notice.sql 하나이고 0035~0039를 쓰지 않는다', () => {
    const files = sqlFiles();
    expect(files).toContain('0040_compliance_notice.sql');
    expect(files.filter((f) => /^003[5-9]_/.test(f))).toEqual([]);
    if (!existsSync(`${dir}0040_compliance_notice.sql`)) return;

    const sql = flat(sqlOf('0040_compliance_notice.sql'));
    expect(sql).toContain('create table takedown_notice');
    for (const column of ['id', 'requested_by', 'idempotency_key', 'requester', 'agency_name', 'received_at', 'deadline', 'due_at', 'review_ids', 'summary', 'status', 'taken_down_at', 'withdrawn_at', 'created_at', 'updated_at']) {
      expect({ column, present: new RegExp(`(?:^|[\\s,(])${column}\\s`).test(sql) }).toEqual({ column, present: true });
    }
    expect(sql).toMatch(/status[^;]*in\s*\(\s*'open'\s*,\s*'taken_down'\s*,\s*'withdrawn'\s*\)/);
    expect(sql).toMatch(/deadline[^;]*in\s*\(\s*'h24'\s*,\s*'h10'\s*\)/);
    expect(sql).toMatch(/unique index[^;]*on takedown_notice[^;]*\(requested_by\s*,\s*idempotency_key\)/);
    expect(sql).toMatch(/index[^;]*on takedown_notice[^;]*\(status\s*,\s*due_at\)/);
    expect(sql).toMatch(/index[^;]*on takedown_notice[^;]*\(due_at\)/);

    expect(sql).toContain('create table takedown_notice_action');
    for (const column of ['id', 'notice_id', 'action', 'idempotency_key', 'request_hash', 'reason', 'actor_ref', 'created_at']) {
      expect({ column, present: new RegExp(`(?:^|[\\s,(])${column}\\s`).test(sql) }).toEqual({ column, present: true });
    }
    expect(sql).toMatch(/action[^;]*in\s*\(\s*'takedown'\s*,\s*'withdrawal'\s*\)/);
    expect(sql).toMatch(/unique index[^;]*on takedown_notice_action[^;]*\(notice_id\s*,\s*action\s*,\s*idempotency_key\)/);
    expect(sql).toMatch(/grant[^;]*on takedown_notice[^;]*to ops_app/);
    expect(sql).toMatch(/grant[^;]*on takedown_notice_action[^;]*to ops_app/);
    // 행 지우기는 주지 않는다
    expect(sql).not.toMatch(/grant[^;]*delete[^;]*on takedown_notice/);
  });

  test('MIG-02 다른 마이그레이션은 통보 표를 만들지 않는다', () => {
    expect(sqlFiles()).toContain('0040_compliance_notice.sql');
    if (!existsSync(`${dir}0040_compliance_notice.sql`)) return;
    for (const f of sqlFiles().filter((f) => f !== '0040_compliance_notice.sql')) {
      const sql = flat(sqlOf(f));
      expect({ file: f, notice: sql.includes('create table takedown_notice'), action: sql.includes('create table takedown_notice_action') }).toEqual({ file: f, notice: false, action: false });
    }
  });
});
