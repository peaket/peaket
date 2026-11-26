// 홈 피드 읽기 표의 마이그레이션(HOT-305, MIG-01, 2026-11-26).
// 같은 갈래 F-10-2가 core-svc 0050_image_job.sql을 계획·시험까지 잡았으므로 F-10-1은 0051을 쓴다.
// 파일·저널만 보지 않고 SQL의 표별 칸·색인 칸·GRANT 역할(TO core_app만)까지 본다(TR-09·TR-18).
// 기준 트리에서는 0051 파일이 없어 실패한다.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const journal = JSON.parse(readFileSync(`${dir}meta/_journal.json`, 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
const file = `${dir}0051_home_layout_read.sql`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('홈 피드 마이그레이션 0051', () => {
  test('HOT-305 F-10-2의 0050을 비켜 F-10-1 홈 표는 0051이고 저널 idx 51이 0047보다 뒤다', () => {
    expect(existsSync(file)).toBe(true);
    const e47 = journal.entries.find((x) => x.tag === '0047_entry_closed_grant');
    const e51 = journal.entries.find((x) => x.tag === '0051_home_layout_read');
    expect({ idx: e51?.idx, after47: e47 !== undefined && e51 !== undefined && e51.when > e47.when }).toEqual({ idx: 51, after47: true });
  });

  test('HOT-305 0051은 표마다 칸을 만들고, 색인 칸과 core_app SELECT만 준다', () => {
    if (!existsSync(file)) throw new Error('0051_home_layout_read.sql이 없다');
    const sql = readFileSync(file, 'utf8');

    const tableBlock = (table: string): { block: string; columns: string[] } => {
      const m = sql.match(new RegExp(`CREATE TABLE "${esc(table)}" \\(([\\s\\S]*?)\\n\\);`));
      expect(m, `${table} CREATE TABLE 블록`).not.toBeNull();
      const block = m![1]!;
      const columns = [...block.matchAll(/^\s*"([^"]+)"\s+/gm)].map((x) => x[1]!);
      return { block, columns };
    };

    const banner = tableBlock('home_banner');
    expect(banner.columns).toEqual(['id', 'production_id', 'image_key', 'alt_text', 'title', 'subtitle', 'sort_order', 'display_from', 'display_until', 'created_by', 'updated_by', 'updated_at']);
    const theme = tableBlock('home_theme');
    expect(theme.columns).toEqual(['id', 'name', 'sort_order', 'display_from', 'display_until', 'created_by', 'updated_by', 'updated_at']);
    const item = tableBlock('home_theme_item');
    expect(item.columns).toEqual(['theme_id', 'production_id', 'sort_order']);
    // 표별 결합: 다른 표의 칸이 섞이지 않는다.
    expect(theme.columns).not.toContain('image_key');
    expect(item.columns).not.toContain('display_from');

    const indexOf = (name: string, table: string, columns: string[]) => {
      const re = new RegExp(`CREATE INDEX "${esc(name)}"\\s+ON "${esc(table)}"(?:\\s+USING\\s+btree)?\\s*\\(\\s*${columns.map((c) => `"${esc(c)}"`).join('\\s*,\\s*')}\\s*\\)`);
      expect(sql, `${name} 색인`).toMatch(re);
    };
    indexOf('home_banner_display_idx', 'home_banner', ['display_from', 'display_until']);
    indexOf('home_theme_display_idx', 'home_theme', ['display_from', 'display_until']);
    indexOf('home_theme_item_order_idx', 'home_theme_item', ['theme_id', 'sort_order']);

    // 공개 읽기 경로(core_app)에 SELECT만 준다. TO PUBLIC·다른 역할·GRANT ALL·쓰기 권한은 없다.
    const grant = sql.match(/GRANT SELECT ON ([^;]+) TO (\w+);/i);
    expect(grant, 'GRANT SELECT ... TO core_app').not.toBeNull();
    expect(grant![2]).toBe('core_app');
    for (const table of ['home_banner', 'home_theme', 'home_theme_item']) expect(grant![1]).toContain(`"${table}"`);
    expect(sql).not.toMatch(/GRANT\s+ALL/i);
    expect(sql).not.toMatch(/GRANT\s+SELECT\s*,/i);
    expect(sql).not.toMatch(/TO\s+(PUBLIC|core_partner|core_ops|core_notify|core_maintenance)\b/i);
    expect(sql).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)[^;]*"home_(banner|theme)/i);
    // 홈 구성은 공개 콘텐츠라 행 보안을 걸지 않는다(계획 I-01).
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
  });
});
