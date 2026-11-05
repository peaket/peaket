// SEED CSS 층 검사 FE-T36(docs/frontend.md §5.17, BUILD_ORDER BAS-170). 먼저 `node seed-css/build.mjs`로 앱 다섯을 운영 빌드·PoC 빌드한다.
// 프로젝트 css: 첫 화면 HTML이 싣는 CSS를 받아 ①②③와 크기를 본다(브라우저를 띄우지 않는다).
// 프로젝트 layers-*: 탐침 화면의 계산된 스타일로 ④를 세 엔진에서 본다.
import { defineConfig, devices } from '@playwright/test';
import { APPS, BUILDS, EXTERNAL_SERVERS, mockApiServer, portOf, readyPath, serverCommand } from './seed-css/apps.mjs';

export default defineConfig({
  testDir: './seed-css',
  testMatch: /\.spec\.mjs$/,
  timeout: 60_000,
  workers: 1,
  globalSetup: './seed-css/setup.mjs',
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/seed-css.junit.xml' }], ['json', { outputFile: 'reports/seed-css.json' }]],
  use: { trace: 'off', screenshot: 'off' },
  projects: [
    { name: 'css', testMatch: /css\.spec\.mjs$/ },
    { name: 'layers-chromium', testMatch: /layers\.spec\.mjs$/, use: { ...devices['Desktop Chrome'] } },
    { name: 'layers-firefox', testMatch: /layers\.spec\.mjs$/, use: { ...devices['Desktop Firefox'] } },
    { name: 'layers-webkit', testMatch: /layers\.spec\.mjs$/, use: { ...devices['Desktop Safari'] } },
  ],
  // 서버를 밖에서 띄웠으면(lib/docker.mjs: 컨테이너 안 브라우저가 이 PC의 서버를 본다) 여기서 띄우지 않는다
  // 앱마다 서버 둘(운영 빌드 4101~4105, PoC 빌드 4111~4115)
  webServer: EXTERNAL_SERVERS
    ? undefined
    : [
        mockApiServer(),
        ...APPS.flatMap((app) =>
          Object.keys(BUILDS).map((build) => {
            const { command, env } = serverCommand(app, build);
            const url = `http://127.0.0.1:${portOf(app, build)}${readyPath(app, build)}`;
            return { command, env, url, reuseExistingServer: !process.env.CI, timeout: 120_000, stdout: 'ignore', stderr: 'pipe' };
          }),
        ),
      ],
});
