// 구매 세션 서명기 세 엔진 검사(FE-T7 브라우저 칸, docs/frontend.md §5.3·§5.17, ADR-0221 결정 7, BUILD_ORDER HOT-360 ①).
// 빌드가 없다: 작은 서버(purchase/server.mjs)가 packages/api-client/src/purchase 원본을 타입만 지워 내준다. 보안 맥락(127.0.0.1)이라
// crypto.subtle·IndexedDB·Web Locks가 다 있다. 기준 판정은 CI와 같은 컨테이너(node lib/docker.mjs purchase)에서 한다.
import { defineConfig, devices } from '@playwright/test';
import { firefoxUse } from './lib/firefox.mjs';

const PORT = 4220;
export default defineConfig({
  testDir: './purchase',
  testMatch: /\.spec\.mjs$/,
  timeout: 60_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/purchase.junit.xml' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off', screenshot: 'off' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: firefoxUse() },
  ],
  webServer: {
    command: `node purchase/server.mjs --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
