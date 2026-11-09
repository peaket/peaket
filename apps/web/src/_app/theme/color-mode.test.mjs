// SEED 색 모드 스크립트 파일 시험(docs/design/d2 §1 'Next.js 앱은 SEED 색 모드 스크립트를 같은 출처 파일로 루트 레이아웃에 싣는다',
// d1 §4 '소비자 웹은 OS 테마를 따른다', BUILD_ORDER HOT-291). 실행: pnpm --filter @peaket/web test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { colorModeScript } from '@peaket/ds/color-mode-script';

const publicFile = new URL('../../../public/seed-color-mode.js', import.meta.url);
const rootDocument = readFileSync(new URL('../layouts/RootDocument.tsx', import.meta.url), 'utf8');

test('public/seed-color-mode.js는 붙인 SEED 판이 만드는 system 모드 스크립트와 같다(SEED를 올리면 pnpm --filter @peaket/web color-mode로 다시 만든다)', () => {
  assert.equal(readFileSync(publicFile, 'utf8'), colorModeScript('system'));
});

test('루트 문서는 색 모드 스크립트를 같은 출처 파일로 <head>에서 싣고(인라인 아님), 요청 화면은 nonce를 붙인다', () => {
  assert.match(rootDocument, /<script src="\/seed-color-mode\.js" nonce=\{nonce\}/);
  assert.doesNotMatch(rootDocument, /dangerouslySetInnerHTML/);
  assert.match(rootDocument, /data-seed-color-mode="system"/);
});
