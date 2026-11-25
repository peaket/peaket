// F-03-6(FE-T29) ③ 격리 화면 검사. 먼저 두 운영 빌드를 만든다(console-baseline/global-setup.mjs, reports/console-baseline/builds/).
// 실행: cd tools/web-checks && corepack pnpm run console-baseline (이 폴더). Docker·kind를 쓰지 않는다.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './console-baseline',
  testMatch: /isolation\.spec\.mjs$/,
  globalSetup: './console-baseline/global-setup.mjs',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/console-baseline.junit.xml' }]],
  use: { trace: 'retain-on-failure', viewport: { width: 1440, height: 900 } },
});
