// I-T83 ⑦(W8-audit2a, 소유자 결정 2026-11-16 OPEN[42]·[44], ADR-0278): core-svc 마이그레이션 0026(감독 배정)의 SQL 원문을 본다.
// 정본: docs/data.md §2 '후기 파기'(마이그레이션 나눔)·'다시 정리 예약'·'후기 표의 DB 권한', 계획 docs/review/plans/W8-audit2a.md §1·§2 '마이그레이션'.
// 이번 출시는 넓히기만 한다: 별점·지문의 NOT NULL을 풀고, 살아 있는 행 CHECK를 NOT VALID로 더하며, 예약 표와 core_app 권한을 만든다.
// 파기 행 CHECK와 VALIDATE는 다음 출시 몫이라 없어야 한다(docs/devops.md §7.1 원칙 2·3). 실제 거절은 test-int/review-purge.int.test.ts·review-recheck.int.test.ts가 본다.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = join(ROOT, 'migrations');

/** 0026 파일 이름(하나뿐이어야 한다). 없으면 undefined */
function migrationFile(): string | undefined {
  const files = readdirSync(MIGRATIONS).filter((f) => /^0026_.*\.sql$/.test(f));
  expect(files.length, `0026_*.sql 파일 수: ${files.join(', ')}`).toBeLessThanOrEqual(1);
  return files[0];
}

/** 작은따옴표 글자 밖만 소문자로 바꾼다(값 'DELETED'는 그대로 둔다) */
function lowerOutsideLiterals(s: string): string {
  return s
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 === 1 ? part : part.toLowerCase()))
    .join('');
}

/** 문 하나를 견줄 꼴로: 주석·큰따옴표·'public.'을 지우고 공백을 하나로, 따옴표 밖은 소문자 */
const norm = (st: string): string => lowerOutsideLiterals(st.replace(/"/g, '').replace(/\bpublic\./gi, '').replace(/\s+/g, ' ').trim());

/** 문들(주석과 statement-breakpoint를 지우고 ;로 나눈다) */
function statementsOf(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map(norm)
    .filter(Boolean);
}

/** CHECK 식을 괄호·공백·표 이름 접두 없이 견줄 꼴로(괄호 위치의 뜻은 통합 시험이 본다) */
const checkBody = (s: string): string => s.replace(/\breview\./g, '').replace(/[()\s]/g, '');

const bare = (name: string): string => name.replace(/"/g, '').replace(/^public\./i, '').trim().toLowerCase();

/** GRANT 문을 '역할 표 권한 [칸,칸]' 글로 푼다(review-grants.test.ts와 같은 방식) */
function grantsOf(statements: string[]): string[] {
  const out: string[] = [];
  for (const st of statements) {
    const m = /^grant (.+?) on (?:table )?(.+?) to (.+)$/i.exec(st);
    if (!m) continue;
    const [, privs, tables, roles] = m as unknown as [string, string, string, string];
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of privs) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    for (const role of roles.split(',').map(bare)) {
      for (const table of tables.split(',').map(bare)) {
        for (const p of parts) {
          const pm = /^(\w+)(?: ?\((.+)\))?$/.exec(p.trim());
          const priv = (pm?.[1] ?? p).toUpperCase();
          const cols = pm?.[2] ? pm[2].split(',').map(bare).sort() : undefined;
          out.push(cols ? `${role} ${table} ${priv} [${cols.join(',')}]` : `${role} ${table} ${priv}`);
        }
      }
    }
  }
  return out.sort();
}

describe('I-T83 마이그레이션 0026', () => {
  test('I-T83 ⑦ 마이그레이션은 별점·지문 NULL을 허용하고 살아 있는 행 CHECK를 NOT VALID로 더하며 권한을 넓히지 않는다', () => {
    const file = migrationFile();
    expect(file, 'migrations/0026_*.sql').toBeDefined();
    const statements = statementsOf(readFileSync(join(MIGRATIONS, file!), 'utf8'));

    // 별점·지문의 NOT NULL을 푼다(넓히기)
    expect(statements).toContain('alter table review alter column rating drop not null');
    expect(statements).toContain('alter table review alter column content_fingerprint drop not null');

    // 살아 있는 행 CHECK: status = 'DELETED' OR (rating IS NOT NULL AND content_fingerprint IS NOT NULL), NOT VALID
    const live = statements.filter((s) => s.startsWith('alter table review add constraint review_live_complete_check '));
    expect(live, '살아 있는 행 CHECK 문').toHaveLength(1);
    const m = /^alter table review add constraint review_live_complete_check check (.+) not valid$/.exec(live[0]!);
    expect(m, `${live[0]} (NOT VALID로 끝나야 한다)`).not.toBeNull();
    expect(checkBody(m![1]!)).toBe(checkBody("status = 'DELETED' or (rating is not null and content_fingerprint is not null)"));

    // 다음 출시 몫은 없다: 파기 행 CHECK, VALIDATE CONSTRAINT, 그 밖의 CHECK
    expect(statements.filter((s) => /\bvalidate constraint\b/.test(s))).toEqual([]);
    expect(statements.filter((s) => /\bcheck\b/.test(s) && !s.startsWith('alter table review add constraint review_live_complete_check '))).toEqual([]);
    // review에는 새 GRANT·REVOKE가 없다(0022의 칸 목록이 파기 칸을 모두 덮는다)
    expect(statements.filter((s) => /^(grant|revoke)\b/.test(s) && / on (table )?review( |$|,)/.test(s))).toEqual([]);
    expect(statements.filter((s) => /^revoke\b/.test(s))).toEqual([]);

    // 그 밖의 문은 예약 표·색인·권한뿐이다
    const known = (s: string): boolean =>
      s === 'alter table review alter column rating drop not null' ||
      s === 'alter table review alter column content_fingerprint drop not null' ||
      s.startsWith('alter table review add constraint review_live_complete_check ') ||
      s.startsWith('create table review_withdrawal_recheck ') ||
      s.startsWith('create index review_withdrawal_recheck_due_idx ') ||
      s.startsWith('grant ');
    expect(statements.filter((s) => !known(s))).toEqual([]);

    // journal 항목의 tag가 파일 이름과 같다(마이그레이터가 이 파일을 찾는다)
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    const tag = file!.replace(/\.sql$/, '');
    expect(journal.entries.filter((e) => e.tag === tag), `journal의 ${tag}`).toHaveLength(1);
  });

  test('I-T83 ⑦ 예약 표 권한은 core_app의 읽기·넣기·지우기·예약 시각 고치기뿐이다', () => {
    const file = migrationFile();
    expect(file, 'migrations/0026_*.sql').toBeDefined();
    const statements = statementsOf(readFileSync(join(MIGRATIONS, file!), 'utf8'));

    // 예약 표: 계정 ID(기본 키)·예약 시각·만든 시각만(pid·후기 내용 없음)
    const create = statements.filter((s) => s.startsWith('create table review_withdrawal_recheck '));
    expect(create, '예약 표 CREATE TABLE').toHaveLength(1);
    const body = create[0]!.slice(create[0]!.indexOf('(') + 1, create[0]!.lastIndexOf(')'));
    const columns = body.split(',').map((c) => c.trim().replace(/timestamp with time zone/g, 'timestamptz'));
    expect(columns.map((c) => c.split(' ')[0]).sort()).toEqual(['account_id', 'created_at', 'due_at']);
    expect(columns.find((c) => c.startsWith('account_id '))).toMatch(/^account_id uuid primary key( not null)?$/);
    expect(columns.find((c) => c.startsWith('due_at '))).toBe('due_at timestamptz not null');
    expect(columns.find((c) => c.startsWith('created_at '))).toBe('created_at timestamptz not null');
    // 예약 시각 색인
    expect(statements.filter((s) => s.startsWith('create index review_withdrawal_recheck_due_idx '))).toEqual([
      expect.stringMatching(/^create index review_withdrawal_recheck_due_idx on review_withdrawal_recheck (using btree )?\(due_at\)$/),
    ]);

    // 권한: core_app에 읽기·넣기·지우기와 due_at 고치기만. core_partner·core_maintenance·core_ops에는 주지 않는다
    expect(grantsOf(statements)).toEqual(
      [
        'core_app review_withdrawal_recheck SELECT',
        'core_app review_withdrawal_recheck INSERT',
        'core_app review_withdrawal_recheck DELETE',
        'core_app review_withdrawal_recheck UPDATE [due_at]',
      ].sort(),
    );
    for (const role of ['core_partner', 'core_maintenance', 'core_ops']) expect(statements.filter((s) => s.startsWith('grant ') && s.includes(role)), role).toEqual([]);
  });
});
