// 관제 원격 위젯 검사(F-03-2 OPS-350·OPS-360: FE-T17 무결성·시간 초과·계약 판 → 그 칸만 대체 카드, FE-T39 Trusted Types, 미리 받기, 원격 산출물).
// 먼저 뿌리에서 관제 운영 빌드를 만든다: `pnpm --filter @peaket/console-host build`(호스트 + 한 파일 원격 둘 + dist/remotes.json).
// 준비(console-remotes/global-setup.mjs)가 계약 판 범위만 바꾼 대체 원격을 빌드한다(T18). 위조 무대는 시험마다 운영 빌드를 복사해 한 곳만 바꾸고
// 관제 미리보기 서버(staticAppHeaders('console'))를 포트 0으로 띄운다(console-remotes/forge.mjs). 실행: pnpm run console-remotes (이 폴더에서).
// 파일로 나눈 시험이라 이름 grep으로 0개 실행이 되는 길이 없다. Firefox는 이 PC에서 PEAKET_FIREFOX=system(lib/firefox.mjs).
import { defineConfig, devices } from '@playwright/test';
import { firefoxUse } from './lib/firefox.mjs';

export default defineConfig({
  testDir: './console-remotes',
  testMatch: /\.spec\.mjs$/,
  globalSetup: './console-remotes/global-setup.mjs',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // 무대(서버)는 시험마다 따로 띄워 겹치지 않지만, 관제 화면이 무거워 둘씩만 돈다
  workers: 2,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/console-remotes.junit.xml' }]],
  use: { trace: 'retain-on-failure', viewport: { width: 1600, height: 1000 } },
  projects: [
    // 무결성·시간 초과·계약 판·대체 카드·다시 시도는 세 엔진(계획 5 '원격 위조·시간 초과·판 불일치는 화면에서 세 엔진')
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } },
    { name: 'firefox', testMatch: /remotes\.spec\.mjs$/, use: firefoxUse({ viewport: { width: 1600, height: 1000 } }) },
    { name: 'webkit', testMatch: /remotes\.spec\.mjs$/, use: { ...devices['Desktop Safari'], viewport: { width: 1600, height: 1000 } } },
  ],
});
