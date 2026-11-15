// COV2-02 회귀: search_document.sale_status는 회차별 상태를 보고 판매 중 회차가 없으면 UPCOMING/ENDED로 계산한다.
// 이 정적 시험은 Docker 없이 마이그레이션의 계약을 고정한다(실제 DB 동작은 test-int/search-sale-status.int.test.ts가 본다).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

describe('COV2-02 search_document 판매 상태', () => {
  test('0018은 판매 중 회차 우선, 다음 오픈 전 회차, 그 밖은 ENDED로 계산한다', () => {
    const sql = read('migrations/0018_search_sale_status.sql');
    expect(sql).toContain('CREATE OR REPLACE VIEW "search_document"');
    expect(sql).toContain('AS sale_status');
    expect(sql).toContain('THEN \'ON_SALE\'');
    expect(sql).toContain('THEN \'UPCOMING\'');
    expect(sql).toContain("ELSE 'ENDED'");
    // 지난 회차 + 다음 회차를 MIN/MAX 하나로 접지 않고 회차별 EXISTS로 판정한다
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM "event" e4[\s\S]*?e4\."open_at" <= now\(\)[\s\S]*?e4\."starts_at" - interval '24 hours' > now\(\)\) THEN 'ON_SALE'/);
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM "event" e5[\s\S]*?e5\."open_at" > now\(\)\) THEN 'UPCOMING'/);
    expect(sql).not.toContain('MIN(e."open_at") > now()');
    expect(sql).toContain(`e4."status" <> 'CANCELLED'`);
    expect(sql).toContain(`e5."status" <> 'CANCELLED'`);
  });

  test('journal이 0018_search_sale_status를 갖는다', () => {
    const journal = JSON.parse(read('migrations/meta/_journal.json')) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((e) => e.idx === 18)?.tag).toBe('0018_search_sale_status');
  });
});
