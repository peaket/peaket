// FE-T31 재배치·확대·글자 간격 시험 설정(docs/frontend.md §5.11·§5.17, BUILD_ORDER BAT-170).
// 운영 빌드(seed-css/apps.mjs의 prod)를 띄우고 소비자 웹·파트너·관제의 대표 흐름을 ko·en(소비자 웹 /en 접두), 320·640·기본 폭에서 돈다.
// 재배치(reflow.spec)·초점 가림(keyboard.spec)·인앱 브라우저 안내(in-app.spec)·월렛 워커(wallet-sw.spec)가 이 설정을 쓴다.
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

// 월렛 킬 스위치 서버(F-05-1 FE-T14·FE-T43, ADR-0363 결정 6): 같은 운영 빌드를 실행 값 PEAKET_WALLET_SW_MODE=kill로 한 번 더 띄운다(4181, 안쪽 5181).
// reflow/wallet-sw.spec.mjs·web-push.spec.mjs가 PEAKET_WEB_KILL_PORT(기본 4181)로 연다
const KILL_PORT = Number(process.env.PEAKET_WEB_KILL_PORT ?? 4181);
{
  const app = APPS.find((a) => a.name === 'web');
  const { env } = serverCommand(app, 'prod');
  SERVERS.push({
    command: `node ../../${app.dir}/server/start.mjs --port ${KILL_PORT} --inner-port ${KILL_PORT + 1000}`,
    env: { ...env, NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: SERVER_ACTIONS_KEY, PEAKET_WALLET_SW_MODE: 'kill' },
    url: `http://127.0.0.1:${KILL_PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  });
}

// 화면 매트릭스(docs/frontend.md §5.17 '화면 매트릭스와 FE-T31·FE-T18 자동 몫의 세부', BAT-170 웨이브 7):
// 세 엔진 × 320×256·640×400, 그리고 세 엔진의 기본 폭 프로젝트. 로케일은 주소 접두(/en)로 돌고 Playwright locale은 바꾸지 않는다.
// 프로젝트마다 시험 이름의 폭 표시(' 320: '·' 640: '·' 640 글자 간격: '·' 기본 폭: ')로 고른다.
const BROWSERS = [
  ['chromium', devices['Desktop Chrome']],
  ['webkit', devices['Desktop Safari']],
  ['firefox', firefoxUse()],
];
const SIZES = [
  ['320', { width: 320, height: 256 }, / 320: /],
  ['640', { width: 640, height: 400 }, / 640(?: 글자 간격)?: /],
  ['768', { width: 768, height: 1024 }, / 768: /],
  ['default', undefined, / 기본 폭: /],
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
    SIZES.map(([size, viewport, grep]) => ({ name: `${browser}-${size}`, grep, use: { ...baseUse, locale: 'ko-KR', ...(viewport ? { viewport } : {}) } })),
  ),
  webServer: EXTERNAL_SERVERS ? undefined : [mockApiServer(), ...SERVERS],
});
