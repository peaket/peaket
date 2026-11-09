// 소비자 웹이 운영체제 테마를 따르게 하는 키트 규칙 시험(docs/design/d1 §4 '소비자 웹과 파트너 콘솔은 OS 테마를 따른다',
// d2 §1, BUILD_ORDER HOT-291). SEED 색 모드 스크립트(@seed-design/css/theming)가 html에 data-seed-user-color-scheme을 달면
// 키트 변수(.pk)와 맨 바깥 color-scheme이 다크로 바뀐다. light-only·dark-only(스캐너·Storybook)와 스크립트를 싣지 않는 앱은 그대로다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const OS_DARK = ':root[data-seed-color-mode="system"][data-seed-user-color-scheme="dark"]';
const kit = readFileSync(new URL('../src/gen/kit-tokens.css', import.meta.url), 'utf8');
const ds = readFileSync(new URL('../src/styles/ds.css', import.meta.url), 'utf8');

/** 블록 머리(선택자 목록) → 그 블록의 변수 이름들 */
function blocks(css) {
  const out = new Map();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    out.set(sel, [...m[2].matchAll(/(--[\w-]+):/g)].map((x) => x[1]));
  }
  return out;
}

test('키트 다크 블록은 .pk.dark와 운영체제 다크(SEED system + dark) 아래의 .pk에 함께 걸린다', () => {
  const b = blocks(kit);
  const dark = [...b.keys()].find((s) => s.split(',').map((x) => x.trim()).includes('.pk.dark'));
  assert.ok(dark, '다크 블록이 없다');
  const sels = dark.split(',').map((x) => x.trim());
  assert.ok(sels.includes(`${OS_DARK} .pk`), sels.join(' | '));
  assert.ok(b.get(dark).includes('--surface'));
  // 라이트·전용 모드 선택자는 다크 블록에 없다
  assert.ok(!sels.some((s) => s.includes('light-only') || s.includes('"light"')));
});

test('맨 바깥 color-scheme도 운영체제 다크에서 dark다(밝은 바깥 스크롤바가 어두운 화면 옆에 남지 않게)', () => {
  const rule = new RegExp(`${OS_DARK.replace(/[[\]().*+?^$|\\]/g, '\\$&')}:has\\(\\.pk\\)\\s*\\{\\s*color-scheme:\\s*dark`);
  assert.match(ds, rule);
});

test('kit.css의 다크 규칙(변수 밖)도 모두 운영체제 다크에 함께 걸린다(.pk.dark만 쓴 규칙이 남지 않는다): 좌석 무늬·로고·맨 바깥 color-scheme', () => {
  const kitCss = readFileSync(new URL('../src/styles/kit.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const sels = [...kitCss.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => s.includes('.pk.dark'));
  assert.ok(sels.length >= 7, `다크 규칙 ${sels.length}개`);
  for (const s of sels) {
    for (const part of s.split(/,(?![^()]*\))/)) {
      if (!part.includes('.pk.dark')) continue;
      assert.ok(part.includes(`:is(.pk.dark, ${OS_DARK} .pk)`), `운영체제 다크 짝이 없는 다크 규칙: ${part.trim()}`);
    }
  }
});
