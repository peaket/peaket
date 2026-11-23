// F-05-5 스캐너 기기 등록 화면(SCR-036 /enroll) 진입 시험 설정(docs/features/offline-gate.md §6.1 'GAT-170 마감 규칙' 마지막 줄, O-T37 ①, 시험 리뷰 1 TR-01).
// 먼저 스캐너 운영 빌드를 만든다(`node seed-css/build.mjs scanner` 또는 뿌리에서 `pnpm --filter @peaket/scanner build`). 서버는 운영 빌드 하나(seed-css/apps.mjs scanner, 4104).
// 스캐너 API(scanner-api.peaket.example)는 page.route로 답한다. 서버 쪽 실제 연결은 services/ticket-svc/test-int/scanner-f055.int.test.ts가 본다(덧붙임 시험).
import { defineConfig, devices } from '@playwright/test';
import { firefoxUse } from './lib/firefox.mjs';
import { APPS, EXTERNAL_SERVERS, portOf, readyPath, serverCommand } from './seed-css/apps.mjs';

const SCANNER = APPS.find((a) => a.name === 'scanner');
const { command, env } = serverCommand(SCANNER, 'prod');

export default defineConfig({
  testDir: './scanner-enroll',
  testMatch: /\.spec\.mjs$/,
  timeout: 60_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/scanner-enroll.junit.xml' }]],
  use: { locale: 'ko-KR', timezoneId: 'Asia/Seoul', trace: 'retain-on-failure', baseURL: `http://127.0.0.1:${portOf(SCANNER, 'prod')}` },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: firefoxUse() },
  ],
  webServer: EXTERNAL_SERVERS
    ? undefined
    : [{ command, env, url: `http://127.0.0.1:${portOf(SCANNER, 'prod')}${readyPath(SCANNER, 'prod')}`, reuseExistingServer: !process.env.CI, timeout: 120_000, stdout: 'ignore', stderr: 'pipe' }],
});
