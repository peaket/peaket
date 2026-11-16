// 검색 품질 사건을 부르는 자리의 바깥 경계 검사(리뷰 R165-5, ADR-0271 결정 16, 계획 docs/review/plans/BAT-165.md '### 13' R165-5).
// 운영 빌드의 웹(머리 검색창·검색 화면)을 띄우고 `/v1/search*`는 고정 응답으로 준다. 화면을 떠날 때(pagehide·visibilitychange) 보낸 `/_t/rum` 본문을 가로채 센다.
// 정본: docs/features/search.md §11(search_suggest_selected_total{kind, position}, search_requery_total: 결과를 누르지 않고 10초 [가정] 안에 다시 찾음),
// catalog-review.md:157(14.2.3: 검색어 없이 수만 같은 출처로). 웨이브 끝 budgets 게이트에서 돈다(운영 빌드 필요).
import { test, expect } from '@playwright/test';
import { APPS, HOST, portOf } from '../seed-css/apps.mjs';

const web = APPS.find((a) => a.name === 'web');
const origin = () => `http://${HOST}:${portOf(web, 'prod')}`;
const ev = (n) => `77777777-7777-4777-8777-77777777777${n}`;
const pr = (n) => `88888888-8888-4888-8888-88888888888${n}`;

const suggestions = (q) => ({
  query: q,
  items: [1, 2, 3, 4].map((n) => ({ kind: 'PRODUCTION', label: `루멘 공연 ${n}`, productionId: pr(n), eventId: ev(n), matches: [{ start: 0, length: 2 }], saleStatus: 'ON_SALE' })),
});
const results = (q) => ({
  items: [1, 2, 3].map((n) => ({ productionId: pr(n), eventId: ev(n), title: `루멘 공연 ${n}`, genre: '콘서트', saleStatus: 'ON_SALE' })),
  page: 1,
  limit: 20,
  total: 3,
  totalCapped: false,
  totalPages: 1,
  query: { normalized: q, converted: null },
  didYouMean: null,
  relaxedTotal: null,
  related: null,
});

/** 고정 응답과 `/_t/rum` 가로채기. 보낸 본문의 counters를 모아 이름{라벨} → 값으로 돌려준다 */
async function wire(page) {
  const bodies = [];
  await page.route('**/v1/search/suggestions*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(suggestions(q)) });
  });
  await page.route(/\/v1\/search(\?|$)/, (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(results(q)) });
  });
  await page.route('**/_t/rum', async (route) => {
    bodies.push(route.request().postData() ?? '');
    await route.fulfill({ status: 204 });
  });
  const leave = async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    });
    await page.waitForTimeout(500);
  };
  const counters = () => {
    const out = {};
    for (const b of bodies) {
      for (const c of JSON.parse(b).counters ?? []) {
        const labels = Object.entries(c.labels ?? {})
          .sort(([a], [b2]) => (a < b2 ? -1 : 1))
          .map(([k, v]) => `${k}=${v}`)
          .join(',');
        const key = labels ? `${c.name}{${labels}}` : c.name;
        out[key] = (out[key] ?? 0) + c.value;
      }
    }
    return out;
  };
  return { bodies, leave, counters };
}

test('검색 품질: 머리 검색창 자동완성의 셋째 공연을 고르면 선택 사건이 PRODUCTION·3으로 오르고, 결과를 본 뒤 10초 안에 머리 검색창으로 다시 찾으면 바로 다시 찾음이 오른다 [ASVS v5.0.0-14.2.3](R165-5)', async ({ page }) => {
  expect(web, 'seed-css/apps.mjs에 web 앱이 없다').toBeDefined();
  const w = await wire(page);
  // 자동완성 셋째 공연 고르기
  await page.goto(`${origin()}/`);
  const box = page.getByRole('combobox').first();
  await box.fill('루멘');
  await expect(page.getByRole('option').nth(2)).toBeVisible();
  await page.getByRole('option').nth(2).click();
  // 검색 결과를 보인 뒤 누르지 않고 다른 검색어로 다시 찾기(10초 안)
  await page.goto(`${origin()}/search?q=${encodeURIComponent('루멘')}`);
  await expect(page.locator('a[href^="/events/"]').first()).toBeVisible();
  const again = page.getByRole('combobox').first();
  await again.fill('루멘 앙코르');
  await again.press('Enter');
  await page.waitForURL(/\/search\?q=/);
  await expect(page.locator('a[href^="/events/"]').first()).toBeVisible();
  await w.leave();
  const c = w.counters();
  expect(w.bodies.length).toBeGreaterThanOrEqual(1);
  expect(c['search_suggest_selected_total{kind=PRODUCTION,position=3}']).toBe(1);
  expect(c.search_requery_total).toBe(1);
  // 본문에 검색어가 없다(14.2.3)
  for (const s of ['루멘', encodeURIComponent('루멘'), 'q=']) expect(w.bodies.join('\n')).not.toContain(s);
});

test('검색 품질: 결과 항목을 누른 뒤 다시 찾으면 바로 다시 찾음이 오르지 않는다(대조군, R165-5)', async ({ page }) => {
  const w = await wire(page);
  await page.goto(`${origin()}/search?q=${encodeURIComponent('루멘')}`);
  const first = page.locator('a[href^="/events/"]').first();
  await expect(first).toBeVisible();
  await first.click();
  await page.goto(`${origin()}/search?q=${encodeURIComponent('루멘 앙코르')}`);
  await expect(page.locator('a[href^="/events/"]').first()).toBeVisible();
  await w.leave();
  expect(w.bodies.length).toBeGreaterThanOrEqual(1);
  expect(w.counters().search_requery_total ?? 0).toBe(0);
});
