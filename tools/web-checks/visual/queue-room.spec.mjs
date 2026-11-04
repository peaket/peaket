// FE-T40 시각 회귀: 대기실 경량 페이지 셸의 네 상태(waiting·soon·paused·stale) × 라이트·다크(docs/frontend.md §5.17).
// 셸은 퍼블리싱 단계라 `?state=`(캔버스 보드 상태 이름)로 상태를 고르고 `?theme=dark`로 다크를 켠다(apps/web/queue-room/src/states.ts).
// 남은 시간은 Date.now() 기준 상대값이라 시각을 고정하고, CSS 움직임은 멈춘 채 찍는다.
import { test, expect } from '@playwright/test';

/** [시험 ID에 쓰는 상태 이름, 셸의 상태 이름(QUEUE_STATES)] */
const STATES = [
  ['waiting', '대기 중'],
  ['soon', '곧 입장'],
  ['paused', '일시정지'],
  ['stale', '연결 확인 중'],
];
const FIXED_NOW = new Date('2026-11-04T10:00:00+09:00');

for (const theme of ['light', 'dark']) {
  for (const [id, name] of STATES) {
    test(`FE-T40 대기실 셸 ${id} ${theme}: 기준 이미지와 픽셀 차이 0.1% 이하`, async ({ page }) => {
      await page.clock.setFixedTime(FIXED_NOW);
      const q = new URLSearchParams({ state: name });
      if (theme === 'dark') q.set('theme', 'dark');
      await page.goto(`/queue/evt-lumen-2026?${q}`);
      await expect(page.locator('.q-boot')).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`queue-room-${id}-${theme}.png`, { fullPage: true });
    });
  }
}
