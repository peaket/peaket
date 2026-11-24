// F-03-4 실제 서버 화면 시험(T13~T16, 계획 §8). 한 프로세스에 받는 쪽 넷(bundle)을, 실제 프로세스로 identity-svc·ops-svc를 띄우고
// 운영 빌드 콘솔을 미리보기 서버로 낸다(console-commands/stage.mjs). 실행: tools/web-checks에서 `pnpm run console-commands`.
// Docker는 docker-2 자리만 쓴다(stage.mjs가 owner.txt를 확인한다). 실행마다 컨테이너를 `docker rm -f -v`로 지운다.
import { defineConfig, devices } from '@playwright/test';

export const PREVIEW_PORT = 4280;
export const STAGE_PORT = 4281;
export const PREVIEW_ORIGIN = `http://localhost:${PREVIEW_PORT}`;

export default defineConfig({
  testDir: './console-commands',
  testMatch: /commands\.spec\.mjs$/,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/console-commands.junit.xml' }]],
  use: { baseURL: PREVIEW_ORIGIN, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node console-commands/stage.mjs',
      url: `http://127.0.0.1:${STAGE_PORT}/health`,
      // 로컬에서 무대를 손으로 띄워 두고 반복할 때는 그 무대를 쓴다. CI는 늘 새로 띄운다
      reuseExistingServer: !process.env.CI,
      timeout: 420_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
