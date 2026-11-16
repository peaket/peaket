// 운영 빌드 산출물의 시작 확인(리뷰 RV-08, 계획 §13, BUILD_ORDER BAS-220·HOT-400).
// 구현이 찾은 버그: Next.js는 묶을 때 `process.env.NEXT_RUNTIME`을 글자 값으로 바꾸고, 운영 standalone 서버의 환경에는 이 값이 없다.
// 그래서 계측 진입점(instrumentation.ts register)이 환경 객체로 NEXT_RUNTIME을 보면 서버 액션 키 확인·텔레메트리 시작이 조용히 건너뛰어졌다.
// 이 시험은 운영 빌드 산출물을 NEXT_RUNTIME 환경 값 없이 띄워 본다(단위 시험은 환경 값을 직접 넣으므로 이 버그를 재현하지 못한다).
// - web: `<distDir>/standalone/apps/web/server.js`(운영 이미지의 진입, output: 'standalone')
// - partner: 운영 시작 명령 `next start`(partner는 standalone 출력을 쓰지 않는다)
// '뜨지 않는다'는 프로세스가 0이 아닌 코드로 끝나고 요청에 답하지 않는다는 뜻이다(모든 요청에 500으로 답하며 남아 있는 것도 뜬 것으로 센다).
// 먼저 운영 빌드가 있어야 한다(CI `web / budgets` 잡의 `node seed-css/build.mjs`(PEAKET_BUILDS=prod) 뒤). 산출물이 없으면 실패한다(건너뛰지 않는다).
// 실행(tools/web-checks): node --test "boot/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DIST = process.env.PEAKET_NEXT_DIST ?? '.next';
const KEY_ENV = 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY';

const APPS = {
  web: { cwd: join(REPO, 'apps', 'web', DIST, 'standalone', 'apps', 'web'), args: (port) => ['server.js'], portEnv: true, need: () => join(REPO, 'apps', 'web', DIST, 'standalone', 'apps', 'web', 'server.js') },
  partner: { cwd: join(REPO, 'apps', 'partner'), args: (port) => [join(REPO, 'apps', 'partner', 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--port', String(port), '--hostname', '127.0.0.1'], portEnv: false, need: () => join(REPO, 'apps', 'partner', DIST, 'BUILD_ID') },
};

const freePort = () =>
  new Promise((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });

/** 운영 환경으로 띄운다: NEXT_RUNTIME·NEXT_PHASE·PEAKET_TRACE_INBOUND는 지우고 extra만 더한다. 뜨면 { up: true }, 먼저 끝나면 { up: false, code, out } */
async function boot(name, extra, waitMs = 60_000) {
  const app = APPS[name];
  assert.ok(existsSync(app.need()), `${name} 운영 빌드 산출물이 없다: ${app.need()}(먼저 운영 빌드를 한다)`);
  const port = await freePort();
  const env = { ...process.env };
  for (const k of ['NEXT_RUNTIME', 'NEXT_PHASE', 'PEAKET_TRACE_INBOUND', 'OTEL_SERVICE_NAME', 'NODE_OPTIONS', KEY_ENV]) delete env[k];
  Object.assign(env, { NODE_ENV: 'production', OTEL_TRACES_EXPORTER: 'none', ...(app.portEnv ? { PORT: String(port), HOSTNAME: '127.0.0.1' } : {}), ...extra });
  const child = spawn(process.execPath, app.args(port), { cwd: app.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.on('exit', (code) => r({ up: false, code, out })));
  const listening = (async () => {
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD', redirect: 'manual' });
        return { up: true, out };
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    return { up: 'timeout', out };
  })();
  const result = await Promise.race([exited, listening]);
  if (child.exitCode === null) {
    child.kill();
    await exited;
  }
  return { ...result, out };
}

const goodKey = () => randomBytes(32).toString('base64');

for (const name of Object.keys(APPS)) {
  test(`BAS-220 RV-08 ${name} 운영 서버는 NEXT_RUNTIME 환경 값 없이 띄워도 서버 액션 키가 틀리면 뜨지 않는다`, async () => {
    // 키 없음, 16바이트, 한 바이트 되풀이(형식 규칙은 packages/config/next/server-actions-key.mjs, 값은 정본 docs/security/secrets-and-keys.md의 32바이트)
    for (const [m, extra] of [
      ['키 없음', {}],
      ['16바이트', { [KEY_ENV]: randomBytes(16).toString('base64') }],
      ['한 바이트 되풀이', { [KEY_ENV]: Buffer.alloc(32, 7).toString('base64') }],
    ]) {
      const r = await boot(name, extra);
      assert.equal(r.up, false, `${name} ${m}: 서버가 떠서 요청에 답했다(키 확인이 건너뛰어졌거나, 확인이 던졌는데 프로세스가 끝나지 않았다)\n${r.out.slice(-600)}`);
      assert.notEqual(r.code, 0, `${name} ${m}: 종료 코드 0`);
      assert.match(r.out, new RegExp(KEY_ENV), `${name} ${m}: 오류에 키 이름이 없다\n${r.out.slice(-600)}`);
    }
    // 대조: 맞는 키면 뜬다(위의 실패가 다른 까닭이 아니다)
    const ok = await boot(name, { [KEY_ENV]: goodKey() });
    assert.equal(ok.up, true, `${name}: 맞는 키로도 뜨지 않았다\n${ok.out.slice(-600)}`);
  });

  test(`V-T31 ② RV-08 ${name} 운영 서버는 PEAKET_TRACE_INBOUND=mesh면 뜨지 않고 untrusted면 뜬다`, async () => {
    const r = await boot(name, { [KEY_ENV]: goodKey(), PEAKET_TRACE_INBOUND: 'mesh' });
    assert.equal(r.up, false, `${name}: mesh로 떠서 요청에 답했다(조용히 메시 모드이거나, 던졌는데 프로세스가 끝나지 않았다)\n${r.out.slice(-600)}`);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /PEAKET_TRACE_INBOUND/, `${name}: 오류에 PEAKET_TRACE_INBOUND가 없다\n${r.out.slice(-600)}`);
    const ok = await boot(name, { [KEY_ENV]: goodKey(), PEAKET_TRACE_INBOUND: 'untrusted' });
    assert.equal(ok.up, true, `${name}: untrusted로 뜨지 않았다\n${ok.out.slice(-600)}`);
  });
}
