// 5만 석 좌석 화면 시나리오(S-T21·S-T31 ⑥, BAT-182). Chromium 한 엔진이다(감독 결정 2026-11-20: 3엔진은 이 묶음 범위 밖).
// 먼저 tools/web-checks에서 `node seed-css/build.mjs web`으로 웹 운영 빌드를 만들어 둔다(CI seats 잡과 같다).
// 이 시험은 제품 화면 대신 @peaket/seatmap Worker·엔진·연결을 그대로 쓰는 시험 페이지(seats/page)를 돌린다.
// 서버는 Docker 없는 realtime-gw 대역(seats/server.mjs)이고 5만 석 파일·스냅샷·구독/닫힘 기록을 낸다.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4130;

export default defineConfig({
  testDir: './seats',
  testMatch: /\.spec\.mjs$/,
  timeout: 120_000,
  // 시나리오가 서버 기록을 공유하므로 한 번에 하나만 돈다(각 시험이 /__seats/reset으로 시작한다)
  workers: 1,
  forbidOnly: !!process.env.CI,
  globalSetup: './seats/setup.mjs',
  reporter: [['list'], ['junit', { outputFile: 'reports/seats.junit.xml' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off', screenshot: 'off', viewport: { width: 1400, height: 1000 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 1000 } } }],
  webServer: {
    command: `node seats/server.mjs --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
