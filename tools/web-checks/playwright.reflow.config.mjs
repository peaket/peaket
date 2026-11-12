// FE-T31 재배치·확대·글자 간격 시험 설정(docs/frontend.md §5.11·§5.17, BUILD_ORDER BAT-170).
// 운영 빌드(seed-css/apps.mjs의 prod)를 띄우고 소비자 웹·파트너·관제의 대표 흐름을 ko·en, 320·640 폭에서 돈다.
// 브라우저 확인은 웨이브 끝 heavy gate에서 한다(갈래 1이 kind/Docker를 쓰는 동안은 돌리지 않는다).
import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { firefoxUse } from './lib/firefox.mjs';
import { APPS, EXTERNAL_SERVERS, mockApiServer, portOf, readyPath, serverCommand } from './seed-css/apps.mjs';

/** 빌드와 시작이 같은 서버 액션 키를 써야 한다(운영은 Secrets Manager). 값이 없으면 매 실행 새로 만든다 */
const SERVER_ACTIONS_KEY = process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY || randomBytes(32).toString('base64');

const SERVERS = ['web', 'partner', 'console'].map((name) => {
  const app = APPS.find((a) => a.name === name);
  // 이 PC에는 pnpm이 PATH에 없을 수 있어 파트너는 next 바이너리를 직접 부른다(빌드는 미리 해 둔다).
  const { command, env } =
    name === 'partner'
      ? { command: `node ../../apps/partner/node_modules/next/dist/bin/next start ../../apps/partner -p ${portOf(app, 'prod')}`, env: {} }
      : serverCommand(app, 'prod');
  return {
    command,
    env: name === 'console' ? env : { ...env, NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: SERVER_ACTIONS_KEY },
    url: `http://127.0.0.1:${portOf(app, 'prod')}${readyPath(app, 'prod')}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  };
});

const project = (name, baseUse, locale, viewport) => ({
  name,
  use: { ...baseUse, locale, viewport },
});

const BROWSERS = [
  ['chromium', devices['Desktop Chrome']],
  ['webkit', devices['Desktop Safari']],
  ['firefox', firefoxUse()],
];
const VIEWPORTS = [
  ['320', { width: 320, height: 256 }],
  ['640', { width: 640, height: 400 }],
];
const LOCALES = [
  ['ko', 'ko-KR'],
  ['en', 'en-US'],
];

export default defineConfig({
  testDir: './reflow',
  testMatch: /\.spec\.mjs$/,
  timeout: 90_000,
  workers: 1,
  retries: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['junit', { outputFile: 'reports/reflow.junit.xml' }]],
  use: { timezoneId: 'Asia/Seoul', trace: 'off' },
  projects: BROWSERS.flatMap(([browser, baseUse]) =>
    LOCALES.flatMap(([localeName, locale]) => VIEWPORTS.map(([size, viewport]) => project(`${browser}-${localeName}-${size}`, baseUse, locale, viewport))),
  ),
  webServer: EXTERNAL_SERVERS ? undefined : [mockApiServer(), ...SERVERS],
});
