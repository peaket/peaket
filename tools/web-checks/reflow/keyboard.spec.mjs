// FE-T18 자동 몫: 초점 가림(WCAG 2.4.11, docs/frontend.md §5.11 '초점이 가려지지 않게'·§5.17 '화면 매트릭스와 FE-T31·FE-T18 자동 몫의 세부',
// docs/design/d4-handoff-checklist.md #22). 같은 화면에서 Tab으로 초점을 옮길 때마다 초점 요소 상자가 position fixed·sticky인
// 다른 요소의 상자에 완전히 덮이면 실패다. 320×256과 기본 폭에서 돈다.
// BAT-170 웨이브 7: 시험 담당(l2w7-BAT170-test)이 구현(셸 scroll-padding) 전에 썼다(ADR-0270 결정 3). 실행은 웨이브 끝 무거운 게이트(계획 §7).
import { test, expect } from '@playwright/test';
import { APPS, HOST, portOf } from '../seed-css/apps.mjs';
import { stubFanApi } from '../csp/pages.mjs';
import { REFLOW_PAGES, obscuredFocusFindings } from './rules.mjs';

const BASE = Object.fromEntries(APPS.map((a) => [a.name, `http://${HOST}:${portOf(a, 'prod')}`]));
/** Tab을 이만큼까지 누른다(처음 초점으로 돌아오면 멈춘다) [가정] */
const MAX_TABS = 80;

test.beforeEach(async ({ page }) => {
  await stubFanApi(page);
});

/** 지금 초점 요소 상자와, 그 요소를 품지 않는 fixed·sticky 요소들의 상자(뷰포트 좌표) */
const focusStep = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const box = (e, id) => {
      const r = e.getBoundingClientRect();
      return { id, left: r.left, top: r.top, width: r.width, height: r.height };
    };
    const label = (e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className ? `.${e.className.split(/\s+/).slice(0, 2).join('.')}` : ''}`;
    const fixed = [];
    for (const f of document.querySelectorAll('body *')) {
      if (f === el || f.contains(el) || el.contains(f)) continue;
      const cs = getComputedStyle(f);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const b = box(f, label(f));
      if (b.width > 0 && b.height > 0) fixed.push(b);
    }
    return { target: box(el, `${label(el)} ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}`), fixed };
  });

for (const p of REFLOW_PAGES) {
  for (const size of ['320', '기본 폭']) {
    test(`FE-T18 ${p.app} ${p.locale} ${p.path} ${size}: Tab으로 옮긴 초점이 고정 머리·하단 바에 다 가려지지 않는다`, async ({ page }) => {
      // 입장이 있어야 그리는 화면(좌석)은 항목의 탭 저장소 값을 먼저 넣는다(계획 §11 2, reflow.spec과 같다)
      if (p.sessionStorage) {
        await page.addInitScript((entries) => {
          try {
            for (const [k, v] of Object.entries(entries)) if (sessionStorage.getItem(k) === null) sessionStorage.setItem(k, v);
          } catch {
            /* about:blank에는 저장소가 없다 */
          }
        }, p.sessionStorage);
      }
      const res = await page.goto(`${BASE[p.app]}${p.path}`, { waitUntil: 'networkidle' });
      expect(res?.status(), `${p.app}${p.path}`).toBeLessThan(400);
      const u = new URL(page.url());
      expect(`${u.pathname}${u.search}`, '도착 경로가 다르다(빈 결과)').toBe(p.path);
      await page.evaluate(() => window.scrollTo(0, 0));
      const steps = [];
      let first;
      for (let i = 0; i < MAX_TABS; i++) {
        await page.keyboard.press('Tab');
        const id = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          if (!el.dataset.fet18) el.dataset.fet18 = String(Math.random()).slice(2);
          return el.dataset.fet18;
        });
        if (id === null) continue;
        if (id === first) break;
        first ??= id;
        const s = await focusStep(page);
        if (s) steps.push(s);
      }
      expect(steps.length, 'Tab으로 초점을 받은 요소가 없다(빈 결과)').toBeGreaterThan(0);
      expect(obscuredFocusFindings(steps), '고정 요소에 다 가려진 초점').toEqual([]);
    });
  }
}
