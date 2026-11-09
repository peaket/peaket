// FE-T41 서식 글 편집기 PoC 빌드(BUILD_ORDER HOT-322): 파트너 콘솔을 PoC 빌드(PEAKET_POC=rich-text)로 따로 빌드한다.
//   node rich-text/build.mjs   (검사 패키지 폴더에서, 뿌리 작업 공간에 의존성이 설치돼 있어야 한다)
// 산출 폴더는 apps/partner/.next-rich-text(.gitignore의 .next-*)다. 운영 빌드(.next)와 SEED CSS PoC 빌드(.next-poc)를 건드리지 않는다.
import { spawnSync } from 'node:child_process';
import { repoRoot } from '../lib/canon.mjs';

export const RICH_TEXT_DIST = '.next-rich-text';

const run = (args, env = {}) => {
  const r = spawnSync(['pnpm', ...args].join(' '), { cwd: repoRoot, env: { ...process.env, ...env }, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`실패(종료 코드 ${r.status}): pnpm ${args.join(' ')}`);
    process.exit(1);
  }
};

console.log('== 파트너 콘솔이 기대는 작업 공간 패키지 빌드');
run(['--filter', '"@peaket/partner^..."', 'run', '--if-present', 'build']);
console.log('== 파트너 콘솔 서식 글 편집기 PoC 빌드');
run(['--filter', '@peaket/partner', 'exec', 'next', 'build'], { PEAKET_POC: 'rich-text', PEAKET_NEXT_DIST: RICH_TEXT_DIST });
