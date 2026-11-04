// 판을 고정한 Playwright 컨테이너에서 검사를 돌린다(docs/frontend.md §5.17 FE-T40·FE-T36, BUILD_ORDER BAS-170).
//   node lib/docker.mjs visual [--update-snapshots]   대기실 셸 시각 회귀. 셸(apps/web/queue-room/dist)은 먼저 빌드해 둔다
//   node lib/docker.mjs layers                        SEED CSS 층 검사. 서버(앱 다섯의 PoC 빌드)는 이 PC에서 먼저 띄워 둔다
//   node lib/docker.mjs seatmap                       5만 석 좌석맵 PoC(K5) 네 프로젝트
//   node lib/docker.mjs budgets                       성능 예산(첫 JS·Lighthouse). 서버는 이 PC에서 `node seed-css/serve-all.mjs --budgets`로 먼저 띄운다
//   node lib/docker.mjs seatmap-pkg                   @peaket/seatmap 세 엔진 검사(HOT-120). 시연 페이지는 먼저 `pnpm --filter @peaket/seatmap demo:build`
// 기준 이미지는 CI와 같은 이 이미지에서만 찍는다(브라우저 그리기는 OS·판·글꼴에 따라 다르다, d2 §1).
// 컨테이너는 이 패키지를 node_modules 없이 옮겨 리눅스용으로 다시 설치한다. 결과는 reports/docker-<mode>/에 둔다.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** CI 화면 잡(.github/workflows/ci-web.yml)과 같은 이미지. 판을 바꿀 때 둘을 함께 고친다 */
export const IMAGE = 'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(pkg, '../..');
const [mode, ...rest] = process.argv.slice(2);
if (mode !== 'visual' && mode !== 'layers' && mode !== 'seatmap' && mode !== 'budgets' && mode !== 'seatmap-pkg') {
  console.error('쓰는 법: node lib/docker.mjs visual [--update-snapshots] | layers | seatmap | budgets | seatmap-pkg');
  process.exit(2);
}
const update = rest.includes('--update-snapshots');
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
if (mode === 'seatmap-pkg') {
  const demo = join(repo, 'packages/seatmap/dist-demo');
  if (!existsSync(join(demo, 'index.html'))) {
    console.error('좌석맵 시연 페이지 빌드가 없다: pnpm --filter @peaket/seatmap demo:build');
    process.exit(2);
  }
  mounts.push('-v', `${demo}:/repo/packages/seatmap/dist-demo:ro`, '-v', `${join(repo, 'packages/ds/src/gen')}:/repo/packages/ds/src/gen:ro`);
}
const run = {
  visual: `pnpm exec playwright test -c playwright.visual.config.mjs${update ? ' --update-snapshots' : ''}`,
  layers: 'PEAKET_WEB_CHECKS_HOST=host.docker.internal PEAKET_WEB_CHECKS_SERVERS=external pnpm exec playwright test -c playwright.layers.config.mjs',
  // 좌석맵 PoC(K5, BAS-190): 페이지·배치 파일은 컨테이너 안에서 만들고 띄운다. 웹킷·Firefox의 OffscreenCanvas를 리눅스 판으로 본다
  seatmap: 'pnpm exec playwright test -c playwright.seatmap.config.mjs',
  // 성능 예산(BAS-220): Lighthouse는 CI와 같은 이 이미지의 Chromium으로 잰다(랩 값은 기계·판에 따라 다르다)
  budgets: 'PEAKET_WEB_CHECKS_HOST=host.docker.internal PEAKET_WEB_CHECKS_SERVERS=external pnpm exec playwright test -c playwright.budgets.config.mjs',
  // 좌석맵 패키지(HOT-120): 리눅스의 Firefox·WebKit은 OffscreenCanvas가 있어 Worker 길을 본다
  'seatmap-pkg': 'pnpm exec playwright test -c playwright.seatmap-pkg.config.mjs',
}[mode];
const script = [
  'set -e',
  'mkdir -p /repo/tools/web-checks',
  'cd /src && tar --exclude=./node_modules --exclude=./reports --exclude=./test-results -cf - . | tar -C /repo/tools/web-checks -xf -',
  'cd /repo/tools/web-checks',
  'npm install --global pnpm@12.16.0 --silent',
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
