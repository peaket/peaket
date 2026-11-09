// @peaket/ds 부품 검사: 접근성 FE-T18(axe, 모든 이야기 × 라이트·다크)과 동작(이유 있는 비활성 버튼·대화상자·탭·입력)을
// Storybook 정적 빌드(tools/storybook/storybook-static)로 세 엔진에서 본다(docs/frontend.md §5.17, BUILD_ORDER BAS-180).
// 컨테이너: node lib/docker.mjs ds. 이 PC에서 연습: pnpm exec playwright test -c playwright.ds.config.mjs
import { defineConfig, devices } from '@playwright/test';
import { firefoxUse } from './lib/firefox.mjs';
import { STORYBOOK_PORT } from './ds/stories.mjs';

export default defineConfig({
  testDir: './ds',
  testMatch: /\.spec\.mjs$/,
  timeout: 30_000,
  workers: process.env.CI ? 2 : 4,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/ds.junit.xml' }]],
  use: { baseURL: `http://127.0.0.1:${STORYBOOK_PORT}`, locale: 'ko-KR', timezoneId: 'Asia/Seoul', trace: 'off', viewport: { width: 800, height: 600 } },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 800, height: 600 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 800, height: 600 } }, testIgnore: /a11y\.spec/ },
    { name: 'firefox', use: firefoxUse({ viewport: { width: 800, height: 600 } }), testIgnore: /a11y\.spec/ },
  ],
  webServer: {
    command: `node lib/serve.mjs --root ../storybook/storybook-static --port ${STORYBOOK_PORT} --cache-control no-store`,
    url: `http://127.0.0.1:${STORYBOOK_PORT}/index.json`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
