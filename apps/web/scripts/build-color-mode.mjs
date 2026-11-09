// public/seed-color-mode.js를 붙인 SEED 판의 색 모드 스크립트(system 모드)로 만든다(BUILD_ORDER HOT-291).
//   pnpm --filter @peaket/web color-mode         만든다
//   pnpm --filter @peaket/web color-mode --check 다르면 종료 코드 1(시험 src/_app/theme/color-mode.test.mjs도 본다)
import { readFileSync, writeFileSync } from 'node:fs';
import { colorModeScript } from '@peaket/ds/color-mode-script';

const file = new URL('../public/seed-color-mode.js', import.meta.url);
const want = colorModeScript('system');
if (process.argv.includes('--check')) {
  let have = '';
  try {
    have = readFileSync(file, 'utf8');
  } catch {}
  if (have !== want) {
    console.error('public/seed-color-mode.js가 붙인 SEED 판과 다르다: pnpm --filter @peaket/web color-mode');
    process.exit(1);
  }
  console.log('색 모드 스크립트가 붙인 SEED 판과 같다.');
} else {
  writeFileSync(file, want);
  console.log('만듦: public/seed-color-mode.js');
}
