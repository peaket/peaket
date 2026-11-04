// 시각 회귀 FE-T40(docs/frontend.md §5.17, docs/design/d2 §1 '버전 관리 및 시각 회귀 테스트', BUILD_ORDER BAS-170).
// 기준 이미지는 판을 고정한 Playwright 컨테이너(lib/docker.mjs의 IMAGE, CI 화면 잡과 같다)에서만 찍고 견준다.
// 다른 OS에서 돌리면 그리기가 달라 실패하므로 막는다(PEAKET_VISUAL_ANY_OS=1이면 연습으로만 돌린다).
// 대기실 경량 페이지 셸 네 상태와 @peaket/ds Storybook 이야기(BAS-180, visual/ds-stories.spec.mjs)다. 같은 상태의 React 대기 화면(HOT-340)을 같은 틀에 더한다.
import { defineConfig, devices } from '@playwright/test';
import { STORYBOOK_PORT } from './ds/stories.mjs';

if (process.platform !== 'linux' && process.env.PEAKET_VISUAL_ANY_OS !== '1') {
  throw new Error('FE-T40 기준 이미지는 리눅스 Playwright 컨테이너에서만 견준다: node lib/docker.mjs visual');
}

const PORT = 4110;
/** 휴대폰 시안 기준 폭(d2 §1 '재배치와 글자 확대') */
const PHONE = { viewport: { width: 360, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };

export default defineConfig({
  testDir: './visual',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  timeout: 60_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/visual.junit.xml' }]],
  expect: {
    // 픽셀 차이 비율 문턱 0.1% [가정](FE-T40 통과 기준)
    toHaveScreenshot: { maxDiffPixelRatio: 0.001, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  use: { baseURL: `http://127.0.0.1:${PORT}`, locale: 'ko-KR', timezoneId: 'Asia/Seoul', trace: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...PHONE } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], ...PHONE } },
  ],
  webServer: [
    {
      command: `node lib/serve.mjs --root ../../apps/web/queue-room/dist --port ${PORT} --preset queue-room`,
      url: `http://127.0.0.1:${PORT}/queue/evt-lumen-2026`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // @peaket/ds Storybook 정적 빌드(tools/storybook에서 pnpm run build)
      command: `node lib/serve.mjs --root ../storybook/storybook-static --port ${STORYBOOK_PORT} --cache-control no-store`,
      url: `http://127.0.0.1:${STORYBOOK_PORT}/index.json`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
