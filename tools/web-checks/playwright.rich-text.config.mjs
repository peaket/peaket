// FE-T41 서식 글 편집기 PoC(BUILD_ORDER HOT-322, docs/frontend.md FE-T41). 파트너 콘솔 PoC 빌드(node rich-text/build.mjs)를 띄워
// 묶음 B CSP·Trusted Types 보고 모드(apps/partner/proxy.ts)에서 후보 둘(Lexical·Tiptap)을 연다. 결과는 rich-text/RESULT.md에 남긴다.
// 컨테이너(CI와 같은 판의 세 엔진): 이 PC에서 PoC 서버를 띄워 두고(README 'rich-text') `node lib/docker.mjs rich-text`.
import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { firefoxUse } from './lib/firefox.mjs';
import { EXTERNAL_SERVERS, HOST } from './seed-css/apps.mjs';

const PORT = 4122;

export default defineConfig({
  testDir: './rich-text',
  testMatch: /\.spec\.mjs$/,
  timeout: 60_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/rich-text.junit.xml' }]],
  use: { baseURL: `http://${HOST}:${PORT}`, trace: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    // 이 PC(Windows)에서는 Playwright 판 Firefox가 뜨지 않아 PEAKET_FIREFOX=system을 꼭 붙인다(설치한 정식 Firefox, lib/firefox.mjs, RESULT.md)
    { name: 'firefox', use: firefoxUse() },
  ],
  webServer: EXTERNAL_SERVERS
    ? undefined
    : {
        command: `pnpm --dir ../../apps/partner exec next start -p ${PORT}`,
        env: { PEAKET_NEXT_DIST: '.next-rich-text', NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64') },
        url: `http://127.0.0.1:${PORT}/poc/rich-text`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
