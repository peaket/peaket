// F-05-4 스캐너 판정 화면(SCR-033 근무 준비 → SCR-034 판정 → SCR-035 동기화) 화면 시험 설정(계획 docs/review/plans/F-05-4.md §8).
// 먼저 스캐너 운영 빌드를 만든다(`node seed-css/build.mjs scanner` 또는 뿌리에서 `pnpm --filter @peaket/scanner build`). 서버는 운영 빌드 하나(seed-css/apps.mjs scanner).
// 카메라는 Chromium의 가짜 장치이고(--use-fake-device-for-media-stream), BarcodeDetector는 시험이 넣은 대역이 시험이 정한 글자를 돌려준다.
// 스캐너 API(scanner-api.peaket.example)는 page.route로 openapi 모양 응답을 준다. 서버 쪽 실제 연결은 services/ticket-svc/test-int/scanner-f054.int.test.ts가 본다(덧붙임 시험).
// Chromium만 돈다: 가짜 카메라 플래그가 Chromium 것이고, 판정 규칙은 단위 시험이 엔진과 상관없이 본다.
import { defineConfig, devices } from '@playwright/test';
import { APPS, EXTERNAL_SERVERS, portOf, readyPath, serverCommand } from './seed-css/apps.mjs';

const SCANNER = APPS.find((a) => a.name === 'scanner');
const { command, env } = serverCommand(SCANNER, 'prod');

export default defineConfig({
  testDir: './scanner-scan',
  testMatch: /\.spec\.mjs$/,
  timeout: 60_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/scanner-scan.junit.xml' }]],
  use: { locale: 'ko-KR', timezoneId: 'Asia/Seoul', trace: 'retain-on-failure', baseURL: `http://127.0.0.1:${portOf(SCANNER, 'prod')}` },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['camera'],
        launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
      },
    },
  ],
  webServer: EXTERNAL_SERVERS
    ? undefined
    : [{ command, env, url: `http://127.0.0.1:${portOf(SCANNER, 'prod')}${readyPath(SCANNER, 'prod')}`, reuseExistingServer: !process.env.CI, timeout: 120_000, stdout: 'ignore', stderr: 'pipe' }],
});
