// FE-T36 서버(앱 다섯 × 운영·PoC 빌드)를 이 PC에서 띄워 둔다(컨테이너 안 브라우저가 host.docker.internal로 본다: node lib/docker.mjs layers).
//   node seed-css/serve-all.mjs   (Ctrl+C로 모두 끈다)
// Playwright로 이 PC에서 돌릴 때는 설정(playwright.layers.config.mjs)의 webServer가 같은 명령으로 띄우므로 이것이 필요 없다.
import { spawn } from 'node:child_process';
import { APPS, BUILDS, portOf, readyPath, serverCommand } from './apps.mjs';

const here = new URL('..', import.meta.url);
const servers = APPS.flatMap((app) => Object.keys(BUILDS).map((build) => [app, build]));
const children = servers.map(([app, build]) => {
  const { command, env } = serverCommand(app, build);
  const child = spawn(command, { cwd: here, env: { ...process.env, ...env }, shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
  child.on('exit', (code) => console.log(`${app.name}(${build}) 서버가 끝났다(${code})`));
  return child;
});

async function ready([app, build]) {
  const url = `http://127.0.0.1:${portOf(app, build)}${readyPath(app, build)}`;
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
