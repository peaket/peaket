// F-07-9 LCH-130 파트너 콘솔 실기 레이아웃 검사(FE-T31). d5 §3.9의 휴대폰(md 미만)·태블릿(md) 배치를
// 실제 운영 빌드에서 본다. 360px에서 문서 전체 가로 스크롤이 없고, 큰 화면 전용 일은 안내 카드로 바뀌며,
// 휴대폰에서 하는 일(목록·상태·카드)은 남아 있는지 확인한다.
// 이 파일은 동결 로컬 범위에서 브라우저를 띄우지 못할 수 있어 남은 위험으로 기록한다(계획 §10).
import { expect, test } from '@playwright/test';
import { openReflowPage } from './open.mjs';

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

const VIEWPORTS = [
  { name: '휴대폰 360', width: 360, height: 640 },
  { name: '태블릿 768', width: 768, height: 1024 },
];

const overflow = (page) =>
  page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

for (const vp of VIEWPORTS) {
  test.describe(`FE-T31 파트너 전 화면 ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

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

test.describe('FE-T31 파트너 휴대폰에서 큰 화면 전용 일은 안내 카드로 바뀐다', () => {
  test.use({ viewport: { width: 360, height: 640 } });

  test('SCR-024 판매 정책: 규칙 카드·안내 카드가 보이고 편집·시뮬레이션은 숨는다', async ({ page }) => {
    await openReflowPage(page, { app: 'partner', path: '/events/evt-lumen-2026/policy' });
    await expect(page.getByText('규칙 편집과 시뮬레이션은 태블릿이나 데스크톱에서 합니다')).toBeVisible();
    await expect(page.getByRole('button', { name: '새 규칙' })).toBeHidden();
    await expect(page.getByRole('button', { name: '판매 정책 저장' })).toBeHidden();
    await expect(page.getByRole('heading', { name: '시뮬레이션' })).toBeHidden();
    await expect(page.getByRole('list', { name: /등록 규칙/ })).toBeVisible();
  });

  test('SCR-023 상품 만들기: 안내 카드·목록 링크만 보이고 폼은 숨는다', async ({ page }) => {
    await openReflowPage(page, { app: 'partner', path: '/products/new' });
    await expect(page.getByText('상품 만들기·게시는 태블릿이나 데스크톱에서 합니다')).toBeVisible();
    await expect(page.getByRole('link', { name: '상품 목록 보기' })).toBeVisible();
    await expect(page.locator('form').first()).toBeHidden();
  });

  test('SCR-023 굿즈 주문 현황: 상품별 카드가 보이고 표는 숨는다', async ({ page }) => {
    await openReflowPage(page, { app: 'partner', path: '/products/orders' });
    await expect(page.getByRole('list', { name: /상품별 주문/ })).toBeVisible();
    await expect(page.locator('.table-wrap').first()).toBeHidden();
  });

  test('SCR-020 판매자 정보: 고지·정산 주체가 보이고 변경 요청은 숨는다', async ({ page }) => {
    await openReflowPage(page, { app: 'partner', path: '/settings/seller' });
    await expect(page.getByText(/PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다/)).toBeVisible();
    await expect(page.getByText('중개자 지위와 정산')).toBeVisible();
    await expect(page.getByText('중개수수료율')).toBeVisible();
    await expect(page.getByRole('button', { name: '변경 요청' })).toBeHidden();
  });
});

test('FE-T31 태블릿 768에서는 판매자 정보 변경 요청과 폼이 보인다', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openReflowPage(page, { app: 'partner', path: '/settings/seller' });
  await expect(page.getByRole('button', { name: '변경 요청' })).toBeVisible();
  await expect(page.getByText('판매자 정보 변경 요청은 태블릿이나 데스크톱에서 합니다')).toBeHidden();
});
