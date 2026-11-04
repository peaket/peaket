// FE-T36 서버(앱 다섯 × 운영·PoC 빌드)를 이 PC에서 띄워 둔다(컨테이너 안 브라우저가 host.docker.internal로 본다: node lib/docker.mjs layers).
//   node seed-css/serve-all.mjs             (Ctrl+C로 모두 끈다)
//   node seed-css/serve-all.mjs --budgets   성능 예산 검사용: 운영 빌드 다섯과 대기실 경량 페이지 셸(node lib/docker.mjs budgets)
// Playwright로 이 PC에서 돌릴 때는 설정(playwright.layers.config.mjs)의 webServer가 같은 명령으로 띄우므로 이것이 필요 없다.
import { spawn } from 'node:child_process';
import { APPS, BUILDS, portOf, readyPath, serverCommand } from './apps.mjs';
import { QUEUE_ROOM } from '../budgets/pages.mjs';

const here = new URL('..', import.meta.url);
const budgets = process.argv.includes('--budgets');
const queueRoom = { name: 'queue-room', command: QUEUE_ROOM.command, port: QUEUE_ROOM.port, path: QUEUE_ROOM.path };
const servers = budgets
  ? [...APPS.map((app) => [app, 'prod']), [queueRoom, 'prod']]
  : APPS.flatMap((app) => Object.keys(BUILDS).map((build) => [app, build]));
const children = servers.map(([app, build]) => {
  const { command, env } = app === queueRoom ? { command: queueRoom.command, env: {} } : serverCommand(app, build);
  const child = spawn(command, { cwd: here, env: { ...process.env, ...env }, shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
  child.on('exit', (code) => console.log(`${app.name}(${build}) 서버가 끝났다(${code})`));
  return child;
});

async function ready([app, build]) {
  const url = app === queueRoom ? `http://127.0.0.1:${queueRoom.port}${queueRoom.path}` : `http://127.0.0.1:${portOf(app, build)}${readyPath(app, build)}`;
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

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await Promise.all(servers.map(ready));
console.log(`서버 ${servers.length}개가 떴다. 끝내려면 Ctrl+C`);
