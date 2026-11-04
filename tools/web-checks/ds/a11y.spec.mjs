// FE-T18 접근성: @peaket/ds Storybook의 모든 이야기를 라이트·다크로 열어 axe로 검사한다(docs/frontend.md §5.13·§5.17,
// docs/design/d4 #13 'Storybook addon-a11y 검사를 오류 없이 통과'). addon-a11y는 Storybook 화면에서 같은 axe-core로 보이고,
// CI는 판을 고정한 Playwright 컨테이너에서 이 검사로 막는다. 규칙 묶음은 WCAG 2.2 AA까지다(.storybook/preview.tsx의 a11y와 같다).
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openStory, storyEntries } from './stories.mjs';

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

for (const theme of ['light', 'dark']) {
  for (const story of storyEntries()) {
    test(`FE-T18 ${story.id} ${theme}: axe 위반 0`, async ({ page }) => {
      await openStory(page, story.id, theme);
      // Storybook 접근성 애드온이 이야기를 그린 뒤 미리보기 안에서 axe를 스스로 돌린다. 겹치면 'Axe is already running'이라 잠깐 기다려 다시 돌린다
      let result;
      for (let i = 0; ; i++) {
        try {
          result = await new AxeBuilder({ page }).include('#storybook-root').withTags(AXE_TAGS).analyze();
          break;
        } catch (e) {
          if (i >= 10 || !String(e).includes('Axe is already running')) throw e;
          await page.waitForTimeout(200);
        }
      }
      const { violations } = result;
      const summary = violations.map((v) => `${v.id}(${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
      expect(summary).toEqual([]);
    });
  }
}
