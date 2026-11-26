// 홈 피드 읽기 표의 마이그레이션(HOT-305, MIG-01, 2026-11-26).
// 같은 갈래 F-10-2가 core-svc 0050_image_job.sql을 계획·시험까지 잡았으므로 F-10-1은 0051을 쓴다.
// 파일·저널만 보지 않고 SQL의 표·칸·색인·읽기 권한(쓰기 권한 없음)까지 본다(TR-09).
// 기준 트리에서는 0051 파일이 없어 실패한다.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const journal = JSON.parse(readFileSync(`${dir}meta/_journal.json`, 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
const file = `${dir}0051_home_layout_read.sql`;

describe('홈 피드 마이그레이션 0051', () => {
  test('HOT-305 F-10-2의 0050을 비켜 F-10-1 홈 표는 0051이고 저널 idx 51이 0047보다 뒤다', () => {
    expect(existsSync(file)).toBe(true);
    const e47 = journal.entries.find((x) => x.tag === '0047_entry_closed_grant');
    const e51 = journal.entries.find((x) => x.tag === '0051_home_layout_read');
    expect({ idx: e51?.idx, after47: e47 !== undefined && e51 !== undefined && e51.when > e47.when }).toEqual({ idx: 51, after47: true });
  });

  test('HOT-305 0051은 홈 구성 세 표·칸·색인을 만들고 core_app에 읽기만 준다', () => {
    if (!existsSync(file)) throw new Error('0051_home_layout_read.sql이 없다');
    const sql = readFileSync(file, 'utf8');
    for (const table of ['home_banner', 'home_theme', 'home_theme_item']) expect(sql).toMatch(new RegExp(`CREATE TABLE "${table}"`));
    for (const column of ['image_key', 'alt_text', 'title', 'subtitle', 'sort_order', 'display_from', 'display_until', 'production_id', 'theme_id']) {
      expect(sql).toMatch(new RegExp(`"${column}"`));
    }
    for (const index of ['home_banner_display_idx', 'home_theme_display_idx', 'home_theme_item_order_idx']) expect(sql).toMatch(new RegExp(`CREATE INDEX "${index}"`));
    // 공개 읽기 경로(core_app)에만 SELECT를 준다. 쓰기 권한은 OPS-410이 붙일 때 정한다.
    for (const table of ['home_banner', 'home_theme', 'home_theme_item']) expect(sql).toMatch(new RegExp(`GRANT SELECT[^;]*"${table}"`, 'i'));
    expect(sql).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)[^;]*"home_(banner|theme)/i);
    // 홈 구성은 공개 콘텐츠라 행 보안을 걸지 않는다(계획 I-01).
    expect(sql).not.toMatch(/ROW LEVEL SECURITY/i);
  });
});
