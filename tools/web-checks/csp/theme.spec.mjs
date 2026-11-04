// 소비자 웹 셸의 색 모드·글꼴(docs/design/d1 §4, d2 §1, docs/frontend.md §5.8 'Pretendard 서브셋', BUILD_ORDER HOT-291).
// 운영 빌드를 운영 헤더(CSP)로 띄워 세 엔진에서 본다: 운영체제 테마를 따르고, 색 모드 스크립트가 CSP에 막히지 않으며,
// 글꼴은 화면에 쓰인 글자의 동적 서브셋 조각만 받는다(가변 글꼴 전체 2MB를 받지 않는다).
import { test, expect } from '@playwright/test';
import { WEB_BASE } from './pages.mjs';

const PAGES = ['/', '/my/settings'];

async function look(page, path) {
  const violations = [];
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.effectiveDirective));
  });
  const fonts = [];
  page.on('request', (r) => {
    if (/\.woff2(\?|$)/.test(r.url())) fonts.push(r.url());
  });
  await page.goto(`${WEB_BASE}${path}`);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  const out = await page.evaluate(() => {
    const shell = document.querySelector('.pk.page') ?? document.body;
    const bg = getComputedStyle(shell).backgroundColor;
    const rgb = (bg.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const lum = rgb.length === 3 ? (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 : -1;
    return {
      user: document.documentElement.dataset.seedUserColorScheme ?? null,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      shellScheme: getComputedStyle(shell).colorScheme,
      lum,
      pretendard: document.fonts.check('16px "Pretendard Variable"', '공연'),
      csp: window.__csp,
    };
  });
  violations.push(...out.csp);
  return { ...out, violations, fonts };
}

for (const path of PAGES) {
  for (const scheme of ['dark', 'light']) {
    test(`FE-T35 ${path}: 운영체제 ${scheme}를 따르고(키트 바탕·맨 바깥 color-scheme) 색 모드 스크립트가 CSP에 막히지 않는다`, async ({ browser }) => {
      const ctx = await browser.newContext({ colorScheme: scheme });
      const page = await ctx.newPage();
      const r = await look(page, path);
      expect(r.user).toBe(scheme);
      expect(r.scheme).toBe(scheme);
      // 셸 루트(.pk)도 같은 color-scheme이라 화면 안 입력 칸·목록·스크롤 상자가 바탕과 맞게 그려진다
      expect(r.shellScheme).toBe(scheme);
      if (scheme === 'dark') expect(r.lum).toBeLessThan(0.3);
      else expect(r.lum).toBeGreaterThan(0.7);
      expect(r.violations).toEqual([]);
      await ctx.close();
    });
  }

  test(`${path}: 글꼴은 Pretendard 동적 서브셋 조각만 받는다(가변 글꼴 전체를 받지 않는다)`, async ({ page }) => {
    const r = await look(page, path);
    expect(r.pretendard).toBe(true);
    expect(r.fonts.length).toBeGreaterThan(0);
    expect(r.fonts.filter((u) => !/subset/i.test(u))).toEqual([]);
  });
}
