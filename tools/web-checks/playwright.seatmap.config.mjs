// 5만 석 좌석맵 PoC K5(BUILD_ORDER BAS-190, wbs 0.5.4, docs/frontend.md §5.2·§6.3). 설계를 고르는 측정이라 단계 안에서 잰다.
// 판정은 K5 랩 조건(중급 모바일 412×915·배율 2.625, Chromium CPU 4배 느리게, docs/verification.md §3.10 K5)에서만 하고
// 나머지 엔진(느리게 하지 않음)은 기록만 남긴다. iOS 실기기 확인은 소유자 몫이라 확인 목록만 둔다(seatmap/RESULT.md).
import { defineConfig, devices } from '@playwright/test';

const PORT = 4120;
const K5 = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625 };

export default defineConfig({
  testDir: './seatmap',
  testMatch: /\.spec\.mjs$/,
  timeout: 120_000,
  workers: 1,
  // 한 번 잰 값은 우연에 흔들려 다섯 번 재고 중앙값·최댓값을 본다(K5 랩은 20회 p75, docs/verification.md §3.10). 판정은 매번 한다
  repeatEach: 5,
  globalSetup: './seatmap/setup.mjs',
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/seatmap.junit.xml' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off' },
  projects: [
    { name: 'chromium-k5', use: { ...devices['Desktop Chrome'], ...K5, isMobile: true, hasTouch: true }, metadata: { throttle: 4, judge: true } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...K5 } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], ...K5 } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], ...K5 } },
  ],
  webServer: {
    // 캐시하게 두고(대기 중에 미리 받아 둔 HTTP 캐시 길), 배치 파일은 미리 압축한 layout.json.br을 Content-Encoding: br로 준다
    command: `node lib/serve.mjs --root seatmap/page --port ${PORT} --cache-control max-age=3600`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
