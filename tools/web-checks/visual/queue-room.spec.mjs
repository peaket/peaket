// FE-T40 시각 회귀: 대기실 경량 페이지 셸의 네 상태(waiting·soon·paused·stale) × 라이트·다크(docs/frontend.md §5.17).
// 셸은 데이터에 이었다(ADR-0207): `?state=` 대신 대기열·공연 공개 요약 호출을 가로채 실제 상태 기계로 네 상태를 만든다.
// 값은 퍼블리싱 기준 이미지와 같게 둔다(LUMEN, 앞 3,214명, 진행 62%, 약 2분). '곧 입장'만 계약 범위(retryAfterSeconds 1~5)의 5초다.
// 시계는 Playwright clock으로 고정·진행하고, 지터를 없애려고 Math.random을 고정한다. CSS 움직임은 멈춘 채 찍는다.
import { test, expect } from '@playwright/test';
import { open } from './queue-room-states.mjs';

for (const theme of ['light', 'dark']) {
  for (const id of ['waiting', 'soon', 'paused', 'stale']) {
    test(`FE-T40 대기실 셸 ${id} ${theme}: 기준 이미지와 픽셀 차이 0.1% 이하`, async ({ page }) => {
      await open(page, id, theme);
      await expect(page).toHaveScreenshot(`queue-room-${id}-${theme}.png`, { fullPage: true });
    });
  }
}
