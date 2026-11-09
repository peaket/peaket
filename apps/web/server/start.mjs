#!/usr/bin/env node
// 소비자 웹 운영 서버 시작: Next.js 서버를 안쪽 포트(127.0.0.1)에 띄우고, 그 앞에 캐시 화면 응답 때 해시 서버를 연다
// (ADR-0193, docs/frontend.md §5.14.1, BUILD_ORDER HOT-290). 밖에서 오는 요청은 모두 앞 서버를 거친다.
//   node server/start.mjs [--port 3000] [--inner-port 3001] [--host 127.0.0.1]
// - 앞 서버가 붙을 주소는 기본 127.0.0.1(개발 PC). 운영 이미지는 --host 0.0.0.0을 준다. 안쪽 Next.js는 늘 127.0.0.1이다.
// - Next.js 운영 출력(standalone)의 server.js가 산출 폴더에 있으면 같은 프로세스에서 띄우고, 없으면 `next start`를 자식으로 띄운다
//   (운영 이미지는 standalone을 쓴다: 배포 단계 HOT-450이 output: 'standalone'과 함께 이 파일을 진입점으로 둔다).
// - 산출 폴더는 PEAKET_NEXT_DIST(기본 .next), 서버 액션 키 등 나머지 환경 변수는 그대로 넘긴다.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createCspHashServer, reactRuntimeScripts } from './csp-hash-server.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { port: { type: 'string', default: process.env.PORT ?? '3000' }, 'inner-port': { type: 'string' }, host: { type: 'string', default: '127.0.0.1' } } });
const port = Number(values.port);
const inner = Number(values['inner-port'] ?? port + 1);
if (!Number.isInteger(port) || !Number.isInteger(inner) || port === inner) throw new Error(`--port·--inner-port가 틀렸다: ${values.port}, ${values['inner-port']}`);

const dist = process.env.PEAKET_NEXT_DIST ?? '.next';
const standalone = join(appDir, dist, 'standalone', 'apps', 'web', 'server.js');

/** 안쪽 서버가 응답할 때까지 기다린다 */
async function waitUp(url, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      await fetch(url, { method: 'HEAD' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`안쪽 Next.js 서버가 ${ms}ms 안에 뜨지 않았다: ${url}`);
}

let child;
if (existsSync(standalone)) {
  process.env.PORT = String(inner);
  process.env.HOSTNAME = '127.0.0.1';
  await import(pathToFileURL(standalone).href);
} else {
  const nextBin = createRequire(join(appDir, 'package.json')).resolve('next/dist/bin/next');
  child = spawn(process.execPath, [nextBin, 'start', '-p', String(inner), '-H', '127.0.0.1'], { cwd: appDir, stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code ?? 1));
}
await waitUp(`http://127.0.0.1:${inner}/`);

// React 스트리밍 도우미 정의는 설치된 Next.js 실행 파일에서 읽는다(이 정의와 글자까지 같은 인라인 스크립트만 해시를 받는다)
const server = createCspHashServer({ upstream: `http://127.0.0.1:${inner}`, runtime: reactRuntimeScripts(appDir) });
server.listen(port, values.host, () => console.log(`소비자 웹: http://${values.host}:${port} (안쪽 Next.js ${inner}, 캐시 화면 응답 때 해시)`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    child?.kill(sig);
    process.exit(0);
  });
}
