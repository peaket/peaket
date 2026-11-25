// 좌석맵 랩(F-08-1, docs/frontend.md §5.8 '판정은 둘로 나눈다'·FE-T10). Docker·kind 없이 이 PC의 Playwright Chromium으로 돈다.
// 먼저 `pnpm run seatmap-lab`(seats/setup.mjs가 5만 석 배치와 시험 페이지를 만든다). 회차는 PEAKET_LAB_REPS(기본 §5.8의 20회)다.
// 결과는 reports/seats-lab/(worker.json·canvas.json·summary.json·report.md). 정식 판정은 20회를 채운 값만 쓴다.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4131;
export default defineConfig({
  testDir: './seats',
  testMatch: /lab\.spec\.mjs$/,
  // 20회 × 2모드 + 보고서. 한 회차가 수 초라 30분을 둔다
  timeout: 1_800_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  globalSetup: './seats/setup.mjs',
  reporter: [['list'], ['junit', { outputFile: 'reports/seatmap-lab.junit.xml' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off', screenshot: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 412, height: 823 }, deviceScaleFactor: 2.625 } }],
  webServer: {
    command: `node seats/server.mjs --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
