// FE-T36 빌드: 앱 다섯을 운영 빌드(경로 검사)와 PoC 빌드(PEAKET_POC=seed-css, 탐침 화면)로 두 번 빌드한다(BUILD_ORDER BAS-170).
//   node seed-css/build.mjs [앱 이름...]   (검사 패키지 폴더에서, 뿌리 작업 공간에 의존성이 설치돼 있어야 한다)
// 먼저 앱이 기대는 작업 공간 패키지의 build를 돈다(예: 소비자 웹이 가져오는 @peaket/contracts의 dist. CI에서는 처음엔 없다).
// 산출 폴더는 seed-css/apps.mjs의 BUILDS(운영 빌드는 운영과 같은 .next·dist, PoC 빌드는 .next-poc·dist-poc, .gitignore)다.
import { spawnSync } from 'node:child_process';
import { APPS, BUILDS } from './apps.mjs';
import { repoRoot } from '../lib/canon.mjs';

const only = process.argv.slice(2);
const targets = only.length ? APPS.filter((a) => only.includes(a.name)) : APPS;
if (targets.length === 0 || targets.length !== (only.length || APPS.length)) {
  console.error(`모르는 앱: ${only.join(', ')} (앱: ${APPS.map((a) => a.name).join(', ')})`);
  process.exit(2);
}

/** 인자는 이 파일이 정한 값뿐이라 명령 한 줄로 셸에 넘긴다(Windows에서 pnpm 실행 파일을 찾으려면 셸이 필요하다) */
function run(args, env = {}) {
  const r = spawnSync(['pnpm', ...args].join(' '), { cwd: repoRoot, env: { ...process.env, ...env }, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`실패(종료 코드 ${r.status}): pnpm ${args.join(' ')}`);
    process.exit(1);
  }
}

console.log('== 앱이 기대는 작업 공간 패키지 빌드');
run([...targets.flatMap((a) => ['--filter', `"${a.pkg}^..."`]), 'run', '--if-present', 'build']);

const ARGS = {
  next: () => ['next', 'build'],
  webpack: (b) => ['webpack', '--mode', 'production', '--output-path', b.dist],
  vite: (b) => ['vite', 'build', '--outDir', b.dist],
};
for (const app of targets) {
  for (const [build, b] of Object.entries(BUILDS)) {
    console.log(`== ${app.name}: ${build === 'poc' ? 'PoC 빌드(탐침)' : '운영 빌드'}(${app.kind})`);
    const env = { PEAKET_POC: build === 'poc' ? 'seed-css' : '', ...(app.kind === 'next' ? { PEAKET_NEXT_DIST: b.nextDist } : {}) };
    run(['--filter', app.pkg, 'exec', ...ARGS[app.kind](b)], env);
  }
}
