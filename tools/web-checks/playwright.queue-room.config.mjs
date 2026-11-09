// 대기실 T=0 세 엔진 검사(FE-T3·FE-T15·FE-T4 브라우저 칸, docs/frontend.md §5.17, ADR-0217, BUILD_ORDER HOT-347).
// 먼저 `node queue-room/build.mjs`로 대기실 검사 빌드(dist-check)를 만든다. 서버는 검사용 가짜 API(4011)와 같은 출처 검사 틀(4130)이다.
// 사전 요청(OPTIONS)·요청 간격·끊긴 시각은 가짜 API의 검사 기록(GET /__mock/requests)으로 센다. Playwright가 가로챈 경로의 사전 요청에
// 스스로 답하므로 이 검사는 page.route를 쓰지 않는다. 서버는 보안 맥락(127.0.0.1)에 붙는다(Web Locks·crypto.subtle).
import { defineConfig, devices } from '@playwright/test';
import { firefoxUse } from './lib/firefox.mjs';
import { CHECK_MOCK_PORT, CHECK_ORIGIN } from './queue-room/origins.mjs';

export default defineConfig({
  testDir: './queue-room',
  testMatch: /\.spec\.mjs$/,
  timeout: 90_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/queue-room.junit.xml' }]],
  use: { baseURL: CHECK_ORIGIN, locale: 'ko-KR', timezoneId: 'Asia/Seoul', trace: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: firefoxUse() },
  ],
  webServer: [
    {
      command: `node ../../apps/web/scripts/mock-api.mjs ${CHECK_MOCK_PORT}`,
      env: { PEAKET_QUEUE_ROOM_ORIGIN: CHECK_ORIGIN, PEAKET_WEB_ORIGIN: CHECK_ORIGIN },
      url: `http://127.0.0.1:${CHECK_MOCK_PORT}/v1/home`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    { command: 'node lib/same-origin.mjs', url: `${CHECK_ORIGIN}/_q/shell.ko.html`, reuseExistingServer: !process.env.CI, timeout: 30_000, stdout: 'ignore', stderr: 'pipe' },
  ],
});
