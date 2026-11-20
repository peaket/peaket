// public/seed-color-mode.js를 붙인 SEED 판의 색 모드 스크립트(system 모드)로 만들고,
// 같은 글의 SHA-256으로 SRI 상수 파일(src/_app/theme/seed-color-mode-sri.ts)을 만든다(BUILD_ORDER HOT-291·BAT-172).
//   pnpm --filter @peaket/web color-mode         만든다
//   pnpm --filter @peaket/web color-mode --check 다르면 종료 코드 1(시험 src/_app/theme/color-mode.test.mjs도 본다)
// 상수는 빌드 때 만든 생성 파일이라 실행할 때 파일을 읽지 않는다(standalone 산출물에 public/이 없을 수 있다, BAT-172 결정 4·6).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { colorModeScript } from '@peaket/ds/color-mode-script';

const publicFile = new URL('../public/seed-color-mode.js', import.meta.url);
const sriFile = new URL('../src/_app/theme/seed-color-mode-sri.ts', import.meta.url);
const want = colorModeScript('system');
const SRI_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

/** 파일과 같은 UTF-8 바이트의 SHA-256을 브라우저 SRI 꼴(sha256- + base64)로 낸다 */
function integrityOf(text) {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

/** 생성 파일 글. 값이 비었거나 꼴이 틀리면 이 모듈을 가져오는 루트 문서가 빌드 때 멈춘다 */
function generated(integrity) {
  return [
    '// 생성 파일: 손으로 고치지 않는다. `pnpm --filter @peaket/web color-mode`가 public/seed-color-mode.js의 SHA-256으로 다시 만든다(BUILD_ORDER BAT-172).',
    `export const SEED_COLOR_MODE_SRI = '${integrity}';`,
    '',
    'if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(SEED_COLOR_MODE_SRI)) {',
    "  throw new Error('seed-color-mode-sri.ts의 SEED_COLOR_MODE_SRI가 sha256-… 꼴이 아니다: pnpm --filter @peaket/web color-mode');",
    '}',
    '',
  ].join('\n');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!want) fail('색 모드 스크립트 글이 비었다: @peaket/ds/color-mode-script를 본다.');
const integrity = integrityOf(want);
if (!SRI_PATTERN.test(integrity)) fail(`SRI 값 꼴이 틀렸다: ${integrity}`);

if (process.argv.includes('--check')) {
  let havePublic = '';
  let haveSri = '';
  try {
    havePublic = readFileSync(publicFile, 'utf8');
  } catch {}
  try {
    haveSri = readFileSync(sriFile, 'utf8');
  } catch {}
  if (havePublic !== want) {
    fail('public/seed-color-mode.js가 붙인 SEED 판과 다르다: pnpm --filter @peaket/web color-mode');
  }
  if (haveSri !== generated(integrity)) {
    fail(
      'src/_app/theme/seed-color-mode-sri.ts가 public/seed-color-mode.js의 SHA-256과 다르거나 비었다: pnpm --filter @peaket/web color-mode',
    );
  }
  console.log('색 모드 스크립트와 SRI 상수가 붙인 SEED 판·public 파일 해시와 같다.');
} else {
  writeFileSync(publicFile, want);
  writeFileSync(sriFile, generated(integrity));
  console.log('만듦: public/seed-color-mode.js');
  console.log(`만듦: src/_app/theme/seed-color-mode-sri.ts (${integrity})`);
}
