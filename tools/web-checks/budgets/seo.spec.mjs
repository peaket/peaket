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
  // 대조: 홈의 robots는 출시 전 전역 값(noindex, nofollow)이고 /search가 경로로 정한 값(noindex, follow)과 다르다(/search 값이 전역 값을 물려받은 것이 아니다).
  // 출시 때 전역 색인 제외를 풀면 원래 대조('홈은 색인 제외가 아니다': expect(home).not.toMatch(/<meta[^>]+name="robots"[^>]+noindex/))를 되살린다(docs/frontend.md '출시 전 전역 색인 제외', 계획 BAT-165 '### 19' (a))
  const home = await (await request.get(origin + '/')).text();
  const homeRobots = [...home.matchAll(/<meta[^>]+name="robots"[^>]*>/g)].map((m) => m[0]);
  expect(homeRobots).toHaveLength(1);
  expect(homeRobots[0]).toContain('content="noindex, nofollow"');
  expect(homeRobots[0]).not.toContain('content="noindex, follow"');
  // sitemap이 없으면 없음(404)을 단언하고, 있으면 /search 주소가 없다
  const sm = await request.get(origin + '/sitemap.xml', { maxRedirects: 0 });
  expect([200, 404], `/sitemap.xml ${sm.status()}`).toContain(sm.status());
  if (sm.status() === 200) {
    const xml = await sm.text();
    expect(xml).toContain('<urlset');
    expect(xml).not.toMatch(/<loc>[^<]*\/search(?:[?<]|$)/);
  }
});
