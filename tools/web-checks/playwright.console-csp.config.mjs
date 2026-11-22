// 관제·파트너 콘솔 보안 헤더와 Trusted Types 검사(F-03-1 OPS-340 T11·T12, docs/frontend.md §5.14.1, ADR-0360 결정 6~8).
// 먼저 운영 빌드 둘을 만든다: `pnpm --filter @peaket/console-host build`(호스트 + 원격 둘, dist/·dist/remotes/)와 `node rich-text/build.mjs`(파트너 .next-rich-text).
// 서버는 관제 미리보기 서버(apps/console-host/scripts/preview-server.mjs, staticAppHeaders('console'))와 파트너 운영 서버(next start, proxy.ts 헤더) 둘이다.
// 실행: pnpm run console-csp (이 폴더에서). 파일로 나눈 시험이라 이름 grep으로 0개 실행이 되는 길이 없다.
import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { EXTERNAL_SERVERS, HOST } from './seed-css/apps.mjs';

export const CONSOLE_PORT = 4131;
export const PARTNER_PORT = 4132;

export default defineConfig({
  testDir: './console-csp',
  testMatch: /\.spec\.mjs$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/console-csp.junit.xml' }]],
  use: { trace: 'retain-on-failure' },
  // Trusted Types 정책 이름·위반 보고는 세 엔진이 모두 지원한다(Baseline 2026-02). 무거운 관제 화면 16개 순회라 대표 엔진 Chromium으로 돈다(TA-P16)
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: EXTERNAL_SERVERS
    ? undefined
    : [
        {
          command: `node ../../apps/console-host/scripts/preview-server.mjs ${CONSOLE_PORT}`,
          url: `http://${HOST}:${CONSOLE_PORT}/login`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          stdout: 'ignore',
          stderr: 'pipe',
        },
        {
          command: `pnpm --dir ../../apps/partner exec next start -p ${PARTNER_PORT}`,
          env: { PEAKET_NEXT_DIST: '.next-rich-text', NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64') },
          url: `http://127.0.0.1:${PARTNER_PORT}/events/new`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          stdout: 'ignore',
          stderr: 'pipe',
        },
      ],
});
