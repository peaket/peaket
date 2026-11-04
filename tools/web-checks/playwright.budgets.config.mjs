// 성능 예산 검사(docs/frontend.md §5.8, BUILD_ORDER BAS-220). 먼저 `node seed-css/build.mjs`로 앱 다섯을 운영 빌드한다.
// 프로젝트 js: 첫 화면 HTML이 싣는 JS의 gzip 크기를 §5.8 '첫 JS' 열과 견준다(브라우저를 띄우지 않는다).
// 프로젝트 lighthouse: 대표 주소를 Lighthouse 모바일 기본값(화면 412×823, CPU 4배 느림, 왕복 150ms·1.6Mbps)으로 세 번 재고
// 가운데 값의 LCP·CLS·총 차단 시간을 §5.8 체감 목표와 견준다. 판을 고정한 Playwright 컨테이너의 Chromium으로 돈다(lib/docker.mjs budgets).
import { defineConfig } from '@playwright/test';
import { APPS, EXTERNAL_SERVERS, portOf, readyPath, serverCommand } from './seed-css/apps.mjs';
import { QUEUE_ROOM } from './budgets/pages.mjs';

export default defineConfig({
  testDir: './budgets',
  testMatch: /\.spec\.mjs$/,
  timeout: 180_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/budgets.junit.xml' }], ['json', { outputFile: 'reports/budgets.json' }]],
  use: { trace: 'off', screenshot: 'off' },
  projects: [
    { name: 'js', testMatch: /js\.spec\.mjs$/ },
    { name: 'lighthouse', testMatch: /lighthouse\.spec\.mjs$/ },
  ],
  // 앱마다 운영 빌드 서버 하나(4101~4105)와 대기실 경량 페이지 정적 서버(4106). 밖에서 띄웠으면(lib/docker.mjs) 여기서 띄우지 않는다
  webServer: EXTERNAL_SERVERS
    ? undefined
    : [
        ...APPS.map((app) => {
          const { command, env } = serverCommand(app, 'prod');
          return { command, env, url: `http://127.0.0.1:${portOf(app, 'prod')}${readyPath(app, 'prod')}`, reuseExistingServer: !process.env.CI, timeout: 120_000, stdout: 'ignore', stderr: 'pipe' };
        }),
        { command: QUEUE_ROOM.command, url: `http://127.0.0.1:${QUEUE_ROOM.port}${QUEUE_ROOM.path}`, reuseExistingServer: !process.env.CI, timeout: 60_000, stdout: 'ignore', stderr: 'pipe' },
      ],
});
