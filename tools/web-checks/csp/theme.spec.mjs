// 소비자 웹 셸의 색 모드·글꼴(docs/design/d1 §4, d2 §1, docs/frontend.md §5.8 'Pretendard 서브셋', BUILD_ORDER HOT-291).
// 운영 빌드를 운영 헤더(CSP)로 띄워 세 엔진에서 본다: 운영체제 테마를 따르고, 색 모드 스크립트가 CSP에 막히지 않으며,
// 글꼴은 화면에 쓰인 글자의 동적 서브셋 조각만 받는다(가변 글꼴 전체 2MB를 받지 않는다).
import { test, expect } from '@playwright/test';
import { WEB_BASE, stubFanApi } from './pages.mjs';
import { isBidiFirefox } from '../lib/firefox.mjs';

/**
 * BiDi Firefox는 colorScheme 흉내를 걸지 않아(lib/firefox.mjs) 그 브라우저의 기본 테마로 돈다. 밝은 모드는 기본이 밝을 때만 보고,
 * 어두운 모드와 기본이 어두운 밝은 모드는 까닭을 남기고 건너뛴다(통과로 세지 않는다)
 * @returns {Promise<string | null>} 건너뛸 까닭(없으면 null)
 */
async function bidiSchemeGap(page, browserName, scheme) {
  if (!isBidiFirefox(browserName)) return null;
  if (scheme === 'dark') return 'BiDi Firefox는 prefers-color-scheme 흉내를 걸지 않는다(lib/firefox.mjs)';
  const light = await page.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches);
  return light ? null : 'BiDi Firefox의 기본 테마가 밝지 않아 밝은 모드를 볼 수 없다(흉내가 없다)';
}

const PAGES = ['/', '/my/settings'];

async function look(page, path) {
  const violations = [];
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.effectiveDirective));
  });
  await stubFanApi(page);
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
      osScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
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
    test(`FE-T35 ${path}: 운영체제 ${scheme}를 따르고(키트 바탕·맨 바깥 color-scheme) 색 모드 스크립트가 CSP에 막히지 않는다`, async ({ browser, browserName }) => {
      const ctx = await browser.newContext({ colorScheme: scheme });
      const page = await ctx.newPage();
      const gap = await bidiSchemeGap(page, browserName, scheme);
      if (gap) await ctx.close();
      test.skip(gap !== null, gap ?? '');
      const r = await look(page, path);
      // CI의 Playwright Firefox도 다크 흉내가 화면에 닿지 않는다(CI 42505593522). 볼 수 없는 모드는 통과로 세지 않고 까닭을 남긴다. 나머지 두 엔진은 그대로 실패한다
      if (browserName === 'firefox' && r.osScheme !== scheme) await ctx.close();
      test.skip(browserName === 'firefox' && r.osScheme !== scheme, `이 Firefox는 prefers-color-scheme ${scheme} 흉내가 화면에 닿지 않는다`);
      expect(r.osScheme, '색 모드 흉내가 먹어야 시험이 뜻이 있다').toBe(scheme);
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

  if (path === '/') {
    // 홈 배너(SCR-001): 태블릿·데스크톱에서는 글자가 그림 위 막(scrim)에 놓여 색 모드와 상관없이 흰색이어야 읽힌다(WCAG 1.4.3).
    // 2026-11-05 Chrome 확인에서 밝은 모드 글자가 어두운 막 위에 거의 검정으로 남은 것을 찾았다(테마에 없는 text-white가 CSS를 만들지 않았다)
    test('/: 태블릿·데스크톱 배너의 그림 위 글자는 색 모드와 상관없이 흰색이다(WCAG 1.4.3)', async ({ browser, browserName }) => {
      // 운영 빌드의 홈은 빌드 때 원본이 없어 빈 피드로 그리고, 첫 요청 뒤 ISR(60초)이 새로 그린다(HOT-300). 서버를 막 띄웠으면 배너가 생길 때까지 다시 연다
      test.setTimeout(150_000);
      const gaps = [];
      for (const scheme of ['light', 'dark']) {
        const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        const gap = await bidiSchemeGap(page, browserName, scheme);
        if (gap) {
          test.info().annotations.push({ type: '건너뜀', description: `${scheme}: ${gap}` });
          gaps.push(gap);
          await ctx.close();
          continue;
        }
        await stubFanApi(page);
        const read = () =>
          page.evaluate(() =>
            [...document.querySelectorAll('[class*="bg-(--scrim)"] > span')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => getComputedStyle(e).color),
          );
        let colors = [];
        await expect
          .poll(
            async () => {
              await page.goto(`${WEB_BASE}/`);
              colors = await read();
              return colors.length;
            },
            { message: `${scheme}: 배너가 그려지지 않았다`, timeout: 120_000, intervals: [2_000, 5_000, 10_000] },
          )
          .toBeGreaterThan(0);
        expect([...new Set(colors)], scheme).toEqual(['rgb(255, 255, 255)']);
        await ctx.close();
      }
      // 두 모드 모두 볼 수 없었으면 통과로 세지 않는다
      test.skip(gaps.length === 2, gaps.join(' / '));
    });
  }

  test(`${path}: 글꼴은 Pretendard 동적 서브셋 조각만 받는다(가변 글꼴 전체를 받지 않는다)`, async ({ page }) => {
    const r = await look(page, path);
    expect(r.pretendard).toBe(true);
    expect(r.fonts.length).toBeGreaterThan(0);
    expect(r.fonts.filter((u) => !/subset/i.test(u))).toEqual([]);
  });
}
