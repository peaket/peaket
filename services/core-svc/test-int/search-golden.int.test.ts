// 골든 세트를 PostgreSQL 어댑터로 돌려 메모리 어댑터와 순위를 견준다(BAT-165 웨이브 7 T-11, SR-T12, ADR-0271 결정 4: 등급 규칙은 두 어댑터가 같은 TS 함수 하나).
// 같은 고정 파일(test/fixtures/search-golden.json)을 두 저장소에 채우고, 검색 경우마다 쪽의 공연 ID 목록이 같아야 한다.
import 'reflect-metadata';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { nameKeys } from '@peaket/search-normalize';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { DrizzleSearchIndex, DrizzleSearchReadModel, MemoryCatalogRepository, MemorySearchIndex } from '../src/modules/catalog/index.js';
import type { SearchQuery } from '../src/modules/catalog/domain/search.js';
import { fillDatabase, fillMemory, loadGolden, type GoldenCase } from '../test/search-golden-fixture.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const golden = loadGolden();
const NOW = Date.parse(golden.now);
let pg: PostgresContainer;
let db: Database;
let pgIndex: DrizzleSearchIndex;
let stagedIndex: DrizzleSearchIndex;
let memIndex: MemorySearchIndex;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  db = createDatabase({ url: pg.url, applicationName: 'core-search-golden-int', max: 4 });
  const ids = await fillDatabase(db, golden);
  const sync = new DrizzleSearchReadModel(db);
  await db.transaction((tx) => sync.sync(tx, ids, new Date(NOW)));
  pgIndex = new DrizzleSearchIndex(db, 'https://img.test');
  // BAT-167 한 글자 단계별 읽기(사전 keysOf+ready)를 켠 어댑터. 이름 비교 값은 사전처럼 한 번만 만든다
  const names = new Map<string, ReturnType<typeof nameKeys>>();
  for (const p of golden.productions) for (const n of [p.title, ...p.aliases]) names.set(n, nameKeys(n));
  for (const a of golden.artists) names.set(a.name, nameKeys(a.name));
  for (const p of golden.places) names.set(p.name, nameKeys(p.name));
  stagedIndex = new DrizzleSearchIndex(db, 'https://img.test', { keysOf: (n) => names.get(n), ready: () => true });
  const repo = new MemoryCatalogRepository();
  fillMemory(repo, golden);
  memIndex = new MemorySearchIndex(repo, 'https://img.test', fakeClock({ now: NOW }));
}, 180_000);

afterAll(async () => {
  await db?.close();
  pg?.stop();
});

const queryOf = (c: GoldenCase, page = 1): SearchQuery => ({ q: c.q ?? '', includePast: false, noConvert: false, page, now: new Date(NOW), ...(c.params as Partial<SearchQuery>) });

describe('골든 세트(PostgreSQL)', () => {
  test('SR-T12 같은 골든 세트를 PostgreSQL 어댑터로 돌려도 메모리 어댑터와 순위가 같다', async () => {
    const cases = golden.cases.filter((c) => c.kind !== 'sequence');
    expect(cases).toHaveLength(97);
    // BAT-167 새 경로(한 글자 단계별 읽기)가 실제로 지나갔는지 먼저 센다
    expect(cases.filter((c) => c.q !== undefined && [...c.q.trim()].length === 1).length).toBeGreaterThanOrEqual(2);
    // 여러 쪽에 걸친 목록(검색어 없음·오픈 임박, 지난 공연 포함)도 쪽마다 견준다
    const paged: GoldenCase[] = [
      { id: 'P01', kind: 'list', q: '' },
      { id: 'P02', kind: 'list', q: '', params: { includePast: true, sort: 'POPULAR' } },
    ];
    let nonEmpty = 0;
    for (const c of cases) {
      const [a, staged, b] = await Promise.all([pgIndex.search(queryOf(c)), stagedIndex.search(queryOf(c)), memIndex.search(queryOf(c))]);
      const pgIds = a.items.map((x) => x.productionId);
      if (pgIds.length > 0) nonEmpty += 1;
      expect({ id: c.id, q: c.q, ids: pgIds, total: a.total, didYouMean: a.didYouMean }).toEqual({ id: c.id, q: c.q, ids: b.items.map((x) => x.productionId), total: b.total, didYouMean: b.didYouMean });
      // BAT-167 새 경로도 같은 응답(결과·차례·전체 수·query·0건 제안·관련 공연)
      expect(staged, `${c.id} ${c.q ?? ''}`).toEqual(a);
    }
    for (const c of paged) {
      for (const page of [1, 2, 3]) {
        const [a, staged, b] = await Promise.all([pgIndex.search(queryOf(c, page)), stagedIndex.search(queryOf(c, page)), memIndex.search(queryOf(c, page))]);
        expect({ id: c.id, page, ids: a.items.map((x) => x.productionId) }).toEqual({ id: c.id, page, ids: b.items.map((x) => x.productionId) });
        expect(staged.items.map((x) => x.productionId), `${c.id} ${page}`).toEqual(a.items.map((x) => x.productionId));
        if (page === 1) expect(a.items).toHaveLength(20);
      }
    }
    // 빈 결과끼리 같아서 통과하지 않게: 정답이 있는 경우(오타 둘 밖)는 모두 결과가 있다
    expect(nonEmpty).toBe(cases.filter((c) => c.expect !== undefined).length);
  });
});
