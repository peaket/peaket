// I-T83 ⑦(W8-audit2a, 소유자 결정 2026-11-16 OPEN[42]·[44], ADR-0278): core-svc 마이그레이션 0026(감독 배정)의 SQL 원문을 본다.
// 정본: docs/data.md §2 '후기 파기'(마이그레이션 나눔)·'다시 정리 예약'·'후기 표의 DB 권한', 계획 docs/review/plans/W8-audit2a.md §1·§2 '마이그레이션'.
// 이번 출시는 넓히기만 한다: 별점·지문의 NOT NULL을 풀고, 살아 있는 행 CHECK를 NOT VALID로 더하며, 예약 표와 core_app 권한을 만든다.
// 파기 행 CHECK와 VALIDATE는 다음 출시 몫이라 없어야 한다(docs/devops.md §7.1 원칙 2·3). 실제 거절은 test-int/review-purge.int.test.ts·review-recheck.int.test.ts가 본다.
// 리뷰 A2(계획 §8.2): 0026은 정비 일 review-purge-legacy를 위해 core_maintenance에 review의 칸 권한 두 줄만 더한다. 본문(body) 읽기는 주지 않는다
// (docs/data.md §2 '후기 표의 DB 권한'). core_app의 review 권한은 바꾸지 않는다(0022의 칸 목록이 파기 칸을 모두 덮는다).
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
    // review의 새 GRANT는 정비 역할 것뿐이다(core_app은 0022의 칸 목록이 파기 칸을 모두 덮는다. 정비 역할 칸은 아래 '⑦⑧' 시험)
    const reviewGrants = grantsOf(statements.filter((s) => /^grant\b/.test(s) && / on (table )?review( |$|,)/.test(s)));
    expect(reviewGrants.filter((g) => !g.startsWith('core_maintenance review ')), '정비 역할 밖의 review GRANT').toEqual([]);
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
    const recheckStatements = statements.filter((s) => /^(grant|revoke)\b/.test(s) && s.includes('review_withdrawal_recheck'));
    expect(grantsOf(recheckStatements)).toEqual(
      [
        'core_app review_withdrawal_recheck SELECT',
        'core_app review_withdrawal_recheck INSERT',
        'core_app review_withdrawal_recheck DELETE',
        'core_app review_withdrawal_recheck UPDATE [due_at]',
      ].sort(),
    );
    for (const role of ['core_partner', 'core_maintenance', 'core_ops']) expect(recheckStatements.filter((s) => s.includes(role)), role).toEqual([]);
  });

  test('I-T83 ⑦⑧ 0026은 정비 역할에 본문 읽기를 주지 않는다', () => {
    // 리뷰 A2: 정비 일 review-purge-legacy(이전 판이 남긴 행 고치기)가 찾고(읽기) 파기 칸으로 고치는(고치기) 칸만 더한다.
    // 0022가 준 id·status·notice·notice_until 읽기와 status·notice·notice_until·updated_at 고치기는 그대로다(그것은 0022 시험이 본다)
    const file = migrationFile();
    expect(file, 'migrations/0026_*.sql').toBeDefined();
    const statements = statementsOf(readFileSync(join(MIGRATIONS, file!), 'utf8'));
    const maint = grantsOf(statements.filter((s) => /^grant\b/.test(s) && s.includes('core_maintenance')));
    const cols = (...c: string[]): string => `[${[...c].sort().join(',')}]`;
    expect(maint).toEqual(
      [
        `core_maintenance review SELECT ${cols('rating', 'content_fingerprint', 'account_id', 'deleted_at')}`,
        `core_maintenance review UPDATE ${cols('body', 'rating', 'content_fingerprint', 'author_display', 'account_id', 'basis_order_id', 'deleted_at')}`,
      ].sort(),
    );
    // 거부 쪽을 따로: 본문 읽기, 표 전체 읽기·고치기, 넣기·지우기·비우기가 없다
    for (const g of maint) {
      expect(g, g).not.toMatch(/ (INSERT|DELETE|TRUNCATE|ALL)\b/);
      expect(g, g).toMatch(/ (SELECT|UPDATE) \[/);
      if (/ SELECT /.test(g)) expect(g.slice(g.indexOf('[') + 1, -1).split(','), g).not.toContain('body');
    }
    // 정비 역할의 다른 표 권한·REVOKE도 없다
    expect(statements.filter((s) => s.includes('core_maintenance') && !(/^grant\b/.test(s) && / on (table )?review( |$|,)/.test(s)))).toEqual([]);
  });

  test('I-T83 ⑦⑨ 0026은 core_app에 held_event의 reprocessed_at 고치기만 더 준다', () => {
    // 웨이브 끝 보안 리뷰 S1(계획 §9.1): 손으로 하는 파기가 보류된 탈퇴 사건을 다시 처리로 표시한다. core_app의 held_event 읽기·넣기는 0022 그대로다
    const file = migrationFile();
    expect(file, 'migrations/0026_*.sql').toBeDefined();
    const statements = statementsOf(readFileSync(join(MIGRATIONS, file!), 'utf8'));
    const held = statements.filter((s) => /^(grant|revoke)\b/.test(s) && / on (table )?held_event( |$|,)/.test(s));
    expect(grantsOf(held)).toEqual(['core_app held_event UPDATE [reprocessed_at]']);
    // 거부 쪽을 따로: 지우기·다른 칸·표 전체 고치기, 다른 역할, REVOKE가 없다
    for (const st of held) {
      expect(st, st).toMatch(/^grant /);
      expect(st, st).not.toMatch(/\b(delete|truncate|all|insert|select)\b/);
      for (const role of ['core_partner', 'core_maintenance', 'core_ops']) expect(st, st).not.toContain(role);
    }
  });
});
