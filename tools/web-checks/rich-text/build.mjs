// FE-T41 공연 설명 편집기 시험의 빌드(ADR-0247): 파트너 콘솔을 운영 설정으로 따로 빌드한다.
//   node rich-text/build.mjs   (검사 패키지 폴더에서, 뿌리 작업 공간에 의존성이 설치돼 있어야 한다)
// 산출 폴더는 apps/partner/.next-rich-text(.gitignore의 .next-*)다. 다른 검사의 빌드(.next, .next-poc)를 건드리지 않는다.
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
console.log('== 파트너 콘솔 빌드');
run(['--filter', '@peaket/partner', 'exec', 'next', 'build'], { PEAKET_NEXT_DIST: RICH_TEXT_DIST });
