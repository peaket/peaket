// F-07-9 LCH-130 파트너 콘솔 실기 레이아웃 검사(FE-T31). d5 §3.9의 휴대폰(md 미만)·태블릿(md) 배치를
// 실제 운영 빌드에서 본다. 360px에서 문서 전체 가로 스크롤이 없고, 큰 화면 전용 일은 안내 카드로 바뀌며,
// 휴대폰에서 하는 일(목록·상태·카드)은 남아 있는지 확인한다.
//
// TR-01: playwright.reflow.config.mjs가 프로젝트마다 제목 grep(`/ 320: /`·`/ 640…: /`)으로 시험을 고른다.
//   그래서 모든 시험 제목에 ' 320: ' 또는 ' 640: '을 넣고, describe에서 뷰포트를 360·768로 맞춘다.
// TR-02: SCR-024는 UUID 분기(+partner-api 대역)를 열어 실제 LiveSalePolicy를 보고,
//   SCR-023 주문은 listPartnerMerchOrderStats 대역으로 실제 카드를 본다.
import { expect, test } from '@playwright/test';
import { BASE, openReflowPage } from './open.mjs';

const PARTNER_API = 'https://partner-api.peaket.example';
const PARTNER_ORIGIN = new URL(BASE.partner).origin;
const POLICY_PRODUCTION = '0190f3a1-7c2e-7a00-8000-000000000301';

const POLICY = {
  version: 3,
  pending: false,
  rules: [
    { version: 1, name: '팬클럽 선예매', rounds: 'ALL', rule: { if: { fact: 'buyer.lists', has: 'fanclub' }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } } },
    { version: 1, name: 'R등급 판매 중지', rounds: 'ALL', rule: { if: { fact: 'grade', eq: 'R' }, then: { deny: 'GRADE_NOT_ON_SALE' } } },
    { version: 1, name: '7~9일 전 취소 공제율', rounds: 'ALL', refundFee: [{ daysLeft: { gte: 7, lte: 9 }, rate: 10 }] },
  ],
};

const ORDERS = {
  totals: { orderCount: 3, quantity: 5, deliveryOrderCount: 2, pickupOrderCount: 1, cancelReturnCount: 1 },
  daily: [],
  items: [
    { productId: 'prd-lightstick', productName: 'LUMEN 공식 응원봉', orderCount: 2, quantity: 3, deliveryQuantity: 2, pickupQuantity: 1, cancelCount: 1, returnCount: 0 },
    { productId: 'prd-tshirt', productName: 'LUMEN 투어 티셔츠 (블랙) — 아주 긴 상품 이름이 카드에서 잘리지 않는지 보는 값', orderCount: 1, quantity: 2, deliveryQuantity: 0, pickupQuantity: 2, cancelCount: 0, returnCount: 1 },
  ],
  nextCursor: null,
};

const cors = (req) => ({
  'access-control-allow-origin': req.headers().origin ?? PARTNER_ORIGIN,
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? 'content-type,if-match,x-requested-with',
  vary: 'Origin',
});

/** partner-api 대역. 시험이 정한 경로만 답하고 나머지는 503으로 닫는다. */
async function stubPartnerApi(page, routes = {}) {
  await page.route(`${PARTNER_API}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(req) });
    const path = new URL(req.url()).pathname;
    const hit = routes[path];
    if (hit === undefined) {
      return route.fulfill({
        status: 503,
        headers: { ...cors(req), 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
        body: JSON.stringify({ type: 'about:blank', title: 'Service Unavailable', status: 503 }),
      });
    }
    return route.fulfill({
      status: 200,
      headers: { ...cors(req), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      body: JSON.stringify(typeof hit === 'function' ? hit(req) : hit),
    });
  });
}

const policyRoutes = {
  [`/v1/partner/productions/${POLICY_PRODUCTION}/sale-policy`]: POLICY,
  [`/v1/partner/productions/${POLICY_PRODUCTION}/sale-eligibility-lists`]: { items: [] },
  '/v1/partner/productions': { items: [] },
};

const orderRoutes = (stats) => ({ '/v1/partner/merch-order-stats': stats });

const PARTNER = [
  '/events',
  '/events/new',
  '/events/evt-lumen-2026',
  '/events/evt-lumen-2026/edit',
  '/events/evt-lumen-2026/sale-review',
  '/events/evt-lumen-2026/seatmap',
  '/events/evt-lumen-2026/policy',
  '/events/evt-lumen-2026/live',
  '/events/evt-lumen-2026/staff',
  '/events/evt-lumen-2026/settlement',
  '/events/evt-lumen-2026/cancellation',
  '/products',
  '/products/new',
  '/products/orders',
  '/products/prd-lightstick',
  '/settings/account',
  '/settings/seller',
  '/settings/payout',
  '/settings/team',
  '/settings/webhooks',
];

const SIZES = [
  { token: ' 320: ', name: '휴대폰 360', width: 360, height: 640 },
  { token: ' 640: ', name: '태블릿 768', width: 768, height: 1024 },
];

const overflow = (page) =>
  page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

for (const size of SIZES) {
  test.describe(`FE-T31 파트너 전 화면${size.token}${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    for (const path of PARTNER) {
      test(`${path} 문서 가로 스크롤 0`, async ({ page }) => {
        await openReflowPage(page, { app: 'partner', path });
        await expect(page.locator('h1').first()).toBeVisible();
        const m = await overflow(page);
        expect(m.scrollWidth, `${path} 가로 스크롤 ${m.scrollWidth} > ${m.clientWidth}`).toBeLessThanOrEqual(m.clientWidth + 1);
      });
    }
  });
}

test.describe('FE-T31 파트너 320: 휴대폰에서 큰 화면 전용 일은 안내 카드로 바뀐다', () => {
  test.use({ viewport: { width: 360, height: 640 } });

  test('SCR-024 판매 정책: 실제 LiveSalePolicy의 규칙 카드·안내 카드가 보이고 편집·저장·시뮬레이션은 숨는다', async ({ page }) => {
    await stubPartnerApi(page, policyRoutes);
    await openReflowPage(page, { app: 'partner', path: `/events/${POLICY_PRODUCTION}/policy` });

    // UUID 분기(실제 API)를 열었는지: 목업 RulesCards가 아니라 LiveSalePolicy의 h2와 카드가 보인다.
    await expect(page.getByRole('heading', { name: '등록 규칙' })).toBeVisible();
    await expect(page.getByText('규칙 편집과 시뮬레이션은 태블릿이나 데스크톱에서 합니다')).toBeVisible();
    const cards = page.getByRole('list', { name: '등록 규칙 목록' });
    await expect(cards).toBeVisible();
    await expect(cards.getByText('팬클럽 선예매')).toBeVisible();
    await expect(cards.getByText('1인 2매')).toBeVisible();
    await expect(cards.getByText('초안').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '새 규칙' })).toBeHidden();
    await expect(page.getByRole('button', { name: '판매 정책 저장' })).toBeHidden();
    await expect(page.getByRole('heading', { name: '시뮬레이션' })).toBeHidden();
  });

  test('SCR-023 상품 만들기: 실제 LiveProductForm에서 안내 카드·목록 링크만 보이고 폼은 숨는다', async ({ page }) => {
    await stubPartnerApi(page, { '/v1/partner/productions': { items: [] } });
    await openReflowPage(page, { app: 'partner', path: '/products/new' });
    await expect(page.getByText('상품 만들기·게시는 태블릿이나 데스크톱에서 합니다')).toBeVisible();
    await expect(page.getByRole('link', { name: '상품 목록 보기' })).toBeVisible();
    await expect(page.locator('form').first()).toBeHidden();
  });

  test('SCR-023 굿즈 주문 현황: 실제 API 카드가 상품 이름과 여섯 값을 보이고 표는 숨는다', async ({ page }) => {
    await stubPartnerApi(page, orderRoutes(ORDERS));
    await openReflowPage(page, { app: 'partner', path: '/products/orders' });
    const cards = page.getByRole('list', { name: /상품별 주문/ });
    await expect(cards).toBeVisible();
    await expect(cards.getByText('LUMEN 공식 응원봉')).toBeVisible();
    await expect(cards.getByText(/주문 2건/)).toBeVisible();
    await expect(cards.getByText(/수량 3개/)).toBeVisible();
    await expect(cards.getByText(/택배 2/)).toBeVisible();
    await expect(cards.getByText(/현장 수령 1/)).toBeVisible();
    await expect(cards.getByText(/취소 1/)).toBeVisible();
    await expect(cards.getByText(/반품 0/)).toBeVisible();
    await expect(page.locator('.table-wrap').first()).toBeHidden();
  });

  test('SCR-023 굿즈 주문 현황: 주문 0건이면 빈 안내가 보이고 카드 목록은 없다', async ({ page }) => {
    await stubPartnerApi(page, orderRoutes({ totals: { orderCount: 0, quantity: 0, deliveryOrderCount: 0, pickupOrderCount: 0, cancelReturnCount: 0 }, daily: [], items: [], nextCursor: null }));
    await openReflowPage(page, { app: 'partner', path: '/products/orders' });
    await expect(page.getByText('아직 주문이 없습니다')).toBeVisible();
    await expect(page.getByRole('list', { name: /상품별 주문/ })).toHaveCount(0);
  });

  test('SCR-023 굿즈 주문 현황: 상품이 셋이면 카드도 셋이고 긴 이름이 보인다', async ({ page }) => {
    const stats = {
      totals: { orderCount: 6, quantity: 8, deliveryOrderCount: 4, pickupOrderCount: 2, cancelReturnCount: 0 },
      daily: [],
      items: [
        ORDERS.items[0],
        ORDERS.items[1],
        { productId: 'prd-hoodie', productName: 'LUMEN 후드', orderCount: 3, quantity: 3, deliveryQuantity: 2, pickupQuantity: 1, cancelCount: 0, returnCount: 0 },
      ],
      nextCursor: null,
    };
    await stubPartnerApi(page, orderRoutes(stats));
    await openReflowPage(page, { app: 'partner', path: '/products/orders' });
    const cards = page.getByRole('list', { name: /상품별 주문/ });
    await expect(cards.getByRole('listitem')).toHaveCount(3);
    await expect(cards.getByText(/아주 긴 상품 이름이 카드에서 잘리지 않는지/)).toBeVisible();
  });

  test('SCR-020 판매자 정보: 고지·정산 주체가 보이고 변경 요청은 숨는다', async ({ page }) => {
    await openReflowPage(page, { app: 'partner', path: '/settings/seller' });
    await expect(page.getByText(/PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다/)).toBeVisible();
    await expect(page.getByText('중개자 지위와 정산')).toBeVisible();
    await expect(page.getByText('중개수수료율')).toBeVisible();
    await expect(page.getByRole('button', { name: '변경 요청' })).toBeHidden();
  });
});

test.describe('FE-T31 파트너 640: 태블릿 768 경계', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('SCR-020 판매자 정보: 768에서는 변경 요청이 보이고 안내 카드는 숨는다', async ({ page }) => {
    await openReflowPage(page, { app: 'partner', path: '/settings/seller' });
    await expect(page.getByRole('button', { name: '변경 요청' })).toBeVisible();
    await expect(page.getByText('판매자 정보 변경 요청은 태블릿이나 데스크톱에서 합니다')).toBeHidden();
  });

  test('SCR-024 판매 정책: 768에서는 편집·저장·시뮬레이션이 보인다', async ({ page }) => {
    await stubPartnerApi(page, policyRoutes);
    await openReflowPage(page, { app: 'partner', path: `/events/${POLICY_PRODUCTION}/policy` });
    await expect(page.getByRole('button', { name: '새 규칙' })).toBeVisible();
    await expect(page.getByRole('button', { name: '판매 정책 저장' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '시뮬레이션' })).toBeVisible();
    await expect(page.getByText('규칙 편집과 시뮬레이션은 태블릿이나 데스크톱에서 합니다')).toBeHidden();
  });
});
