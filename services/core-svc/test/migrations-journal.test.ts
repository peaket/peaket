// core-svc 마이그레이션 저널 점검(리뷰 R165-7, 계획 docs/review/plans/BAT-165.md '### 13' R165-7, 메인 감독 결정 2026-11-16).
// Drizzle 마이그레이터는 DB에 마지막으로 적용된 when보다 작은 마이그레이션을 조용히 건너뛴다. 그래서 when은 idx 차례로 늘 커야 하고,
// 파일 번호와 idx가 같아야 하며, 저널의 모든 태그에 파일이 있어야 한다.
// 이번 웨이브 번호: 갈래 3이 0021·0022, 갈래 2가 0023·0024, 갈래 1이 0025부터. 검색 표 마이그레이션은 0023이고 when은 갈래 3 마지막(0022) 값 1794789168699보다 크다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const journal = JSON.parse(readFileSync(`${dir}meta/_journal.json`, 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
// 이번 웨이브 갈래 3의 마지막 when: `wave/lane3-w7`의 `0022_review_role_grants`(리뷰 R165-13, 계획 BAT-165 '### 14'. 처음 적은 1794789068699는 0021 값이었다)
const LANE3_WHEN = 1_794_789_168_699;

describe('마이그레이션 저널', () => {
  test('core-svc 마이그레이션 저널의 when은 idx 차례로 늘 커지고 파일 번호와 idx가 같다(R165-7)', () => {
    const e = journal.entries;
    // 빈 저널이 통과로 새지 않게
    expect(e.length).toBeGreaterThanOrEqual(21);
    for (let i = 1; i < e.length; i++) expect({ tag: e[i]!.tag, later: e[i]!.when > e[i - 1]!.when }).toEqual({ tag: e[i]!.tag, later: true });
    for (const x of e) {
      expect({ tag: x.tag, num: Number(x.tag.slice(0, 4)) }).toEqual({ tag: x.tag, num: x.idx });
      expect({ tag: x.tag, file: existsSync(`${dir}${x.tag}.sql`) }).toEqual({ tag: x.tag, file: true });
    }
    // 파일은 있는데 저널에 없는 마이그레이션도 없다
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, ''));
    expect(files.filter((f) => !e.some((x) => x.tag === f))).toEqual([]);
  });

  // BAT-615 리뷰 2 RV-13: 0033의 when이 0032보다 작으면 Drizzle는 마지막 적용 시각보다 작은 마이그레이션을 조용히 건너뛴다.
  // 그러면 새 DB와 0032가 적용된 DB 모두에서 promoter_contract·수수료율 칸·새 멱등 작업이 생기지 않는다.
  test('0033_promoter_contract의 when은 0032보다 크다(RV-13)', () => {
    const e = journal.entries;
    // 저널 배열에는 번호가 빈 칸(0024·0025)이 있어 배열 위치가 아니라 idx로 찾는다
    const e32 = e.find((x) => x.tag === '0032_merch_refund_replaces');
    const e33 = e.find((x) => x.tag === '0033_promoter_contract');
    expect({ idx32: e32?.idx, idx33: e33?.idx }).toEqual({ idx32: 32, idx33: 33 });
    expect({ tag: e33!.tag, later: e33!.when > e32!.when }).toEqual({ tag: '0033_promoter_contract', later: true });
  });

  test('검색 표 마이그레이션은 갈래 2 몫 번호 0023이고 when이 갈래 3의 마지막 값보다 크다(R165-7)', () => {
    const search = journal.entries.filter((x) => x.tag.endsWith('_search_read_model_tables'));
    expect(search.map((x) => x.tag)).toEqual(['0023_search_read_model_tables']);
    expect(search[0]!.when).toBeGreaterThan(LANE3_WHEN);
  });

  // F-10-2: 다른 동결 가지가 0048·0049를 이미 쓴다. 겹치지 않게 0050을 쓰고, 저널 순서는 0047 뒤다.
  test('F-10-2 이미지 작업 표는 0050_image_job이고 0047 뒤에 적용된다', () => {
    const job = journal.entries.find((x) => x.tag === '0050_image_job');
    expect(job).toMatchObject({ idx: 50 });
    const e47 = journal.entries.find((x) => x.tag === '0047_entry_closed_grant');
    expect(job!.when).toBeGreaterThan(e47!.when);
    expect(existsSync(`${dir}0050_image_job.sql`)).toBe(true);
  });
});
