// FE-T41 서식 글 편집기 PoC(BUILD_ORDER HOT-322, docs/frontend.md FE-T41). 파트너 콘솔 PoC 빌드(node rich-text/build.mjs)를 띄워
// 묶음 B CSP·Trusted Types 보고 모드(apps/partner/proxy.ts)에서 후보 둘(Lexical·Tiptap)을 연다. 결과는 rich-text/RESULT.md에 남긴다.
import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const PORT = 4122;

export default defineConfig({
  testDir: './rich-text',
  testMatch: /\.spec\.mjs$/,
  timeout: 60_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/rich-text.junit.xml' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    // Firefox는 이 PC에서 Playwright가 뜨지 않아(spawn UNKNOWN) 아직 재지 않았다. CI 잡을 둘 때 더한다(RESULT.md)
  ],
  webServer: {
    command: `pnpm --dir ../../apps/partner exec next start -p ${PORT}`,
    env: { PEAKET_NEXT_DIST: '.next-rich-text', NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64') },
    url: `http://127.0.0.1:${PORT}/poc/rich-text`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
