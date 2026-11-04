// SEED CSS 층 검사기 시험(FE-T36 ①②③와 크기 판정에 쓰는 함수, docs/frontend.md §5.17, BUILD_ORDER BAS-170). 인수 시험 ID FE-T36은 Playwright 검사(css.spec·layers.spec)에만 단다.
// 빌드한 앱을 브라우저로 보는 시험은 layers.spec.mjs(playwright.layers.config.mjs)에 있다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { LAYER_ORDER, scanCss, checkLayerOrder, checkSeedRules, checkNoSeedAll, gzipKB, sizeLimit } from './check-css.mjs';

const ORDER = `@layer ${LAYER_ORDER.join(', ')};`;
const has = (problems, re) => problems.some((p) => re.test(p));

test('검사기 ① 층 이름을 처음 나온 차례로 모은다(선언문·블록·중첩 층)', () => {
  const { layers } = scanCss(`${ORDER}\n@layer base{a{b:c}}@layer seed-base{@layer inner{x{y:z}}}@layer extra;`);
  assert.deepEqual(layers, [...LAYER_ORDER, 'seed-base.inner', 'extra']);
});

test('검사기 ② 규칙마다 든 층을 안다(@media·@supports 안도 같은 층, @keyframes·@font-face 속은 규칙이 아니다)', () => {
  const css = `@layer components{.a{color:red}@media (min-width:1px){.b{color:red}}@supports (x:y){.c{d:e}}}
.d{color:red}
@keyframes k{from{opacity:0}to{opacity:1}}
@font-face{font-family:x;src:url(a.woff2)}
@layer utilities{.e{f:g}.h{&:hover{i:j}}}`;
  const { rules } = scanCss(css);
  assert.deepEqual(rules.map((r) => [r.selector, r.layer]), [
    ['.a', 'components'],
    ['.b', 'components'],
    ['.c', 'components'],
    ['.d', null],
    ['.e', 'utilities'],
    ['.h', 'utilities'],
    ['&:hover', 'utilities'],
  ]);
});

test('검사기 ② 주석·따옴표·url() 안의 ; { }는 규칙을 자르지 않는다', () => {
  const css = `/* @layer nope; .x{ */@layer components{.a{background:url(data:image/svg+xml;utf8,<svg>{}</svg>)}.b::after{content:"};{"}.c{d:e}}`;
  const { layers, rules } = scanCss(css);
  assert.deepEqual(layers, ['components']);
  assert.deepEqual(rules.map((r) => r.selector), ['.a', '.b::after', '.c']);
});

test('검사기 따옴표 밖 역슬래시 이스케이프(Tailwind content-[\'\'])는 문자열 시작이 아니다(리뷰 높음 1 재현)', () => {
  const css = String.raw`${ORDER}@layer utilities{.after\:content-\[\'\'\]::after{--tw-content:''}.p-6{padding:1px}}.seed-action-button{padding:0}@layer widgets{.w{a:b}}`;
  const { rules } = scanCss(css);
  assert.deepEqual(rules.map((r) => r.selector), [String.raw`.after\:content-\[\'\'\]::after`, '.p-6', '.seed-action-button', '.w']);
  assert.ok(has(checkSeedRules([css]), /seed-action-button.*층 밖/));
  assert.ok(has(checkLayerOrder([css]), /widgets/));
});

test('검사기 문자열 안의 /* 는 주석 시작이 아니다(리뷰 낮음 5 재현)', () => {
  const css = `${ORDER}@layer components{.a::before{content:"/*"}}.seed-action-button{padding:0}@layer components{.b{content:"*/"}}`;
  assert.deepEqual(scanCss(css).rules.map((r) => r.selector), ['.a::before', '.seed-action-button', '.b']);
  assert.ok(has(checkSeedRules([css]), /seed-action-button.*층 밖/));
});

test('검사기 중첩 층 a.b는 부모 층 a를 먼저 만든다', () => {
  assert.deepEqual(scanCss('@layer x.y{.a{b:c}}@layer x;').layers, ['x', 'x.y']);
  assert.deepEqual(scanCss('@layer p.q, r;').layers, ['p', 'p.q', 'r']);
});

test('검사기 ① 층 순서 선언으로 시작하는 첫 CSS는 통과한다', () => {
  assert.deepEqual(checkLayerOrder([`${ORDER}@layer components{.a{b:c}}`]), []);
});

test('검사기 ① 빌드가 선언문을 층 블록으로 바꿔도 처음 나온 차례가 같으면 통과한다(Tailwind의 properties 층은 맨 앞만)', () => {
  const built = '@layer properties{*{--tw-x:0}}@layer theme{:root{--a:1}}@layer base{*{margin:0}}@layer seed-base{:root{--seed-x:1}}@layer seed-components;@layer components{.k{a:b}}@layer utilities{.p-6{padding:1px}}';
  assert.deepEqual(checkLayerOrder([built]), []);
  const late = built.replace('@layer properties{*{--tw-x:0}}', '') + '@layer properties{*{--tw-x:0}}';
  assert.ok(has(checkLayerOrder([late]), /properties/));
});

test('검사기 ① 부품 CSS가 층 순서보다 먼저 실리면(그 층이 가장 약해진다) 실패다', () => {
  const recipeFirst = `@layer seed-components{.seed-action-button{a:b}}${ORDER}@layer components{.k{a:b}}`;
  const problems = checkLayerOrder([recipeFirst]);
  assert.ok(has(problems, /seed-components → theme/), problems.join(' / '));
});

test('검사기 ① 첫 CSS가 층 하나라도 빠뜨리거나 뒤 CSS가 새 층을 만들면 실패다', () => {
  const noSeed = '@layer theme, base, seed-base, components, utilities;';
  assert.ok(has(checkLayerOrder([noSeed]), /seed-components/));
  const later = checkLayerOrder([ORDER, '@layer seed-components{.seed-a{b:c}}', '@layer widgets{.w{a:b}}']);
  assert.ok(has(later, /widgets/), later.join(' / '));
  assert.ok(has(checkLayerOrder(['.a{b:c}']), /층/));
});

test('검사기 ① 층이 없는 앞 CSS(글꼴 @font-face 같은)는 건너뛰고 층을 가진 첫 CSS를 본다', () => {
  assert.deepEqual(checkLayerOrder(['@font-face{font-family:x;src:url(a.woff2)}', ORDER]), []);
});

test('검사기 ② SEED 클래스 규칙은 seed-base·seed-components 층 안에만 있어야 한다', () => {
  assert.deepEqual(checkSeedRules([`${ORDER}@layer seed-base{.seed-box{a:b}}@layer seed-components{.seed-action-button{a:b}}`]), []);
  const unlayered = checkSeedRules([`${ORDER}.seed-action-button{a:b}`]);
  assert.ok(has(unlayered, /seed-action-button.*층 밖/), unlayered.join(' / '));
  assert.ok(has(checkSeedRules([`${ORDER}@layer components{.seed-x{a:b}}`]), /components/));
  // 속성 선택자 [data-seed-color-mode]는 SEED 클래스가 아니다
  assert.deepEqual(checkSeedRules([`${ORDER}@layer components{:root[data-seed-color-mode="dark-only"]{--a:1}}`]), []);
});

test('검사기 ② 탐침이 쓴 recipe는 seed-components 층에 있어야 하고, 없으면 탐침이 SEED CSS를 싣지 못한 것이다', () => {
  const ok = `${ORDER}@layer seed-components{.seed-action-button{a:b}.seed-action-button--size_medium{c:d}}`;
  assert.deepEqual(checkSeedRules([ok], { recipe: 'action-button' }), []);
  assert.ok(has(checkSeedRules([ORDER], { recipe: 'action-button' }), /action-button.*없다/));
  assert.ok(has(checkSeedRules([`${ORDER}@layer seed-base{.seed-action-button{a:b}}`], { recipe: 'action-button' }), /seed-components/));
});

test('검사기 ③ SEED 전체 CSS의 표지(.seed-manner-temp)가 있으면 실패다', () => {
  assert.deepEqual(checkNoSeedAll([`${ORDER}@layer seed-base{:root{--seed-color-manner-temp-l1-bg:#fff}}`]), []);
  assert.ok(has(checkNoSeedAll([`${ORDER}@layer seed-components{.seed-manner-temp{a:b}}`]), /all/));
});

test('검사기 크기는 파일마다 gzip한 합을 kB(1,000바이트, 소수 첫째 자리)로 잰다', () => {
  // 잘 줄지 않는 글: 해시를 이어 붙인 16진 문자열
  const text = Array.from({ length: 64 }, (_, i) => createHash('sha256').update(String(i)).digest('hex')).join('');
  const one = gzipSync(Buffer.from(text)).length;
  assert.ok(one > 1000, `시험 글이 너무 잘 줄었다(${one}바이트)`);
  assert.equal(gzipKB([text]), Math.round(one / 100) / 10);
  assert.equal(gzipKB([text, text]), Math.round((one * 2) / 100) / 10);
});

test('검사기 크기 한도는 예산이고, 기준선이 예산을 넘은 경로는 기준선 + 0.5kB다', () => {
  assert.equal(sizeLimit(25, 20.3), 25);
  assert.equal(sizeLimit(25, undefined), 25);
  assert.equal(sizeLimit(25, 33.1), 33.6);
  assert.equal(sizeLimit(15, 15), 15);
});
