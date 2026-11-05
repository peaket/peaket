// 소비자 웹 CSP 검사(FE-T35·FE-T30, 캐시 화면 SRI PoC, docs/frontend.md §5.14.1·§6.3, BUILD_ORDER HOT-290).
// 먼저 `node seed-css/build.mjs web`으로 운영 빌드한다. 서버는 운영 빌드 하나(seed-css/apps.mjs web, 4101)이고 proxy.ts가 운영 헤더를 단다.
// 컨테이너: 이 PC에서 `node seed-css/serve-all.mjs --budgets`(또는 web 서버 하나)를 띄우고 `node lib/docker.mjs csp`.
import { defineConfig, devices } from '@playwright/test';
import { firefoxUse } from './lib/firefox.mjs';
import { EXTERNAL_SERVERS, mockApiServer, portOf, readyPath, serverCommand } from './seed-css/apps.mjs';
import { WEB } from './csp/pages.mjs';

const { command, env } = serverCommand(WEB, 'prod');

export default defineConfig({
  testDir: './csp',
  testMatch: /\.spec\.mjs$/,
  timeout: 60_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/csp.junit.xml' }]],
  use: { locale: 'ko-KR', timezoneId: 'Asia/Seoul', trace: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: firefoxUse() },
  ],
  webServer: EXTERNAL_SERVERS
    ? undefined
    : [mockApiServer(), { command, env, url: `http://127.0.0.1:${portOf(WEB, 'prod')}${readyPath(WEB, 'prod')}`, reuseExistingServer: !process.env.CI, timeout: 120_000, stdout: 'ignore', stderr: 'pipe' }],
});
