// MIG-01: F-07-10의 core-svc 마이그레이션 번호는 0052다(감독 조정, 2026-11-26).
// F-10-2가 0050_image_job.sql, F-10-1이 0051부터를 쓴다. 이 기능은 0050·0051을 만들지 않고,
// 0052_review_image.sql 한 파일에 review_image 표·CHECK·부분 유일 색인·색인·권한을 넣으며,
// 저널 idx 52의 when은 0047보다 커야 한다. 정본 권한 표는 docs/data.md §2에 먼저 적는다.
// GRANT는 review-grants.test.ts의 grantsOf처럼 주석을 지우고 따옴표·TABLE·public.을 허용해 '역할 표 권한 [칸]'으로 푼다.
// 기준 트리에는 0052 파일이 없어 이 시험이 실패한다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sqlFiles = () => readdirSync(dir).filter((f) => f.endsWith('.sql'));
const journal = () => JSON.parse(readFileSync(`${dir}meta/_journal.json`, 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
const sqlOf = (f: string) => readFileSync(`${dir}${f}`, 'utf8');
const lower = (s: string) => s.toLowerCase();
/** 따옴표를 지우고 표 접두사(`"review_image".`·`review_image.`)를 떼어 칸 이름만 남긴 SQL. Drizzle은 칸에 표 이름을 붙인다 */
const flatSql = (s: string) => lower(s).replace(/"/g, '').replace(/\breview_image\./g, '');

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

describe('F-07-10 마이그레이션 번호와 표', () => {
  test('MIG-01 core-svc 후기 사진 표는 0052_review_image.sql 하나이고 0050·0051을 쓰지 않는다', () => {
    const files = sqlFiles();
    expect(files).toContain('0052_review_image.sql');
    expect(files.filter((f) => f.startsWith('0050_') || f.startsWith('0051_'))).toEqual([]);
    if (!existsSync(`${dir}0052_review_image.sql`)) return;

    const sql = flatSql(sqlOf('0052_review_image.sql'));
    expect(sql).toContain('create table review_image');
    for (const column of ['review_id', 'account_id', 'status', 'reject_reason', 'alt_text', 'width', 'height', 'sort', 'thumb_key', 'view_key', 'created_at', 'attached_at', 'deleted_at']) {
      expect({ column, present: new RegExp(`(?:^|[\\s,(])${column}\\s`).test(sql) }).toEqual({ column, present: true });
    }
    // CHECK: 상태·거절 사유·설명 100자·순서 0~2·붙임 시각 짝
    expect(sql).toMatch(/status[^;]*in\s*\(\s*'uploaded'\s*,\s*'scanning'\s*,\s*'ready'\s*,\s*'rejected'\s*,\s*'deleted'\s*\)/);
    expect(sql).toMatch(/reject_reason[^;]*in\s*\(\s*'unsupported_type'\s*,\s*'too_large'\s*,\s*'too_small'\s*,\s*'malware'\s*\)/);
    expect(sql).toMatch(/char_length\(alt_text\)\s*<=\s*100|char_length\(alt_text\)\s*between\s*0\s*and\s*100/);
    expect(sql).toMatch(/sort\s+between\s+0\s+and\s+2|sort\s*>=\s*0\s+and\s+sort\s*<=\s*2/);
    expect(sql).toMatch(/review_id is null\)\s*=\s*\(attached_at is null|\(review_id is null\)\s*=\s*\(attached_at is null/);
    // 부분 유일·색인. 지운 행(DELETED)은 빼서 같은 순서로 새 사진을 붙일 수 있게 한다(구현 리뷰 IR-01)
    expect(sql).toMatch(/unique index[^;]*on review_image[^;]*\(review_id\s*,\s*sort\)[^;]*where[^;]*review_id is not null[^;]*status\s*<>\s*'deleted'/);
    expect(sql).toMatch(/index[^;]*on review_image[^;]*\(account_id\s*,\s*created_at\)/);
    expect(sql).toMatch(/index[^;]*on review_image[^;]*\(review_id\)/);
    expect(sql).toMatch(/index[^;]*on review_image[^;]*\(status\s*,\s*created_at\)/);
    // 올리기 시도 표(구현 리뷰 IR-04): 성공 행이 아니라 시도를 세어 시간당 30장을 지킨다
    expect(sql).toContain('create table review_image_upload_attempt');
    for (const column of ['account_id', 'created_at']) {
      expect({ column, present: new RegExp(`(?:^|[\\s,(])${column}\\s`).test(sql) }).toEqual({ column, present: true });
    }
    expect(sql).toMatch(/index[^;]*on review_image_upload_attempt[^;]*\(account_id\s*,\s*created_at\)/);
    expect(existsSync(`${dir}meta/0052_snapshot.json`)).toBe(true);
    const snapshot = readFileSync(`${dir}meta/0052_snapshot.json`, 'utf8');
    expect(snapshot).toContain('"review_image"');
    expect(snapshot).toContain('"review_image_upload_attempt"');

    // 저널 idx 52의 when은 0047보다 크고 파일 번호와 idx가 같다
    const e = journal().entries;
    const e47 = e.find((x) => x.tag === '0047_entry_closed_grant');
    const e52 = e.find((x) => x.tag === '0052_review_image');
    expect({ idx: e52?.idx, later: e52 !== undefined && e47 !== undefined && e52.when > e47.when }).toEqual({ idx: 52, later: true });
  });

  test('MIG-01 권한은 core_app 읽기·넣기·정한 칸 고치기(지우기 없음)와 core_maintenance 읽기·행 지우기뿐이고, 다른 마이그레이션은 review_image를 만들지 않는다', () => {
    expect(sqlFiles()).toContain('0052_review_image.sql');
    if (!existsSync(`${dir}0052_review_image.sql`)) return;
    for (const f of sqlFiles().filter((f) => f !== '0052_review_image.sql')) {
      expect({ file: f, createsReviewImage: flatSql(sqlOf(f)).includes('create table review_image') }).toEqual({ file: f, createsReviewImage: false });
    }

    const sql = flatSql(sqlOf('0052_review_image.sql'));
    const { grants } = grantsOf(sql);
    expect(grants).toEqual(
      [
        'core_app review_image SELECT',
        'core_app review_image INSERT',
        `core_app review_image UPDATE ${cols('review_id', 'alt_text', 'sort', 'attached_at', 'status', 'deleted_at')}`,
        'core_maintenance review_image SELECT',
        `core_maintenance review_image UPDATE ${cols('deleted_at', 'status')}`,
        'core_maintenance review_image DELETE',
        'core_app review_image_upload_attempt SELECT',
        'core_app review_image_upload_attempt INSERT',
        'core_maintenance review_image_upload_attempt SELECT',
        'core_maintenance review_image_upload_attempt DELETE',
      ].sort(),
    );
    // 거부 쪽: core_app의 지우기·자르기·전체 권한, core_maintenance의 넣기·전체 권한, 다른 역할이 없다
    expect(grants.some((g) => g.startsWith('core_app ') && / (DELETE|TRUNCATE|ALL)( |$)/.test(g))).toBe(false);
    expect(grants.some((g) => g.startsWith('core_maintenance ') && / (INSERT|TRUNCATE|ALL)( |$)/.test(g))).toBe(false);
    expect(grants.filter((g) => g.startsWith('core_maintenance ') && g.includes(' review_image ')).every((g) => / (SELECT|DELETE|UPDATE)( |$)/.test(g))).toBe(true);
    expect(grants.every((g) => g.startsWith('core_app ') || g.startsWith('core_maintenance '))).toBe(true);

    // 정본 권한 표(data.md §2)에 review_image·review_image_upload_attempt의 역할·칸 목록이 먼저 있다
    const data = readFileSync(`${root}docs/data.md`, 'utf8');
    const paragraph = /후기 사진 표 `review_image`의 권한[^\n]*/.exec(data)?.[0] ?? '';
    expect(paragraph).toContain('core_app');
    expect(paragraph).toContain('core_maintenance');
    expect(paragraph).toContain('행 지우기');
    expect(paragraph).toContain('고치기');
    expect(paragraph).toContain('`review_id`');
    expect(paragraph).toContain('`alt_text`');
    expect(paragraph).toContain('`sort`');
    expect(paragraph).toContain('`attached_at`');
    expect(paragraph).toContain('`status`');
    expect(paragraph).toContain('`deleted_at`');
    const attempt = /후기 사진 올리기 시도 표 `review_image_upload_attempt`의 권한[^\n]*/.exec(data)?.[0] ?? '';
    expect(attempt).toContain('core_app');
    expect(attempt).toContain('core_maintenance');
    expect(attempt).toContain('행 지우기');
    expect(attempt).toContain('`account_id`');
    expect(attempt).toContain('`created_at`');
  });
});
