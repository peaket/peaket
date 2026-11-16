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

  test('검색 표 마이그레이션은 갈래 2 몫 번호 0023이고 when이 갈래 3의 마지막 값보다 크다(R165-7)', () => {
    const search = journal.entries.filter((x) => x.tag.endsWith('_search_read_model_tables'));
    expect(search.map((x) => x.tag)).toEqual(['0023_search_read_model_tables']);
    expect(search[0]!.when).toBeGreaterThan(LANE3_WHEN);
  });
});
