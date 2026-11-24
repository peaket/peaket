// F-03-4 브라우저 확인(계획 §9, OPS-390): 실제 무대를 그대로 쓰고 시스템 Chrome을 Playwright로 몬다.
// 패스키는 브라우저 확인의 정본 범위 밖이지만(architecture §8.6 8) 이 gate 지시로 가상 인증기(CDP WebAuthn)를 쓴다.
import { defineConfig, devices } from '@playwright/test';

export const PREVIEW_PORT = 4280;
export const STAGE_PORT = 4281;

export default defineConfig({
  testDir: './console-commands',
  testMatch: /browser-check\.spec\.mjs$/,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PREVIEW_PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  webServer: [
    {
      command: 'node console-commands/stage.mjs',
      url: `http://127.0.0.1:${STAGE_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 420_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
