// FE-T36 ④: 탐침 화면(packages/ds/src/poc/SeedLayerProbe.tsx)의 계산된 스타일을 세 엔진에서 본다(docs/frontend.md §5.17).
// - Tailwind 유틸(px-8 = 32px)이 같은 요소의 SEED 부품(action-button의 자기 여백)을 이긴다: utilities 층 > seed-components 층
// - Tailwind 초기화(base 층의 button 배경 투명)가 SEED 부품 배경을 덮지 않고, 피켓 토큰(components 층)이 SEED 브랜드 색을 덮는다
import { test, expect } from '@playwright/test';
import { APPS, HOST, portOf } from './apps.mjs';
import { semanticColor, rgb } from '../lib/canon.mjs';

const primary = rgb(semanticColor('light', 'primary'));

for (const app of APPS) {
  test(`FE-T36 ④ ${app.name}: 같은 요소의 Tailwind 유틸이 SEED 부품을 이기고 Tailwind 초기화가 SEED 부품을 덮지 않는다`, async ({ page }) => {
    await page.goto(`http://${HOST}:${portOf(app, 'poc')}${app.probe}`);
    await expect(page.locator('[data-probe="seed-only"]')).toBeVisible();
    const s = await page.evaluate(() => {
      const el = (p) => document.querySelector(`[data-probe="${p}"]`);
      const util = getComputedStyle(el('seed-util'));
      const only = getComputedStyle(el('seed-only'));
      return { classes: el('seed-only').className, utilPad: util.paddingLeft, onlyPad: only.paddingLeft, utilBg: util.backgroundColor, onlyBg: only.backgroundColor };
    });
    expect(s.classes).toContain('seed-action-button');
    expect(s.utilPad, '유틸(px-8)이 SEED 부품 여백을 이겨야 한다').toBe('32px');
    expect(s.onlyPad, 'SEED 부품만 준 버튼은 SEED 여백이어야 한다').not.toBe('32px');
    expect(Number.parseFloat(s.onlyPad), 'SEED 부품 CSS가 실려야 한다').toBeGreaterThan(0);
    expect(s.onlyBg, 'Tailwind 초기화가 SEED 배경을 덮거나 피켓 토큰이 SEED 색을 덮지 못했다').toBe(primary);
    expect(s.utilBg).toBe(primary);
  });
}

// SEED base의 :root·[data-seed-color-mode="system"]{color-scheme: light dark}가 밝은 화면의 맨 바깥(스크롤바·입력 칸)을
// 운영체제 다크에 따라 어둡게 그리지 않는지(리뷰 2026-11-04 중간 4 재현). 키트 테마(.pk·.pk.dark)를 따르고, 스캐너는 light only다
for (const app of APPS) {
  test(`SEED base를 실어도 ${app.name} 루트 color-scheme은 키트 테마를 따른다(운영체제 다크에서도)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`http://${HOST}:${portOf(app, 'poc')}${app.probe}`);
    await expect(page.locator('[data-probe="seed-only"]')).toBeVisible();
    const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    expect(scheme).toBe(app.name === 'scanner' ? 'light only' : 'light');
  });
}
