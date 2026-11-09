// FE-T40 시각 회귀: React 대기 패널(CMP-015 QueuePanel)과 대기실 셸의 같은 상태를 같은 문턱(0.1%)으로 견준다(docs/frontend.md §6.3, ADR-0220 결정 3).
// 셸 화면을 상태마다 열고(queue-room-states.mjs) 패널 자리(.q-inqueue)를 찍어 기준 이미지로 둔다. Storybook의 QueuePanel 이야기(React가 그린 DOM)에서
// 패널 마크업을 떼어 같은 셸 화면의 그 자리와 바꾸고(같은 CSS·같은 틀) 같은 기준 이미지와 견준다. 이야기의 모델 값은 셸의 고정 값(앞 3,214명·62%·약 2분·5초)과 같다(QueuePanel.stories.tsx).
// 기준 이미지는 셸 시험만 만든다: node lib/docker.mjs visual --update-snapshots[=missing](React 시험은 다시 찍는 실행에서 건너뛰고, 보통 실행에서 셸 이미지와 견준다)
import { test, expect } from '@playwright/test';
import { open } from './queue-room-states.mjs';
import { openStory, STORYBOOK_PORT } from '../ds/stories.mjs';

const STORYBOOK = `http://127.0.0.1:${STORYBOOK_PORT}`;

/**
 * 셸 화면을 연 뒤 시계를 멈춘다(clock.install은 시계를 흐르게 두어, 찍는 사이 폴링·카운트다운이 패널을 고쳐 쓸 수 있다).
 * 곧 입장의 남은 초는 시간에 따라 바뀌는 값이라 두 쪽 모두 5초로 맞춘다(이야기의 모델 값)
 */
async function freeze(page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1));
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.q-inqueue .q-center-block .num.fw-b')) el.textContent = '5초';
  });
}

for (const theme of ['light', 'dark']) {
  for (const id of ['waiting', 'soon', 'paused', 'stale']) {
    test(`FE-T40 대기 패널 셸 ${id} ${theme}: 패널 자리 기준 이미지와 픽셀 차이 0.1% 이하`, async ({ page }) => {
      await open(page, id, theme);
      await freeze(page);
      await expect(page.locator('.q-inqueue')).toHaveScreenshot(`queue-panel-${id}-${theme}.png`);
    });

    test(`FE-T40 대기 패널 React ${id} ${theme}: 같은 상태의 셸 기준 이미지와 픽셀 차이 0.1% 이하`, async ({ page, browser }) => {
      // 기준 이미지를 다시 찍는 실행에서는 돌지 않는다(React 그림이 셸 기준 이미지를 덮어쓰지 않게, 새 기준 이미지는 셸 시험만 만든다)
      test.skip(['all', 'changed'].includes(test.info().config.updateSnapshots), '기준 이미지를 다시 찍는 실행');
      // React가 그린 패널 마크업(Storybook 이야기, 따로 연 문맥의 주소 기준은 Storybook)
      const sb = await browser.newContext({ baseURL: STORYBOOK });
      const story = await sb.newPage();
      await openStory(story, `cmp-015-queuepanel--${id}`, theme);
      const markup = await story.locator('.q-inqueue').evaluate((el) => el.outerHTML);
      await sb.close();
      await open(page, id, theme);
      await freeze(page);
      // 셸의 패널 자리를 React 마크업으로 바꾸고 표지를 단다(찍은 것이 React 마크업인지 뒤에서 본다)
      await page.evaluate((html) => {
        const t = document.createElement('template');
        t.innerHTML = html;
        const el = t.content.firstElementChild;
        el.setAttribute('data-src', 'react');
        document.querySelector('.q-inqueue').replaceWith(el);
      }, markup);
      await expect(page.locator('.q-inqueue[data-src="react"]')).toHaveCount(1);
      await expect(page.locator('.q-inqueue')).toHaveScreenshot(`queue-panel-${id}-${theme}.png`);
      await expect(page.locator('.q-inqueue[data-src="react"]'), '찍는 동안 셸이 패널을 갈아 끼우지 않았다').toHaveCount(1);
    });
  }
}
