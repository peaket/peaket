// MIG-01: F-07-10의 core-svc 마이그레이션 번호는 0052다(감독 조정, 2026-11-26).
// F-10-2가 0050_image_job.sql, F-10-1이 0051부터를 쓴다. 이 기능은 0050·0051을 만들지 않고,
// 0052_review_image.sql 한 파일에 review_image 표·CHECK·부분 유일 색인·색인·권한을 넣으며,
// 저널 idx 52의 when은 0047보다 커야 한다. 정본 권한 표는 docs/data.md §2에 먼저 적는다.
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

describe('F-07-10 마이그레이션 번호와 표', () => {
  test('MIG-01 core-svc 후기 사진 표는 0052_review_image.sql 하나이고 0050·0051을 쓰지 않는다', () => {
    const files = sqlFiles();
    expect(files).toContain('0052_review_image.sql');
    expect(files.filter((f) => f.startsWith('0050_') || f.startsWith('0051_'))).toEqual([]);
    if (!existsSync(`${dir}0052_review_image.sql`)) return;

    const sql = lower(sqlOf('0052_review_image.sql'));
    expect(sql).toContain('create table "review_image"');
    for (const column of ['review_id', 'account_id', 'status', 'reject_reason', 'alt_text', 'width', 'height', 'sort', 'thumb_key', 'view_key', 'created_at', 'attached_at', 'deleted_at']) {
      expect({ column, present: sql.includes(`"${column}"`) }).toEqual({ column, present: true });
    }
    // CHECK: 상태·거절 사유·설명 100자·순서 0~2·붙임 시각 짝
    expect(sql).toMatch(/status[^;]*in\s*\(\s*'uploaded'\s*,\s*'scanning'\s*,\s*'ready'\s*,\s*'rejected'\s*,\s*'deleted'\s*\)/);
    expect(sql).toMatch(/reject_reason[^;]*in\s*\(\s*'unsupported_type'\s*,\s*'too_large'\s*,\s*'too_small'\s*,\s*'malware'\s*\)/);
    expect(sql).toMatch(/char_length\("alt_text"\)\s*<=\s*100|char_length\("alt_text"\)\s*between\s*0\s*and\s*100/);
    expect(sql).toMatch(/"sort"\s+between\s+0\s+and\s+2|"sort"\s*>=\s*0\s+and\s+"sort"\s*<=\s*2/);
    expect(sql).toMatch(/review_id is null\)\s*=\s*\(attached_at is null|\(review_id is null\)\s*=\s*\(attached_at is null/);
    // 부분 유일·색인
    expect(sql).toMatch(/unique index[^;]*on "review_image"[^;]*\("review_id"\s*,\s*"sort"\)[^;]*where[^;]*review_id is not null/);
    expect(sql).toMatch(/index[^;]*on "review_image"[^;]*\("account_id"\s*,\s*"created_at"\)/);
    expect(sql).toMatch(/index[^;]*on "review_image"[^;]*\("review_id"\)/);
    expect(sql).toMatch(/index[^;]*on "review_image"[^;]*\("status"\s*,\s*"created_at"\)/);
    expect(existsSync(`${dir}meta/0052_snapshot.json`)).toBe(true);
    const snapshot = readFileSync(`${dir}meta/0052_snapshot.json`, 'utf8');
    expect(snapshot).toContain('"review_image"');

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
      expect({ file: f, createsReviewImage: lower(sqlOf(f)).includes('create table "review_image"') }).toEqual({ file: f, createsReviewImage: false });
    }

    const sql = lower(sqlOf('0052_review_image.sql'));
    const grants = [...sql.matchAll(/grant\s+([^;]+?)\s+on\s+"review_image"\s+to\s+([^;]+);/g)].map((m) => ({ privileges: m[1]!.trim(), roles: m[2]!.split(',').map((r) => r.trim().replace(/"/g, '')) }));
    const splitTop = (s: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let cur = '';
      for (const ch of s) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
          if (cur.trim()) out.push(cur.trim());
          cur = '';
        } else cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    };
    const parsed = grants.map((g) => ({
      roles: g.roles,
      items: splitTop(g.privileges).map((p) => {
        const update = /^update\s*\((.*)\)$/.exec(p);
        return update ? { kind: 'update', columns: splitTop(update[1]!).map((c) => c.replace(/"/g, '').trim()) } : { kind: p.toLowerCase(), columns: [] as string[] };
      }),
    }));
    const app = parsed.filter((g) => g.roles.includes('core_app'));
    const maintenance = parsed.filter((g) => g.roles.includes('core_maintenance'));
    const appItems = app.flatMap((g) => g.items);
    const appKinds = new Set(appItems.map((i) => i.kind));
    expect([...appKinds].sort()).toEqual(['insert', 'select', 'update']);
    const appUpdateColumns = new Set(appItems.filter((i) => i.kind === 'update').flatMap((i) => i.columns));
    expect([...appUpdateColumns].sort()).toEqual(['alt_text', 'attached_at', 'deleted_at', 'review_id', 'sort', 'status']);
    expect(appItems.some((i) => i.kind === 'delete' || i.kind === 'truncate' || i.kind === 'all')).toBe(false);
    const maintenanceItems = maintenance.flatMap((g) => g.items);
    expect([...new Set(maintenanceItems.map((i) => i.kind))].sort()).toEqual(['delete', 'select']);
    expect(maintenanceItems.every((i) => i.kind === 'select' || i.kind === 'delete')).toBe(true);
    expect(parsed.every((g) => g.roles.every((r) => r === 'core_app' || r === 'core_maintenance'))).toBe(true);

    // 정본 권한 표(data.md §2)에 review_image의 역할·칸 목록이 먼저 있다
    const data = readFileSync(`${root}docs/data.md`, 'utf8');
    const paragraph = /후기 사진 표 `review_image`의 권한[^\n]*/.exec(data)?.[0] ?? '';
    expect(paragraph).toContain('core_app');
    expect(paragraph).toContain('core_maintenance');
    expect(paragraph).toContain('행 지우기');
    expect(paragraph).toContain('`review_id`');
    expect(paragraph).toContain('`alt_text`');
    expect(paragraph).toContain('`sort`');
    expect(paragraph).toContain('`attached_at`');
    expect(paragraph).toContain('`status`');
    expect(paragraph).toContain('`deleted_at`');
  });
});
