// 공지·홈 구성 화면의 운영 빌드 확인(F-03-5 T16, OPS-410·OPS-420, 계획 docs/review/plans/F-03-5.md §5).
// 미리보기 서버는 apps/console-host/dist를 그대로 낸다(CSP·Trusted Types 포함). API는 시험 안에서 가로챈다.
// 빌드 먼저: `PEAKET_OPS_API_ORIGIN=http://127.0.0.1:4134 pnpm --filter @peaket/console-host build`
import { defineConfig, devices } from '@playwright/test';

export const PORT = 4134;

export default defineConfig({
  testDir: './console-notices',
  testMatch: /\.spec\.mjs$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node ../../apps/console-host/scripts/preview-server.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
