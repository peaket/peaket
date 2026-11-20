// SEED 색 모드 스크립트 파일 시험(docs/design/d2 §1 'Next.js 앱은 SEED 색 모드 스크립트를 같은 출처 파일로 루트 레이아웃에 싣는다',
// d1 §4 '소비자 웹은 OS 테마를 따른다', BUILD_ORDER HOT-291). BAT-172가 빌드 SHA-256 integrity와 생성 상수를 더한다(ADR-0326).
// 실행: pnpm --filter @peaket/web test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { colorModeScript } from '@peaket/ds/color-mode-script';

const publicFile = new URL('../../../public/seed-color-mode.js', import.meta.url);
const sriFile = new URL('./seed-color-mode-sri.ts', import.meta.url);
const buildScript = new URL('../../../scripts/build-color-mode.mjs', import.meta.url);
const rootDocument = readFileSync(new URL('../layouts/RootDocument.tsx', import.meta.url), 'utf8');
const SRI_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

test('public/seed-color-mode.js는 붙인 SEED 판이 만드는 system 모드 스크립트와 같다(SEED를 올리면 pnpm --filter @peaket/web color-mode로 다시 만든다)', () => {
  assert.equal(readFileSync(publicFile, 'utf8'), colorModeScript('system'));
});

test('루트 문서는 색 모드 스크립트를 같은 출처 파일로 <head>에서 싣고(인라인 아님), 요청 화면은 nonce와 빌드 integrity를 붙인다', () => {
  const tag = /<script\b[^>]*src="\/seed-color-mode\.js"[^>]*>/.exec(rootDocument)?.[0] ?? '';
  assert.ok(tag, '루트 문서에 <script src="/seed-color-mode.js"> 태그가 없다');
  assert.match(tag, /\bnonce=\{nonce\}/, tag);
  assert.match(tag, /\bintegrity=\{SEED_COLOR_MODE_SRI\}/, tag);
  assert.match(rootDocument, /import \{ SEED_COLOR_MODE_SRI \} from '\.\.\/theme\/seed-color-mode-sri';/);
  assert.doesNotMatch(rootDocument, /dangerouslySetInnerHTML/);
  assert.match(rootDocument, /data-seed-color-mode="system"/);
});

test('BAT-172 seed-color-mode-sri.ts의 SEED_COLOR_MODE_SRI는 public 파일 바이트 SHA-256과 같다', () => {
  const source = readFileSync(sriFile, 'utf8');
  const value = /export const SEED_COLOR_MODE_SRI = '([^']*)';/.exec(source)?.[1];
  assert.match(value ?? '', SRI_PATTERN, `생성 상수가 sha256-… 꼴이 아니다: ${value}`);
  const want = `sha256-${createHash('sha256').update(readFileSync(publicFile)).digest('base64')}`;
  assert.equal(value, want, '생성 상수가 public/seed-color-mode.js 바이트 SHA-256과 다르다: pnpm --filter @peaket/web color-mode');
});

test('BAT-172 build-color-mode.mjs --check는 public 파일과 생성 상수를 함께 보고 다르면 1로 끝난다', () => {
  const out = execFileSync(process.execPath, [fileURLToPath(buildScript), '--check'], { encoding: 'utf8' });
  assert.match(out, /SRI 상수/);
});
