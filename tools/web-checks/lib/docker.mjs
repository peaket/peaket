// 판을 고정한 Playwright 컨테이너에서 검사를 돌린다(docs/frontend.md §5.17 FE-T40·FE-T36, BUILD_ORDER BAS-170).
//   node lib/docker.mjs visual [--update-snapshots[=missing]]   대기실 셸과 ds 이야기 시각 회귀. 셸(apps/web/queue-room/dist)과 Storybook(tools/storybook/storybook-static)은 먼저 빌드해 둔다
//   node lib/docker.mjs csp                           소비자 웹 CSP(FE-T35·FE-T30·SRI PoC, HOT-290). 웹 운영 빌드 서버(4101)는 이 PC에서 먼저 띄운다
//   node lib/docker.mjs ds                            @peaket/ds 접근성(axe)·동작 검사(BAS-180). Storybook은 먼저 tools/storybook에서 `pnpm run build`
//   node lib/docker.mjs layers                        SEED CSS 층 검사. 서버(앱 다섯의 PoC 빌드)는 이 PC에서 먼저 띄워 둔다
//   node lib/docker.mjs seatmap                       5만 석 좌석맵 PoC(K5) 네 프로젝트
//   node lib/docker.mjs budgets                       성능 예산(첫 JS·Lighthouse). 서버는 이 PC에서 `node seed-css/serve-all.mjs --budgets`로 먼저 띄운다
//   node lib/docker.mjs seatmap-pkg                   @peaket/seatmap 세 엔진 검사(HOT-120). 시연 페이지는 먼저 `pnpm --filter @peaket/seatmap demo:build`
// 기준 이미지는 CI와 같은 이 이미지에서만 찍는다(브라우저 그리기는 OS·판·글꼴에 따라 다르다, d2 §1).
// 컨테이너는 이 패키지를 node_modules 없이 옮겨 리눅스용으로 다시 설치한다. 결과는 reports/docker-<mode>/에 둔다.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** CI 화면 잡(.github/workflows/ci-web.yml)과 같은 이미지. 판을 바꿀 때 둘을 함께 고친다 */
export const IMAGE = 'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f';

/**
 * 컨테이너에 깔 pnpm 판. 이 패키지 package.json의 packageManager(pnpm@x.y.z, corepack 해시 +sha… 는 뗀다)에서 읽어
 * 판을 두 군데 적지 않는다. pnpm@x.y.z 꼴이 아니면 멈춘다(셸 명령에 그대로 들어가므로 판 글자만 받는다).
 */
export function pnpmVersion(pkgJson) {
  const pm = pkgJson?.packageManager;
  const m = typeof pm === 'string' ? /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.]+)?$/.exec(pm) : null;
  if (!m) throw new Error(`tools/web-checks/package.json의 packageManager가 pnpm@x.y.z가 아니다(받은 값 ${JSON.stringify(pm)})`);
  return m[1];
}

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(pkg, '../..');

// 시험(docker.test.mjs)이 pnpmVersion만 불러 쓸 수 있게, 명령줄로 돌릴 때만 아래를 한다
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (!['visual', 'layers', 'seatmap', 'budgets', 'seatmap-pkg', 'ds', 'csp'].includes(mode)) {
    console.error('쓰는 법: node lib/docker.mjs visual [--update-snapshots] | layers | seatmap | budgets | seatmap-pkg | ds | csp');
    process.exit(2);
  }
  // --update-snapshots(모두 다시) 또는 --update-snapshots=missing(새 이야기처럼 없는 것만 만들고 나머지는 견준다)
  const update = rest.find((a) => a === '--update-snapshots' || a === '--update-snapshots=missing');
  const pnpm = pnpmVersion(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')));
  const out = join(pkg, 'reports', `docker-${mode}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const mounts = ['-v', `${pkg}:/src:ro`, '-v', `${join(repo, 'docs')}:/repo/docs:ro`, '-v', `${out}:/out`];
  if (mode === 'visual') {
    const dist = join(repo, 'apps/web/queue-room/dist');
    if (!existsSync(join(dist, 'shell.ko.html'))) {
      console.error('대기실 셸 빌드가 없다: pnpm --filter @peaket/queue-room build');
      process.exit(2);
    }
    mounts.push('-v', `${dist}:/repo/apps/web/queue-room/dist:ro`);
  }
  if (mode === 'csp') {
    // 정본 CSP 값(packages/config/headers)과 웹 운영 빌드 산출물(사전 렌더 목록·빌드 셸 HTML)을 읽기 전용으로 붙인다
    const build = join(repo, 'apps/web/.next');
    if (!existsSync(join(build, 'prerender-manifest.json'))) {
      console.error('웹 운영 빌드가 없다: node seed-css/build.mjs web');
      process.exit(2);
    }
    mounts.push('-v', `${join(repo, 'packages/config/headers')}:/repo/packages/config/headers:ro`, '-v', `${build}:/repo/apps/web/.next:ro`);
  }
  if (mode === 'visual' || mode === 'ds') {
    const sb = join(repo, 'tools/storybook/storybook-static');
    if (!existsSync(join(sb, 'index.json'))) {
      console.error('ds Storybook 정적 빌드가 없다: tools/storybook에서 pnpm install --frozen-lockfile && pnpm run build');
      process.exit(2);
    }
    mounts.push('-v', `${sb}:/repo/tools/storybook/storybook-static:ro`);
  }
  if (mode === 'seatmap-pkg') {
    const demo = join(repo, 'packages/seatmap/dist-demo');
    if (!existsSync(join(demo, 'index.html'))) {
      console.error('좌석맵 시연 페이지 빌드가 없다: pnpm --filter @peaket/seatmap demo:build');
      process.exit(2);
    }
    mounts.push('-v', `${demo}:/repo/packages/seatmap/dist-demo:ro`, '-v', `${join(repo, 'packages/ds/src/gen')}:/repo/packages/ds/src/gen:ro`);
  }
  const run = {
    visual: `pnpm exec playwright test -c playwright.visual.config.mjs${update ? ` ${update}` : ''}`,
    layers: 'PEAKET_WEB_CHECKS_HOST=host.docker.internal PEAKET_WEB_CHECKS_SERVERS=external pnpm exec playwright test -c playwright.layers.config.mjs',
    // 좌석맵 PoC(K5, BAS-190): 페이지·배치 파일은 컨테이너 안에서 만들고 띄운다. 웹킷·Firefox의 OffscreenCanvas를 리눅스 판으로 본다
    seatmap: 'pnpm exec playwright test -c playwright.seatmap.config.mjs',
    // 성능 예산(BAS-220): Lighthouse는 CI와 같은 이 이미지의 Chromium으로 잰다(랩 값은 기계·판에 따라 다르다)
    budgets: 'PEAKET_WEB_CHECKS_HOST=host.docker.internal PEAKET_WEB_CHECKS_SERVERS=external pnpm exec playwright test -c playwright.budgets.config.mjs',
    // 좌석맵 패키지(HOT-120): 리눅스의 Firefox·WebKit은 OffscreenCanvas가 있어 Worker 길을 본다
    'seatmap-pkg': 'pnpm exec playwright test -c playwright.seatmap-pkg.config.mjs',
    // ds 부품(BAS-180): 접근성은 Chromium, 동작은 세 엔진
    ds: 'pnpm exec playwright test -c playwright.ds.config.mjs',
    // 소비자 웹 CSP(HOT-290): 서버는 이 PC의 웹 운영 빌드(4101)
    csp: 'PEAKET_WEB_CHECKS_HOST=host.docker.internal PEAKET_WEB_CHECKS_SERVERS=external pnpm exec playwright test -c playwright.csp.config.mjs',
  }[mode];
  const script = [
    'set -e',
    'mkdir -p /repo/tools/web-checks',
    'cd /src && tar --exclude=./node_modules --exclude=./reports --exclude=./test-results -cf - . | tar -C /repo/tools/web-checks -xf -',
    'cd /repo/tools/web-checks',
    `npm install --global pnpm@${pnpm} --silent`,
    'pnpm install --frozen-lockfile --reporter=silent',
    'code=0',
    `${run} || code=$?`,
    'cp -r reports /out/ 2>/dev/null || true',
    mode === 'visual' ? 'cp -r visual/__screenshots__ /out/ 2>/dev/null || true' : 'true',
    'exit $code',
  ].join('\n');
  const r = spawnSync('docker', ['run', '--rm', '--ipc=host', '--add-host=host.docker.internal:host-gateway', ...mounts, IMAGE, 'bash', '-c', script], { stdio: 'inherit' });
  if (mode === 'visual' && update && existsSync(join(out, '__screenshots__'))) {
    rmSync(join(pkg, 'visual', '__screenshots__'), { recursive: true, force: true });
    cpSync(join(out, '__screenshots__'), join(pkg, 'visual', '__screenshots__'), { recursive: true });
    console.log('기준 이미지를 visual/__screenshots__/에 옮겼다. PR에서 그림 차이를 보고 승인한다(FE-T40).');
  }
  process.exit(r.status ?? 1);
}
