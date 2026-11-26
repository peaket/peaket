// MIG-01: F-07-11의 core-svc 마이그레이션은 0053이다(F-07-10 0052 다음, F-10-2 0050·F-10-1 0051을 쓰지 않는다).
// 0053은 새 표 없이 신고 보관 정리 색인(content_report.purge_at)과 통보 지문 조회 색인(takedown_action.notice_id, content_fingerprint)을 더하고,
// core_maintenance에 content_report 행 지우기 권한을 준다. 저널 idx 53의 when은 0052보다 커야 한다.
// 기준 트리에는 0053 파일이 없어 이 시험이 실패한다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const sqlFiles = () => readdirSync(dir).filter((f) => f.endsWith('.sql'));
const journal = () => JSON.parse(readFileSync(`${dir}meta/_journal.json`, 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
const sqlOf = (f: string) => readFileSync(`${dir}${f}`, 'utf8');
const lower = (s: string) => s.toLowerCase();
const flatSql = (s: string) => lower(s).replace(/"/g, '').replace(/\b(content_report|takedown_action)\./g, '');

/** 괄호 밖의 쉼표로 나눈다 */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const bare = (name: string): string => name.replace(/"/g, '').replace(/^public\./i, '').split('.').pop()!.trim().toLowerCase();

/** GRANT 문을 '역할 표 권한 [칸,칸]' 글로 푼다(칸은 정렬). 표 전체 권한은 칸 없이 적는다 */
function grantsOf(sql: string): string[] {
  const noComments = sql.replace(/--[^\n]*/g, '');
  const grants: string[] = [];
  for (const raw of noComments.split(';')) {
    const st = raw.replace(/\s+/g, ' ').trim();
    if (!st) continue;
    const m = /^GRANT (.+?) ON (?:TABLE )?(.+?) TO (.+)$/i.exec(st);
    if (!m) continue;
    const [, privs, tables, roles] = m as unknown as [string, string, string, string];
    for (const role of roles.split(',').map(bare)) {
      for (const table of tables.split(',').map(bare)) {
        for (const p of splitTop(privs)) {
          const pm = /^(\w+)(?: ?\((.+)\))?$/.exec(p.trim());
          if (!pm) continue;
          const cols = pm[2] ? pm[2].split(',').map(bare).sort() : undefined;
          grants.push(cols ? `${role} ${table} ${pm[1]!.toUpperCase()} [${cols.join(',')}]` : `${role} ${table} ${pm[1]!.toUpperCase()}`);
        }
      }
    }
  }
  return grants.sort();
}

describe('F-07-11 마이그레이션 번호와 색인', () => {
  test('MIG-01 core-svc 통보·보관 정리는 0053_compliance_notice.sql 하나이고 0050·0051을 쓰지 않는다', () => {
    const files = sqlFiles();
    expect(files).toContain('0053_compliance_notice.sql');
    expect(files.filter((f) => f.startsWith('0050_') || f.startsWith('0051_'))).toEqual([]);
    if (!existsSync(`${dir}0053_compliance_notice.sql`)) return;

    const sql = flatSql(sqlOf('0053_compliance_notice.sql'));
    // 새 표를 만들지 않는다(색인·권한만)
    expect(sql).not.toContain('create table');
    expect(sql).toMatch(/index[^;]*on content_report[^;]*\(purge_at\)/);
    expect(sql).toMatch(/index[^;]*on takedown_action[^;]*\(notice_id\s*,\s*content_fingerprint\)/);
    expect(sql).toMatch(/grant[^;]*delete[^;]*on content_report[^;]*to core_maintenance/);
    expect(existsSync(`${dir}meta/0053_snapshot.json`)).toBe(true);
    const snapshot = readFileSync(`${dir}meta/0053_snapshot.json`, 'utf8');
    // 색인 이름은 정본이 정하지 않는다. 표·칸만 본다
    expect(snapshot).toContain('"content_report"');
    expect(snapshot).toContain('"purge_at"');
    expect(snapshot).toContain('"takedown_action"');
    expect(snapshot).toContain('"content_fingerprint"');

    const e = journal().entries;
    const e52 = e.find((x) => x.tag === '0052_review_image');
    const e53 = e.find((x) => x.tag === '0053_compliance_notice');
    expect({ idx: e53?.idx, later: e53 !== undefined && e52 !== undefined && e53.when > e52.when }).toEqual({ idx: 53, later: true });
  });

  test('MIG-01 권한은 core_maintenance의 content_report SELECT·DELETE뿐이고, 다른 마이그레이션은 같은 색인을 만들지 않는다', () => {
    expect(sqlFiles()).toContain('0053_compliance_notice.sql');
    if (!existsSync(`${dir}0053_compliance_notice.sql`)) return;
    for (const f of sqlFiles().filter((f) => f !== '0053_compliance_notice.sql')) {
      const sql = flatSql(sqlOf(f));
      expect({ file: f, purgeIdx: /index[^;]*on content_report[^;]*\(purge_at\)/.test(sql) }).toEqual({ file: f, purgeIdx: false });
    }
    const grants = grantsOf(flatSql(sqlOf('0053_compliance_notice.sql')));
    // DELETE는 WHERE(status, purge_at)를 읽으므로 SELECT가 함께 있어야 PostgreSQL이 허용한다.
    // data.md는 칸 한정 SELECT("purge_at","status")만 정한다: 표 전체 SELECT·다른 칸·UPDATE/INSERT는 실패다.
    expect(grants).toContain('core_maintenance content_report DELETE');
    expect(grants).toContain('core_maintenance content_report SELECT [purge_at,status]');
    expect(grants).not.toContain('core_maintenance content_report SELECT');
    expect(grants.some((g) => g.startsWith('core_maintenance content_report SELECT [') && g !== 'core_maintenance content_report SELECT [purge_at,status]')).toBe(false);
    expect(grants.some((g) => /^core_maintenance content_report (INSERT|UPDATE)( |$)/.test(g))).toBe(false);
    // 행 지우기는 정비 역할에만 주고, 팬 경로에는 주지 않는다
    expect(grants.some((g) => g.startsWith('core_app '))).toBe(false);
  });
});
