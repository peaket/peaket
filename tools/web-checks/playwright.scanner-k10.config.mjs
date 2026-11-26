// F-05-9 K10 측정 실행 설정(계획 docs/review/plans/F-05-9.md §5).
// 스캐너 운영 빌드를 띄우고 Chromium 하나로 10분 창을 잰다. 평소 CI에서는 쓰지 않는다.
// 실행: K10_MEASURE=1 pnpm exec playwright test -c playwright.scanner-k10.config.mjs
// 서버를 밖에서 이미 띄웠으면 PEAKET_WEB_CHECKS_SERVERS=external을 준다.
import { defineConfig, devices } from '@playwright/test';
import { APPS, EXTERNAL_SERVERS, portOf, readyPath, serverCommand } from './seed-css/apps.mjs';

const SCANNER = APPS.find((a) => a.name === 'scanner');
const { command, env } = serverCommand(SCANNER, 'prod');

export default defineConfig({
  testDir: './scanner-k10',
  testMatch: /k10-measure\.spec\.mjs$/,
  timeout: 20 * 60_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/scanner-k10.junit.xml' }]],
  use: {
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'retain-on-failure',
    baseURL: `http://127.0.0.1:${portOf(SCANNER, 'prod')}`,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['camera'],
        launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
      },
    },
  ],
  webServer: EXTERNAL_SERVERS
    ? undefined
    : [
        {
          command,
          env,
          url: `http://127.0.0.1:${portOf(SCANNER, 'prod')}${readyPath(SCANNER, 'prod')}`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: 'ignore',
          stderr: 'pipe',
        },
      ],
});
