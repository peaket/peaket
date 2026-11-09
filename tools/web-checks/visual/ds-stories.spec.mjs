// FE-T40 시각 회귀: @peaket/ds Storybook의 모든 이야기(부품 상태마다 하나) × 라이트·다크(docs/design/d2 §1, docs/frontend.md §5.17).
// 기준 이미지는 판을 고정한 컨테이너(node lib/docker.mjs visual --update-snapshots)에서만 만든다.
// 부품 속을 SEED 동작 부품으로 바꾸는 BAS-180은 바꾸기 전 키트 구현으로 기준 이미지를 먼저 만들고, 바꾼 뒤 같은지 본다(ADR-0192).
import { test, expect } from '@playwright/test';
import { openStory, storyEntries, STORYBOOK_PORT } from '../ds/stories.mjs';

const BASE = `http://127.0.0.1:${STORYBOOK_PORT}`;
// 시간에 따라 바뀌는 이야기(알림이 사라지기 등)는 열자마자 찍는다. 움직임은 설정의 animations: 'disabled'로 멈춘다
test.use({ viewport: { width: 800, height: 600 }, baseURL: BASE });

for (const theme of ['light', 'dark']) {
  for (const story of storyEntries()) {
    test(`FE-T40 ds ${story.id} ${theme}: 기준 이미지와 픽셀 차이 0.1% 이하`, async ({ page }) => {
      await openStory(page, story.id, theme);
      await expect(page).toHaveScreenshot(`ds-${story.id}-${theme}.png`, { fullPage: true });
    });
  }
}
