// 공지·홈 구성 화면의 운영 빌드 확인(F-03-5 T16, OPS-410·OPS-420).
// 정본: docs/design/d5-screen-blueprint.md §3.9(휴대폰 1열·태블릿 2/3열·범위 밖 안내 카드)·§7.16(SCR-068),
// docs/features/control-tower.md §12·§14 C-T29, 계획 docs/review/plans/F-03-5.md §5 T16.
// 빌드: `PEAKET_OPS_API_ORIGIN=http://localhost:4134 pnpm --filter @peaket/console-host build` 뒤 이 폴더에서 `pnpm run console-notices`.
// API는 페이지 안에서 가로챈다(page.route). 서버가 없으므로 계약 모양의 대역만 쓴다('감독에게' 3).
// 구현 전 트리에는 화면이 보드뿐이라 이 시험이 실패한다.
import { test, expect } from '@playwright/test';

const BASE = 'http://127.0.0.1:4134';
const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const HOME = {
  version: 7,
  updatedBy: '민호(operator)',
  updatedAt: '2026-11-20T03:00:00.000Z',
  banners: [
    {
      bannerId: 'bn-1',
      productionId: E,
      imageId: 'img-1',
      alt: 'LUMEN 콘서트 2026 서울, 10/25(일) 피켓 아레나',
      title: 'LUMEN 콘서트 2026 서울',
      subtitle: '10/25(일) 피켓 아레나',
      displayFrom: '2026-11-01T00:00:00.000Z',
      displayUntil: '2026-12-01T00:00:00.000Z',
    },
  ],
  themes: [
    {
      themeId: 'th-1',
      name: '올해의 재즈',
      productionIds: [E],
      displayFrom: '2026-11-01T00:00:00.000Z',
      displayUntil: '2026-12-01T00:00:00.000Z',
    },
  ],
};
const TEMPLATE = {
  templateId: 'entry-delay',
  title: '입장 지연 안내',
  texts: { ko: '접속이 많아 입장이 평소보다 늦어질 수 있습니다.', en: 'Entry may be slower than usual.', ja: '入場が通常より遅れる場合があります。', zh: '入场可能比平时慢。' },
  status: 'IN_REVIEW',
  version: 3,
};

/** 위반·정책 이름을 모은다(F-03-1 T12와 같은 방식) */
async function track(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    window.__ttNames = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: (e.sample || '').slice(0, 80) }));
    const tt = window.trustedTypes;
    if (tt?.createPolicy) {
      const create = tt.createPolicy.bind(tt);
      tt.createPolicy = (name, rules) => {
        window.__ttNames.push(name);
        return create(name, rules);
      };
    }
  });
  return () => page.evaluate(() => ({ violations: window.__csp, names: window.__ttNames }));
}

/** 계약 모양의 API 대역. role·publishStatus로 시험마다 답을 바꾼다. putBodies에 보낸 본문을 모은다 */
async function stub(page, { role = 'operator', publishStatus = 200 } = {}) {
  const puts = [];
  await page.route('**/v1/ops/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/v1/ops/auth/sessions/me') return json(200, { role, displayName: role === 'viewer' ? '보기' : '민호', designations: [] });
    if (p === '/v1/ops/sale-reviews') return json(200, { items: [{ productionId: E, title: 'LUMEN 콘서트 2026 서울', status: 'APPROVED' }], nextCursor: null });
    if (p === '/v1/ops/home-layout' && method === 'GET') return json(200, HOME);
    if (p === '/v1/ops/home-layout' && method === 'PUT') {
      puts.push({ headers: req.headers(), body: JSON.parse(req.postData() ?? '{}') });
      if (publishStatus === 412) {
        return route.fulfill({
          status: 412,
          contentType: 'application/problem+json',
          body: JSON.stringify({ type: 'https://peaket.example/problems/precondition-failed', title: '판이 다릅니다', status: 412, detail: '서버 내부 문구' }),
        });
      }
      return json(200, { ...HOME, version: 8 });
    }
    if (p === '/v1/ops/notice-templates') return json(200, { items: [TEMPLATE], nextCursor: null });
    if (p === '/v1/ops/partner-notices') return json(200, { items: [], nextCursor: null });
    if (p === '/v1/ops/live') return route.fulfill({ status: 204, body: '' });
    return json(200, { items: [], nextCursor: null });
  });
  return puts;
}

const gridCount = (page) =>
  page.locator('[data-home-grid]').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length);

test('F-03-5 T16 1440 데스크톱은 홈 구성을 3열로 그리고 사유를 If-Match와 함께 보내며, 412를 우리 글로 보인다', async ({ page }) => {
  const read = await track(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const puts = await stub(page);
  await page.goto(`${BASE}/notices?tab=home`);
  await expect(page.getByRole('heading', { name: '공지 관리' })).toBeVisible();
  await expect(page.locator('[data-home-grid]')).toBeVisible();
  expect(await gridCount(page)).toBe(3);
  await expect(page.getByText('LUMEN 콘서트 2026 서울').first()).toBeVisible();
  await expect(page.getByText('민호(operator)')).toBeVisible();

  await page.locator('textarea[name="home-reason"], input[name="home-reason"]').fill('겨울 시즌 배너로 바꿉니다');
  await page.getByRole('button', { name: /홈에 게시하기/ }).click();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0].headers['if-match']).toBe('7');
  expect(puts[0].body.version).toBe(7);
  expect(puts[0].body.reason).toBe('겨울 시즌 배너로 바꿉니다');
  expect('updatedBy' in puts[0].body).toBe(false);

  const got = await read();
  expect(got.violations).toEqual([]);
  expect([...new Set(got.names)].filter((n) => !['peaket', 'peaket-webpack-host', 'peaket-webpack-queue', 'peaket-webpack-purchase', 'peaket-remote', 'default'].includes(n))).toEqual([]);
});

test('F-03-5 T16 412를 받으면 다른 운영자가 먼저 저장했다는 글과 새로 읽기 단추가 보인다', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stub(page, { publishStatus: 412 });
  await page.goto(`${BASE}/notices?tab=home`);
  await page.locator('[name="home-reason"]').fill('겨울 시즌 배너로 바꿉니다');
  await page.getByRole('button', { name: /홈에 게시하기/ }).click();
  await expect(page.getByText('다른 운영자가 먼저 저장했습니다. 새로 읽은 뒤 다시 게시해 주세요')).toBeVisible();
  await expect(page.getByRole('button', { name: '새로 읽기' })).toBeVisible();
});

test('F-03-5 T16 360 휴대폰은 1열·보기만 하고 범위 밖 안내 카드를 보이며 가로 스크롤이 없다', async ({ page }) => {
  const read = await track(page);
  await page.setViewportSize({ width: 360, height: 800 });
  const puts = await stub(page, { role: 'commander' });
  await page.goto(`${BASE}/notices?tab=home`);
  await expect(page.locator('[data-phone-scope]')).toHaveCount(1);
  await expect(page.getByText('이 작업은 태블릿이나 데스크톱에서 합니다. 휴대폰에서는 볼 수만 있습니다')).toBeVisible();
  await expect(page.getByRole('button', { name: /홈에 게시하기/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /배너 추가/ })).toHaveCount(0);
  expect(await gridCount(page)).toBe(1);
  const scroll = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll.width, `문서 너비 ${scroll.width} > 창 ${scroll.inner}`).toBeLessThanOrEqual(scroll.inner);
  expect(puts.length).toBe(0);
  const got = await read();
  expect(got.violations).toEqual([]);

  await page.getByRole('tab', { name: /대기실 공지 템플릿/ }).click();
  await expect(page.locator('[data-phone-scope]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /새 템플릿 작성/ })).toHaveCount(0);
});

test('F-03-5 T16 768 태블릿은 2열, 1024 태블릿은 3열이고 viewer는 게시 단추가 없다', async ({ page }) => {
  await stub(page);
  for (const [width, want] of [
    [768, 2],
    [1024, 3],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}/notices?tab=home`);
    await expect(page.locator('[data-home-grid]')).toBeVisible();
    expect(await gridCount(page), `${width}px`).toBe(want);
    const scroll = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(scroll.width, `${width}px 문서 너비`).toBeLessThanOrEqual(scroll.inner);
  }
  await page.setViewportSize({ width: 1024, height: 900 });
  await stub(page, { role: 'viewer' });
  await page.goto(`${BASE}/notices`);
  await expect(page.getByRole('heading', { name: '공지 관리' })).toBeVisible();
  await expect(page.getByRole('button', { name: /홈에 게시하기/ })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /대기실 공지 템플릿/ })).toHaveCount(0);
});
