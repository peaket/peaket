// F-03-6(FE-T29) 두 운영 빌드를 만들고 같은 대역 ops API에 붙여 띄우는 무대.
// - MF: 기본 빌드(호스트 + 원격 둘 + dist/remotes.json)를 reports/console-baseline/builds/mf/에 복사한다.
// - 한 앱: PEAKET_CONSOLE_BUILD=single로 빌드해 reports/console-baseline/builds/single/에 둔다(원격 목록 없음).
// - 두 빌드 모두 PEAKET_OPS_API_ORIGIN을 미리보기 출처로 넣어 빌드한다(앱이 같은 출처 /v1/ops를 부르고,
//   미리보기 서버가 ops-proxy로 대역에 넘긴다). 포트는 빌드마다 고정이다(빌드에 박히는 값이라 0을 쓸 수 없다).
// Docker·kind·새 패키지 없이 Node와 Playwright만 쓴다.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewServer } from '../../../apps/console-host/scripts/preview-server.mjs';
import { startOpsStub } from './ops-stub.mjs';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
export const REPORT_ROOT = fileURLToPath(new URL('../reports/console-baseline/', import.meta.url));
export const BUILD_ROOT = path.join(REPORT_ROOT, 'builds');
export const BUILD_DIRS = { mf: path.join(BUILD_ROOT, 'mf'), single: path.join(BUILD_ROOT, 'single') };
export const PREVIEW_PORTS = { mf: 4310, single: 4311 };
export const PREVIEW_ORIGINS = { mf: `http://127.0.0.1:${PREVIEW_PORTS.mf}`, single: `http://127.0.0.1:${PREVIEW_PORTS.single}` };

const CONSOLE = path.join(REPO, 'apps/console-host');
const DIST = path.join(CONSOLE, 'dist');

/** 빌드 로그를 너무 길지 않게 자른다 */
const tail = (s) => String(s ?? '').split(/\r?\n/).slice(-20).join('\n');

/** @param {string} command @param {Record<string,string|undefined>} env */
function run(command, env) {
  const r = spawnSync(command, { cwd: REPO, env: { ...process.env, ...env }, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 });
  if (r.status !== 0) throw new Error(`명령 실패(${r.status}): ${command}\n${tail(r.stdout)}\n${tail(r.stderr)}`);
  return r;
}

/** dist를 빌드 폴더로 복사한다(숨김 소스 맵·maps 폴더 제외) */
function copyDist(from, to) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith('.map') && path.basename(src) !== 'maps' });
}

/** MF 빌드 확인: 원격 목록과 원격 진입 파일 둘 */
export function assertMfBuild(dir) {
  const listPath = path.join(dir, 'remotes.json');
  if (!existsSync(listPath)) throw new Error(`MF 빌드에 remotes.json이 없다: ${dir}`);
  const list = JSON.parse(readFileSync(listPath, 'utf8'));
  for (const name of ['queue', 'purchase']) {
    const entry = list.find((x) => x.name === name);
    if (!entry) throw new Error(`MF 원격 목록에 ${name}이 없다`);
    const file = path.join(dir, ...entry.entry.split('/').filter(Boolean));
    if (!existsSync(file)) throw new Error(`MF 원격 진입 파일이 없다: ${file}`);
  }
  return list;
}

/** 한 앱 빌드 확인: 원격 목록이 없고 위젯 덩어리 둘이 있다 */
export function assertSingleBuild(dir) {
  if (existsSync(path.join(dir, 'remotes.json'))) throw new Error(`한 앱 빌드에 remotes.json이 있다: ${dir}`);
  const assets = path.join(dir, 'assets');
  const files = existsSync(assets) ? readdirSync(assets) : [];
  for (const name of ['widgets-queue', 'widgets-purchase']) {
    if (!files.some((f) => f.startsWith(`${name}.`) && f.endsWith('.chunk.js'))) throw new Error(`한 앱 빌드에 ${name} 덩어리가 없다`);
  }
}

/**
 * 한 빌드를 만든다. 같은 폴더가 있으면 다시 만들지 않는다(force면 지운다).
 * @param {'mf'|'single'} build
 * @param {{ force?: boolean }} [o]
 * @returns {{ build: 'mf'|'single', dir: string, ms: number, built: boolean }}
 */
export function buildConsole(build, o = {}) {
  const dir = BUILD_DIRS[build];
  if (!o.force && existsSync(path.join(dir, 'index.html'))) {
    if (build === 'mf') assertMfBuild(dir);
    else assertSingleBuild(dir);
    return { build, dir, ms: 0, built: false };
  }
  mkdirSync(BUILD_ROOT, { recursive: true });
  const started = performance.now();
  if (build === 'mf') {
    run('corepack pnpm --filter @peaket/console-host build', { PEAKET_CONSOLE_BUILD: '', PEAKET_OPS_API_ORIGIN: PREVIEW_ORIGINS.mf });
    copyDist(DIST, dir);
    assertMfBuild(dir);
  } else {
    // 먼저 --output-path로 바로 빌드한다. webpack이 설정의 output.path를 이기면 dist로 떨어지므로 그때는 복사한다
    const cmd = `corepack pnpm --filter @peaket/console-host exec webpack --mode production --output-path "${dir}"`;
    try {
      run(cmd, { PEAKET_CONSOLE_BUILD: 'single', PEAKET_OPS_API_ORIGIN: PREVIEW_ORIGINS.single });
    } catch {
      run('corepack pnpm --filter @peaket/console-host exec webpack --mode production', { PEAKET_CONSOLE_BUILD: 'single', PEAKET_OPS_API_ORIGIN: PREVIEW_ORIGINS.single });
      copyDist(DIST, dir);
    }
    assertSingleBuild(dir);
  }
  return { build, dir, ms: Math.round(performance.now() - started), built: true };
}

/** 두 빌드를 만든다(측정 전에 한 번) */
export function buildBoth(o = {}) {
  return { mf: buildConsole('mf', o), single: buildConsole('single', o) };
}

/**
 * 빌드 하나를 미리보기 서버 + 대역 ops API에 붙여 띄운다.
 * @param {'mf'|'single'} build
 * @param {{ ops?: Awaited<ReturnType<typeof startOpsStub>>, dist?: string }} [o]
 */
export async function startStage(build, o = {}) {
  const dir = o.dist ?? BUILD_DIRS[build];
  if (build === 'mf') assertMfBuild(dir);
  else assertSingleBuild(dir);
  const ops = o.ops ?? (await startOpsStub());
  const port = PREVIEW_PORTS[build];
  const server = createPreviewServer({ dist: dir, env: { PEAKET_OPS_API_ORIGIN: PREVIEW_ORIGINS[build], PEAKET_OPS_PROXY_TARGET: ops.origin } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const origin = PREVIEW_ORIGINS[build];
  return {
    build,
    dir,
    origin,
    ops,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      if (!o.ops) await ops.close();
    },
  };
}

/** 포트가 비었는지(다른 세션이 같은 고정 포트를 쓰면 측정을 시작하지 않는다) */
export async function assertPortsFree(ports = Object.values(PREVIEW_PORTS)) {
  for (const port of ports) {
    const s = createServer();
    await new Promise((resolve, reject) => {
      s.once('error', () => reject(new Error(`미리보기 포트 ${port}가 이미 쓰인다. 다른 세션의 서버를 끝내고 다시 잰다`)));
      s.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => s.close(() => resolve()));
  }
}
