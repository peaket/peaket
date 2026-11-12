// FE-T31 재배치·확대·글자 간격 시험(docs/frontend.md §5.11·§5.17, WCAG 1.4.10·1.4.4·1.4.12).
// 운영 빌드의 주요 흐름을 320×256(400% 확대)·640×400(200% 확대)에서 열고, 예외 상자 밖의
// 문서 가로 스크롤과 글자 잘림을 센다. 글자 간격은 CSP를 끄지 않도록 CSSOM adoptedStyleSheets로 넣는다.
// 브라우저 확인은 웨이브 끝 heavy gate에서 돌린다(BUILD_ORDER BAT-170).
import { test, expect } from '@playwright/test';
import { APPS, HOST, portOf } from '../seed-css/apps.mjs';
import { stubFanApi } from '../csp/pages.mjs';
import { EXCEPTION_SELECTORS, REFLOW_PAGES, TEXT_SPACING_CSS, clippedTextFindings, hasPageOverflow } from './rules.mjs';

const BASE = Object.fromEntries(APPS.map((a) => [a.name, `http://${HOST}:${portOf(a, 'prod')}`]));
const IGNORE = '.sr-only,[aria-hidden="true"],.ellipsis,svg,canvas';

test.beforeEach(async ({ page }) => {
  await stubFanApi(page);
});

for (const p of REFLOW_PAGES) {
  test(`FE-T31 ${p.app} ${p.path}: 예외 밖 문서 가로 스크롤 0, 글자 잘림·겹침 0`, async ({ page }) => {
    const res = await page.goto(`${BASE[p.app]}${p.path}`, { waitUntil: 'networkidle' });
    expect(res?.status(), `${p.app}${p.path}`).toBeLessThan(400);

    await page.evaluate((css) => {
      const sheet = new CSSStyleSheet();
      for (const rule of css.split('}').map((r) => r.trim()).filter(Boolean)) sheet.insertRule(`${rule}}`);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }, TEXT_SPACING_CSS);

    const metrics = await page.evaluate(
      ({ exceptions, ignore }) => {
        const isException = (el) => exceptions.some((sel) => el.closest(sel));
        const items = [];
        for (const el of document.querySelectorAll('body *')) {
          if (isException(el) || el.closest(ignore)) continue;
          const hasText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0);
          if (!hasText) continue;
          const cs = getComputedStyle(el);
          items.push({
            tag: el.tagName,
            cls: typeof el.className === 'string' ? el.className : '',
            text: true,
            overflow: cs.overflow,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          });
        }
        return { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, items };
      },
      { exceptions: EXCEPTION_SELECTORS, ignore: IGNORE },
    );

    expect(hasPageOverflow(metrics), `${p.app}${p.path} 문서 가로 스크롤`).toBe(false);
    expect(clippedTextFindings(metrics.items), `${p.app}${p.path} 글자 잘림`).toEqual([]);
  });
}
