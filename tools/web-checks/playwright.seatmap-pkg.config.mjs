// @peaket/seatmap 브라우저 검사(BUILD_ORDER HOT-120). 먼저 `pnpm --filter @peaket/seatmap demo:build`로 시연 페이지를 만든다.
// 세 엔진에서 시연 페이지를 열어 그리기·누르기·미니맵을 보고, Chromium에서 첫 그림 시각을 성능 추적과 맞춰 본다.
// Windows의 Playwright Firefox·WebKit은 판 문제·OffscreenCanvas 없음이 있어, 기준 판정은 컨테이너(node lib/docker.mjs seatmap-pkg)에서 한다.
import { defineConfig, devices } from '@playwright/test';
import { firefoxUse } from './lib/firefox.mjs';

const PORT = 4210;
export default defineConfig({
  testDir: './seatmap-pkg',
  testMatch: /\.spec\.mjs$/,
  timeout: 60_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/seatmap-pkg.junit.xml' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 800, height: 600 }, trace: 'off', screenshot: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 800, height: 600 } } },
    { name: 'firefox', use: firefoxUse({ viewport: { width: 800, height: 600 } }) },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 800, height: 600 } } },
  ],
  webServer: {
    command: `node lib/serve.mjs --root ../../packages/seatmap/dist-demo --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
