// COV2-06 보충(W7-audit): 운영 역할의 후기 표·보류 표 권한 마이그레이션 0022의 SQL 원문을 본다.
// 정본: docs/data.md §2 '후기 표의 DB 권한'·§4의 15 'DB 권한', 계획 docs/review/plans/W7-audit.md §4 보충 0022 표(ADR-0241 결정 4: 코드가 쓰는 만큼만).
// GRANT 문을 (역할, 표, 권한, 칸) 묶음으로 풀어 정본 표와 정확히 같은지 견준다(줄 나눔·순서·따옴표가 달라도 같은 뜻이면 통과한다).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** 괄호 밖의 쉼표로 나눈다 */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const bare = (name: string): string => name.replace(/"/g, '').replace(/^public\./i, '').trim().toLowerCase();

/** GRANT 문을 '역할 표 권한 [칸,칸]' 글로 푼다(칸은 정렬). 표 전체 권한은 칸 없이 적는다 */
function grantsOf(sql: string): { grants: string[]; others: string[] } {
  const noComments = sql.replace(/--[^\n]*/g, '');
  const grants: string[] = [];
  const others: string[] = [];
  for (const raw of noComments.split(';')) {
    const st = raw.replace(/\s+/g, ' ').trim();
    if (!st) continue;
    const m = /^GRANT (.+?) ON (?:TABLE )?(.+?) TO (.+)$/i.exec(st);
    if (!m) {
      others.push(st);
      continue;
    }
    const [, privs, tables, roles] = m as unknown as [string, string, string, string];
    for (const role of roles.split(',').map(bare)) {
      for (const table of tables.split(',').map(bare)) {
        for (const p of splitTop(privs)) {
          const pm = /^(\w+)(?: ?\((.+)\))?$/.exec(p.trim());
          if (!pm) {
            others.push(st);
            continue;
          }
          const priv = pm[1]!.toUpperCase();
          const cols = pm[2] ? pm[2].split(',').map(bare).sort() : undefined;
          grants.push(cols ? `${role} ${table} ${priv} [${cols.join(',')}]` : `${role} ${table} ${priv}`);
        }
      }
    }
  }
  return { grants: grants.sort(), others };
}

const cols = (...c: string[]): string => `[${[...c].sort().join(',')}]`;

/** 정본 표(docs/data.md §2 '후기 표의 DB 권한')를 시험이 따로 적은 것. 운영 코드·마이그레이션에서 가져오지 않는다 */
const EXPECTED = [
  'core_app review SELECT',
  'core_app review INSERT',
  `core_app review UPDATE ${cols('rating', 'body', 'status', 'notice', 'notice_until', 'content_fingerprint', 'author_display', 'edited', 'updated_at', 'deleted_at', 'account_id', 'basis_order_id')}`,
  'core_app content_report SELECT',
  'core_app content_report INSERT',
  `core_app content_report UPDATE ${cols('status', 'outcome', 'resolved_at')}`,
  'core_app takedown_action SELECT',
  'core_app takedown_action INSERT',
  `core_app takedown_action UPDATE ${cols('restored_at')}`,
  'core_app review_hidden_fingerprint SELECT',
  'core_app review_hidden_fingerprint INSERT',
  'core_app review_hidden_fingerprint DELETE',
  'core_app held_event SELECT',
  'core_app held_event INSERT',
  `core_maintenance review SELECT ${cols('id', 'status', 'notice', 'notice_until')}`,
  `core_maintenance review UPDATE ${cols('status', 'notice', 'notice_until', 'updated_at')}`,
  `core_maintenance takedown_action SELECT ${cols('reason', 'restored_at', 'ends_at')}`,
  `core_maintenance takedown_action UPDATE ${cols('restored_at')}`,
  `core_maintenance held_event SELECT ${cols('reprocessed_at')}`,
  'core_maintenance held_event DELETE',
].sort();

/** 정본(docs/data.md §5.1, 계획 §7 K2)의 색인 문장. GRANT 풀이와 같이 공백을 하나로 줄인 글이다 */
const ACCOUNT_INDEX = 'CREATE INDEX "review_account_idx" ON "review" USING btree ("account_id")';

describe('COV2-06 보충 운영 역할 권한 마이그레이션', () => {
  test('COV2-06 ⑬ 0022는 후기 표와 보류 표에 코드가 쓰는 칸·동작만 준다', () => {
    const sql = read('migrations/0022_review_role_grants.sql');
    const { grants, others } = grantsOf(sql);
    expect(grants).toEqual(EXPECTED);
    // 권한을 더하기만 한다: 표·칸·스키마를 바꾸지 않고, 정본 0022 표에 없는 REVOKE로 권한을 거두지도 않는다(리뷰 R6)
    expect(others.filter((s) => /^REVOKE /i.test(s))).toEqual([]);
    // GRANT 밖의 문은 탈퇴 익명화 색인 하나뿐이다(웨이브 끝 리뷰 K2, 아래 'COV2-06 K2' 시험이 그 글을 본다)
    expect(others.filter((s) => s !== ACCOUNT_INDEX)).toEqual([]);

    // 거부 쪽을 따로 한 번 더: 후기·신고·조치 표에 지우기·비우기·칸 없는 고치기가 없고, 후기의 id·event_id·created_at은 고치지 못한다
    for (const t of ['review', 'content_report', 'takedown_action']) {
      for (const g of grants.filter((x) => x.split(' ')[1] === t)) {
        expect(g, g).not.toMatch(/ (DELETE|TRUNCATE|ALL)\b/);
        if (/ UPDATE/.test(g)) expect(g, g).toMatch(/ UPDATE \[/);
      }
    }
    const reviewUpdate = grants.find((g) => g.startsWith('core_app review UPDATE'));
    expect(reviewUpdate).toBeDefined();
    for (const c of ['id', 'event_id', 'created_at']) expect(reviewUpdate!.slice(reviewUpdate!.indexOf('[') + 1, -1).split(','), c).not.toContain(c);
    expect(grants.filter((g) => g.startsWith('core_app held_event '))).toEqual(['core_app held_event INSERT', 'core_app held_event SELECT']);

    const journal = JSON.parse(read('migrations/meta/_journal.json')) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((e) => e.idx === 22)?.tag).toBe('0022_review_role_grants');
  });

  test('COV2-06 K2 0022는 review(account_id) 색인을 만든다', () => {
    // 탈퇴 익명화(update review … where account_id = …)가 표 전체를 훑지 않게(docs/data.md §5.1 '탈퇴 익명화' 행·§2 '후기 표의 DB 권한')
    const { others } = grantsOf(read('migrations/0022_review_role_grants.sql'));
    expect(others).toContain(ACCOUNT_INDEX);
  });
});
