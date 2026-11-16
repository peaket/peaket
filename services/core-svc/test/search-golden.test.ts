// 골든 세트 시험(BAT-165 웨이브 7 T-10, SR-T12). 고정 카탈로그를 메모리 저장소에 채우고 HTTP(GET /v1/search·/v1/search/suggestions)로 묻는다.
// 정본: docs/features/search.md:303 SR-T12(검색어 100개 [가정], §3·§5의 모든 경우, 순서 경우는 §4.5 브라우저 거르기 함수를 거친다),
// NFR-028(docs/planning/02-requirements.md:189: 1위 정답률 90% [가정]·3위 안 정답률 98% [가정]). 정답률은 test-report-search-golden.json으로도 낸다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, SearchCatalog } from '../src/modules/catalog/index.js';
import { fillMemory, loadGolden, runSequence, searchUrl, type GoldenCase, type SuggestItem } from './search-golden-fixture.js';
import { FakeIdentity, quiet } from './support.js';

const golden = loadGolden();
// 정본 값(NFR-028). 코드 상수를 가져오지 않는다
const TOP1 = 0.9;
const TOP3 = 0.98;
const CASES = 100;
// §3(정규화·띄어쓰기·조합 중 낱자·초성·한/영 변환·로마자 이름)과 §5(다른 이름·아티스트·공연장·앞부분·낱말 앞부분·중간 일치·0건 제안·필터), §4.5 순서 경우
const KINDS = ['exact', 'normalize', 'nospace', 'composing', 'chosung', 'qwerty', 'roman', 'alias', 'artist', 'place', 'prefix', 'word-prefix', 'middle', 'typo', 'filter', 'sequence'];

let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  const repo = new MemoryCatalogRepository();
  fillMemory(repo, golden);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: Date.parse(golden.now) }),
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
  // 자동완성 사전은 주기 일만 갱신한다(R165-3). 순서 경우 전에 첫 갱신을 직접 부른다
  await svc.app.get(SearchCatalog).dictionary.refresh();
});
afterAll(async () => {
  await svc?.close();
});

const getJson = async (url: string): Promise<Record<string, unknown>> => {
  const r = await svc.http.inject({ method: 'GET', url });
  if (r.statusCode !== 200) throw new Error(`${url} → ${r.statusCode} ${r.payload}`);
  return JSON.parse(r.payload) as Record<string, unknown>;
};

/** 한 경우의 1위·3위 맞힘 */
async function score(c: GoldenCase): Promise<{ top1: boolean; top3: boolean; got: unknown }> {
  if (c.kind === 'sequence') {
    const out = await runSequence(c, async (q) => (await getJson(`/v1/search/suggestions?q=${encodeURIComponent(q)}`)) as { query: string; items: SuggestItem[] });
    const ok = JSON.stringify(out.requests) === JSON.stringify((c.steps ?? []).map((s) => s.request)) && (c.expectIn === undefined || out.last.includes(c.expectIn));
    return { top1: ok, top3: ok, got: out };
  }
  const page = await getJson(searchUrl(c));
  if (c.didYouMean !== undefined) {
    const ok = (page.items as unknown[]).length === 0 && page.didYouMean === c.didYouMean;
    return { top1: ok, top3: ok, got: page.didYouMean };
  }
  const ids = (page.items as { productionId: string }[]).map((x) => x.productionId);
  return { top1: ids[0] === c.expect, top3: ids.slice(0, 3).includes(c.expect!), got: ids.slice(0, 3) };
}

describe('골든 세트', () => {
  test('SR-T12 골든 세트의 1위·3위 정답률이 NFR-028 이상이고 순서 경우는 브라우저 거르기 함수를 거친다', async () => {
    // 경우가 비거나 모자라 정답률이 통과로 새지 않게 먼저 센다
    expect(golden.cases).toHaveLength(CASES);
    expect(KINDS.filter((k) => !golden.cases.some((c) => c.kind === k))).toEqual([]);
    expect(golden.cases.filter((c) => c.kind === 'sequence').length).toBeGreaterThanOrEqual(3);
    expect(golden.cases.filter((c) => c.kind !== 'sequence' && c.expect === undefined && c.didYouMean === undefined)).toEqual([]);
    expect(new Set(golden.cases.map((c) => c.id)).size).toBe(CASES);

    const rows: { id: string; kind: string; q: string | undefined; top1: boolean; top3: boolean; got: unknown }[] = [];
    for (const c of golden.cases) {
      const s = await score(c);
      rows.push({ id: c.id, kind: c.kind, q: c.q ?? c.steps?.map((x) => x.q).join(' → '), ...s });
    }
    const top1 = rows.filter((r) => r.top1).length / rows.length;
    const top3 = rows.filter((r) => r.top3).length / rows.length;
    const report = { cases: rows.length, top1, top3, target: { top1: TOP1, top3: TOP3 }, misses: rows.filter((r) => !r.top3 || !r.top1) };
    writeFileSync(fileURLToPath(new URL('../test-report-search-golden.json', import.meta.url)), `${JSON.stringify(report, null, 1)}\n`);
    console.info(`SR-T12 골든 세트: 1위 ${(top1 * 100).toFixed(0)}% · 3위 안 ${(top3 * 100).toFixed(0)}% (${rows.length}개)`);
    expect(rows).toHaveLength(CASES);
    expect({ top1: top1 >= TOP1, top3: top3 >= TOP3, misses: report.misses }).toEqual({ top1: true, top3: true, misses: report.misses });
  });
});
