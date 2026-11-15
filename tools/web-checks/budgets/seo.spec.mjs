// 검색 화면의 검색 엔진 노출 빌드 검사(BAT-165 웨이브 7 T-21, SR-T14). 운영 빌드 서버에서 HTML·sitemap을 받아 본다(브라우저를 띄우지 않는다).
// 정본: docs/features/search.md §7.3(248줄: `/search` 셸에 `<meta name="robots" content="noindex, follow">`를 두고 sitemap에 넣지 않는다), :305 SR-T14.
import { test, expect } from '@playwright/test';
import { APPS, HOST, portOf } from '../seed-css/apps.mjs';

const web = APPS.find((a) => a.name === 'web');

test('SR-T14 /search 셸에 noindex, follow가 있고 sitemap에 없다', async ({ request }) => {
  expect(web, 'seed-css/apps.mjs에 web 앱이 없다').toBeDefined();
  const origin = `http://${HOST}:${portOf(web, 'prod')}`;
  // 검색어가 있어도 없어도 같은 셸이다
  for (const path of ['/search', `/search?q=${encodeURIComponent('루멘')}`]) {
    const res = await request.get(origin + path, { maxRedirects: 0 });
    expect(res.status(), `${path} HTML`).toBe(200);
    const html = await res.text();
    const robots = [...html.matchAll(/<meta[^>]+name="robots"[^>]*>/g)].map((m) => m[0]);
    // 하나뿐이고 그 값이 정확히 noindex, follow다(빈 결과가 통과로 새지 않게 개수부터)
    expect(robots, `${path} robots 메타`).toHaveLength(1);
    expect(robots[0]).toContain('content="noindex, follow"');
  }
  // 대조: 공연 상세·홈은 색인 제외가 아니다
  const home = await (await request.get(origin + '/')).text();
  expect(home).not.toMatch(/<meta[^>]+name="robots"[^>]+noindex/);
  // sitemap이 없으면 없음(404)을 단언하고, 있으면 /search 주소가 없다
  const sm = await request.get(origin + '/sitemap.xml', { maxRedirects: 0 });
  expect([200, 404], `/sitemap.xml ${sm.status()}`).toContain(sm.status());
  if (sm.status() === 200) {
    const xml = await sm.text();
    expect(xml).toContain('<urlset');
    expect(xml).not.toMatch(/<loc>[^<]*\/search(?:[?<]|$)/);
  }
});
