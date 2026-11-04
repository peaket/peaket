// FE-T36 서버(앱 다섯 × 운영·PoC 빌드)를 이 PC에서 띄워 둔다(컨테이너 안 브라우저가 host.docker.internal로 본다: node lib/docker.mjs layers).
//   node seed-css/serve-all.mjs             (Ctrl+C로 모두 끈다)
//   node seed-css/serve-all.mjs --budgets   성능 예산 검사용: 운영 빌드 다섯과 대기실 경량 페이지 셸(node lib/docker.mjs budgets)
//   node seed-css/serve-all.mjs --host 0.0.0.0
//     정적 서버(lib/serve.mjs)가 붙을 주소. 기본 127.0.0.1(환경 변수 PEAKET_SERVE_HOST로도 바꾼다, --host가 이긴다).
//     리눅스 Docker Engine은 host.docker.internal이 다리 주소(172.17.0.1 같은)라 127.0.0.1에 붙은 서버에 닿지 않으므로 0.0.0.0을 준다.
//     Docker Desktop(Windows·macOS)은 기본값으로 닿는다. next start는 원래 모든 주소에 붙는다.
// 끌 때는 셸 아래의 서버(손자 프로세스)까지 끈다: Windows는 taskkill /T /F, 그 밖은 묶음(detached)으로 띄워 묶음 전체에 SIGTERM.
// Playwright로 이 PC에서 돌릴 때는 설정(playwright.layers.config.mjs)의 webServer가 같은 명령으로 띄우므로 이것이 필요 없다.
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { APPS, BUILDS, portOf, readyPath, serverCommand } from './apps.mjs';
import { QUEUE_ROOM } from '../budgets/pages.mjs';
import { DEFAULT_HOST } from '../lib/serve.mjs';

/** 명령줄 → { budgets, host }. 붙을 주소는 --host, 없으면 PEAKET_SERVE_HOST, 없으면 127.0.0.1 */
export function parseServeAllArgs(args, env = process.env) {
  const { values } = parseArgs({ args, options: { budgets: { type: 'boolean', default: false }, host: { type: 'string' } } });
  return { budgets: values.budgets, host: values.host || env.PEAKET_SERVE_HOST || DEFAULT_HOST };
}

/** 서버 자식의 환경 변수. 붙을 주소는 PEAKET_SERVE_HOST로 넘긴다(lib/serve.mjs가 읽는다) */
export const childEnv = (base, extra, host) => ({ ...base, PEAKET_SERVE_HOST: host, ...extra });

/** 준비 확인에 쓸 호스트. 모든 주소(0.0.0.0·::)에 붙었으면 127.0.0.1로 보고, IPv6 주소는 대괄호로 묶는다 */
export const readyHost = (host) => (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host);

/** 서버 자식을 띄우는 옵션. Windows 밖은 묶음 머리로 띄워(detached) 끌 때 묶음 전체(셸 → 서버)에 신호를 보낸다 */
export const spawnOptions = (platform) => ({ shell: true, detached: platform !== 'win32', stdio: ['ignore', 'ignore', 'inherit'] });

/**
 * 서버 자식과 그 아래 프로세스를 끈다. child.kill()은 셸만 끄고 셸이 띄운 서버(손자)를 남긴다.
 * Windows는 taskkill /pid <pid> /T /F(아래 프로세스까지 강제로), 그 밖은 묶음 번호(-pid)에 SIGTERM.
 */
export function killTree(pid, { platform = process.platform, run = spawnSync, kill = process.kill.bind(process) } = {}) {
  if (!pid) return;
  if (platform === 'win32') {
    run('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    kill(-pid, 'SIGTERM');
  } catch (e) {
    if (e?.code !== 'ESRCH') throw e; // 이미 끝난 묶음
  }
}

async function main() {
  const { budgets, host } = parseServeAllArgs(process.argv.slice(2));
  const here = new URL('..', import.meta.url);
  const queueRoom = { name: 'queue-room', command: QUEUE_ROOM.command, port: QUEUE_ROOM.port, path: QUEUE_ROOM.path };
  const servers = budgets
    ? [...APPS.map((app) => [app, 'prod']), [queueRoom, 'prod']]
    : APPS.flatMap((app) => Object.keys(BUILDS).map((build) => [app, build]));
  const children = servers.map(([app, build]) => {
    const { command, env } = app === queueRoom ? { command: queueRoom.command, env: {} } : serverCommand(app, build);
    const child = spawn(command, { cwd: here, env: childEnv(process.env, env, host), ...spawnOptions(process.platform) });
    child.on('exit', (code) => console.log(`${app.name}(${build}) 서버가 끝났다(${code})`));
    return child;
  });

  const h = readyHost(host);
  async function ready([app, build]) {
    const url = app === queueRoom ? `http://${h}:${queueRoom.port}${queueRoom.path}` : `http://${h}:${portOf(app, build)}${readyPath(app, build)}`;
    for (let i = 0; i < 240; i++) {
      try {
        if ((await fetch(url)).ok) return console.log(`준비: ${app.name}(${build}) ${url}`);
      } catch {
        // 아직 뜨는 중
      }
      await new Promise((ok) => setTimeout(ok, 500));
    }
    throw new Error(`${app.name}(${build}) 서버가 2분 안에 뜨지 않았다: ${url}`);
  }

  const stop = (code = 0) => {
    for (const child of children) killTree(child.pid);
    process.exit(code);
  };
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
  // 터미널을 닫으면(SIGHUP) 묶음으로 띄운 서버가 남지 않게 끈다
  process.on('SIGHUP', () => stop());
  try {
    await Promise.all(servers.map(ready));
  } catch (e) {
    console.error(e.message);
    stop(1);
  }
  console.log(`서버 ${servers.length}개가 떴다(붙은 주소 ${host}). 끝내려면 Ctrl+C`);
}

// 시험(serve-all.test.mjs)이 함수만 불러 쓸 수 있게, 명령줄로 돌릴 때만 서버를 띄운다
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
