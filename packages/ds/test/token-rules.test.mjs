// 토큰 형식 검사(FE-T45)와 토큰 대비 계산(FE-T44)의 규칙 시험(docs/frontend.md §5.17, BUILD_ORDER BAS-170).
// 규칙 본체는 scripts/token-rules.mjs의 공개 함수이고, 정본 파일(tokens.json·d2 §5)을 읽는 시험은 tokens-canon.test.mjs에 있다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lintTokens,
  seedVarsFromCss,
  seedColorModeSelectors,
  checkSeedSelectors,
  relativeLuminance,
  contrastRatio,
  parseContrastTable,
  checkContrast,
} from '../scripts/token-rules.mjs';

/** SEED 쪽 입력의 기본값: 변수 몇 개와 중단점 */
const SEED = {
  vars: new Set(['--seed-color-fg-neutral', '--seed-color-bg-layer-default', '--seed-dimension-x1', '--seed-font-family']),
  breakpoints: { base: 0, sm: 480, md: 768 },
};
const BP = {
  breakpoint: {
    sm: { $type: 'dimension', $value: '480px', $extensions: { seed: 'breakpoints.sm' } },
    md: { $type: 'dimension', $value: '768px', $extensions: { seed: 'breakpoints.md' } },
  },
};
/** 문제 없는 작은 토큰 묶음에 덮어쓸 부분만 더한다 */
const tokens = (extra = {}) => ({ ...BP, ...extra });
const lint = (extra, seed = SEED) => lintTokens(tokens(extra), seed);
const has = (problems, re) => problems.some((p) => re.test(p));

// ---------------------------------------------------------------- FE-T45 ① 이름

test('FE-T45 ① 문제 없는 토큰 묶음은 위반이 없다', () => {
  const problems = lint({
    color: {
      $type: 'color',
      gray: { 0: { $value: '#ffffff' }, 1000: { $value: '#1a1c20', $extensions: { seed: '$color.fg.neutral' } } },
      text: { $value: '{color.gray.1000}' },
    },
  });
  assert.deepEqual(problems, []);
});

test('FE-T45 ① 토큰·그룹 이름의 마침표·중괄호와 $로 시작하는 이름은 위반이다', () => {
  for (const bad of ['a.b', 'a{b', 'b}', '$bad']) {
    const problems = lint({ color: { [bad]: { $type: 'color', $value: '#ffffff' } } });
    assert.ok(has(problems, /이름/), `${bad}: ${problems.join(' / ')}`);
  }
  // 그룹 이름도 같은 규칙이다
  const problems = lint({ 'my.group': { x: { $type: 'color', $value: '#ffffff' } } });
  assert.ok(has(problems, /my\.group/), problems.join(' / '));
});

test('FE-T45 ① 값($value)을 가진 토큰 아래에 토큰·그룹을 두면 위반이다(DTCG: 토큰은 자식을 갖지 않는다)', () => {
  const problems = lint({ c: { $type: 'color', a: { $value: '#ffffff', b: { $value: '#000000' }, g: { x: { $value: '#000000' } } } } });
  assert.ok(has(problems, /c\.a\.b.*토큰 아래/), problems.join(' / '));
  assert.ok(has(problems, /c\.a\.g.*토큰 아래/), problems.join(' / '));
  // 자식은 토큰으로 세지 않는다(별칭으로 가리킬 수 없다)
  assert.ok(has(lint({ c: { $type: 'color', a: { $value: '#ffffff', b: { $value: '#000000' } }, r: { $value: '{c.a.b}' } } }), /c\.r.*c\.a\.b/));
});

test('FE-T45 ① DTCG가 정한 $ 속성($type·$value·$description·$extensions·$deprecated·$schema)은 이름 위반이 아니다', () => {
  const problems = lintTokens(
    { $schema: 'x', $description: 'd', ...BP, color: { $type: 'color', $description: '그룹', a: { $value: '#ffffff', $deprecated: true, $description: '토큰' } } },
    SEED,
  );
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------- FE-T45 ② 형식과 값 표기

test('FE-T45 ② $type이 없고 그룹에서도 물려받지 못한 토큰은 위반이다', () => {
  assert.ok(has(lint({ x: { a: { $value: '#ffffff' } } }), /x\.a.*\$type/));
});

test('FE-T45 ② 그룹의 $type을 물려받은 토큰은 형식이 있다', () => {
  assert.deepEqual(lint({ x: { $type: 'color', a: { $value: '#ffffff' } } }), []);
});

test('FE-T45 ② DTCG에 없는 형식 이름은 위반이다', () => {
  assert.ok(has(lint({ x: { $type: 'colour', $value: '#ffffff' } }), /colour/));
});

test('FE-T45 ② 색은 #rrggbb·#rrggbbaa만 받는다', () => {
  for (const ok of ['#ffffff', '#00000014', '#ABCDEF']) assert.deepEqual(lint({ c: { $type: 'color', $value: ok } }), [], ok);
  for (const bad of ['#fff', 'red', '#gggggg', 'rgb(0,0,0)', 255]) {
    assert.ok(has(lint({ c: { $type: 'color', $value: bad } }), /c.*색/), String(bad));
  }
});

test('FE-T45 ② 치수는 px·rem 수만 받는다', () => {
  for (const ok of ['0px', '16px', '1.5rem', '-4px', '0.5px']) assert.deepEqual(lint({ d: { $type: 'dimension', $value: ok } }), [], ok);
  for (const bad of ['16', '16em', 'px', '1.2.3px', 16]) {
    assert.ok(has(lint({ d: { $type: 'dimension', $value: bad } }), /d.*치수/), String(bad));
  }
});

test('FE-T45 ② 시간은 ms 수만 받는다', () => {
  assert.deepEqual(lint({ t: { $type: 'duration', $value: '200ms' } }), []);
  for (const bad of ['0.2s', '200', 'ms', -1]) assert.ok(has(lint({ t: { $type: 'duration', $value: bad } }), /t.*시간/), String(bad));
});

test('FE-T45 ② 3차 베지어는 수 넷이고 x 둘은 0~1이다', () => {
  assert.deepEqual(lint({ e: { $type: 'cubicBezier', $value: [0, 0, 0.15, 1] } }), []);
  assert.deepEqual(lint({ e: { $type: 'cubicBezier', $value: [0.35, -0.5, 0.95, 1.55] } }), []);
  for (const bad of [[0, 0, 1], [2, 0, 0, 1], [0, 0, 1.2, 1], ['0', 0, 0, 1], 'ease']) {
    assert.ok(has(lint({ e: { $type: 'cubicBezier', $value: bad } }), /e.*베지어/), JSON.stringify(bad));
  }
});

test('FE-T45 ② 그림자는 칸 다섯(색·x·y·흐림·퍼짐)이고 칸마다 형식이 맞아야 한다', () => {
  const sh = { color: '#00000014', offsetX: '0px', offsetY: '1px', blur: '4px', spread: '0px' };
  assert.deepEqual(lint({ s: { $type: 'shadow', $value: sh } }), []);
  assert.deepEqual(lint({ s: { $type: 'shadow', $value: [sh, { ...sh, inset: true }] } }), []);
  const { blur, ...noBlur } = sh;
  for (const bad of [noBlur, { ...sh, color: 'black' }, { ...sh, offsetY: '1' }, { ...sh, inset: 'yes' }, '0 1px 4px #000']) {
    assert.ok(has(lint({ s: { $type: 'shadow', $value: bad } }), /s.*그림자/), JSON.stringify(bad));
  }
});

test('FE-T45 ② 글꼴 굵기는 1~1000 수, 글꼴은 글이나 글 배열, 수는 유한한 수다', () => {
  assert.deepEqual(lint({ w: { $type: 'fontWeight', $value: 400 } }), []);
  for (const bad of [0, 1001, '400', 'bold']) assert.ok(has(lint({ w: { $type: 'fontWeight', $value: bad } }), /w.*굵기/), String(bad));
  assert.deepEqual(lint({ f: { $type: 'fontFamily', $value: 'Pretendard, sans-serif' } }), []);
  assert.deepEqual(lint({ f: { $type: 'fontFamily', $value: ['Pretendard', 'sans-serif'] } }), []);
  for (const bad of ['', [], [1], 3]) assert.ok(has(lint({ f: { $type: 'fontFamily', $value: bad } }), /f.*글꼴/), JSON.stringify(bad));
  assert.deepEqual(lint({ n: { $type: 'number', $value: 10 } }), []);
  for (const bad of ['10', Number.NaN, Number.POSITIVE_INFINITY]) assert.ok(has(lint({ n: { $type: 'number', $value: bad } }), /n.*수/), String(bad));
});

// ---------------------------------------------------------------- FE-T45 ③ 별칭

test('FE-T45 ③ 별칭은 있는 토큰으로 풀리고, 값 형식은 풀린 값으로 본다', () => {
  assert.deepEqual(lint({ c: { $type: 'color', a: { $value: '#ffffff' }, b: { $value: '{c.a}' }, d: { $value: '{c.b}' } } }), []);
});

test('FE-T45 ③ 없는 토큰·그룹을 가리키는 별칭은 위반이다', () => {
  assert.ok(has(lint({ c: { $type: 'color', b: { $value: '{c.none}' } } }), /c\.b.*c\.none/));
  assert.ok(has(lint({ c: { $type: 'color', g: { a: { $value: '#ffffff' } }, b: { $value: '{c.g}' } } }), /c\.b.*c\.g/));
});

test('FE-T45 ③ 도는 별칭은 위반이다', () => {
  const problems = lint({ c: { $type: 'color', a: { $value: '{c.b}' }, b: { $value: '{c.a}' } } });
  assert.ok(has(problems, /돈다|순환/), problems.join(' / '));
});

test('FE-T45 ③ 별칭이 형식이 다른 토큰을 가리키면 위반이다', () => {
  const problems = lint({ c: { $type: 'color', a: { $value: '#ffffff' } }, d: { $type: 'dimension', x: { $value: '{c.a}' } } });
  assert.ok(has(problems, /d\.x.*형식/), problems.join(' / '));
});

test('FE-T45 ③ 값 안에 섞인 별칭(그림자 칸)도 풀어서 본다', () => {
  const sh = (color) => ({ color, offsetX: '0px', offsetY: '1px', blur: '4px', spread: '0px' });
  assert.deepEqual(lint({ c: { $type: 'color', a: { $value: '#00000014' } }, s: { $type: 'shadow', $value: sh('{c.a}') } }), []);
  assert.ok(has(lint({ c: { $type: 'color', a: { $value: '#00000014' } }, s: { $type: 'shadow', $value: sh('{c.none}') } }), /s.*c\.none/));
});

test('FE-T45 ③ 배열 값 안의 별칭(글꼴 배열·3차 베지어의 수)도 풀어서 본다', () => {
  const font = (sans) => ({ f: { $type: 'fontFamily', base: { $value: 'Pretendard' }, sans: { $value: sans } } });
  assert.deepEqual(lint(font(['{f.base}', 'sans-serif'])), []);
  assert.ok(has(lint(font(['{f.none}', 'sans-serif'])), /f\.sans.*f\.none/));
  // 글꼴 배열 칸이 다른 형식(색)을 가리키면 위반이다
  const mixed = lint({ c: { $type: 'color', a: { $value: '#ffffff' } }, f: { $type: 'fontFamily', $value: ['{c.a}', 'sans-serif'] } });
  assert.ok(has(mixed, /^f: .*형식/), mixed.join(' / '));
  // 배열을 가진 글꼴 토큰을 배열 칸에서 가리키면 배열 속 배열이 되어 위반이다
  assert.ok(has(lint({ f: { $type: 'fontFamily', a: { $value: ['A', 'B'] }, b: { $value: ['{f.a}', 'C'] } } }), /f\.b.*글꼴/));
  // 배열 칸끼리 도는 별칭도 잡는다(끝없이 풀지 않는다)
  assert.ok(has(lint({ f: { $type: 'fontFamily', a: { $value: ['{f.b}'] }, b: { $value: ['{f.a}'] } } }), /돈다/));
  const bez = (x) => ({ n: { $type: 'number', x: { $value: 0.35 } }, e: { $type: 'cubicBezier', $value: [x, 0, 1, 1] } });
  assert.deepEqual(lint(bez('{n.x}')), []);
  assert.ok(has(lint(bez('{n.none}')), /^e: .*n\.none/));
});

test('FE-T45 ③ 묶음 형식(글자 모양·테두리·전환)의 칸 안 별칭도 풀고 칸의 형식과 견준다', () => {
  const base = {
    f: { $type: 'fontFamily', a: { $value: 'Pretendard' } },
    d: { $type: 'dimension', s: { $value: '16px' } },
    c: { $type: 'color', a: { $value: '#ffffff' } },
    m: { $type: 'duration', t: { $value: '200ms' } },
  };
  const typo = (extra) => ({ ...base, t: { $type: 'typography', $value: { fontFamily: '{f.a}', fontSize: '{d.s}', fontWeight: 400, lineHeight: 1.5, letterSpacing: '0px', ...extra } } });
  assert.deepEqual(lint(typo({})), []);
  assert.ok(has(lint(typo({ fontFamily: '{f.none}' })), /^t: .*f\.none/));
  assert.ok(has(lint(typo({ fontFamily: ['{f.none}', 'x'] })), /^t: .*f\.none/));
  const wrong = lint(typo({ fontSize: '{f.a}' }));
  assert.ok(has(wrong, /^t: .*f\.a.*형식/), wrong.join(' / '));
  assert.deepEqual(lint({ ...base, b: { $type: 'border', $value: { color: '{c.a}', width: '{d.s}', style: 'solid' } } }), []);
  assert.ok(has(lint({ ...base, b: { $type: 'border', $value: { color: '{d.s}', width: '1px', style: 'solid' } } }), /^b: .*형식/));
  assert.ok(has(lint({ ...base, x: { $type: 'transition', $value: { duration: '{m.none}', delay: '0ms', timingFunction: [0, 0, 1, 1] } } }), /^x: .*m\.none/));
});

test('FE-T45 ③ 글 안에 섞은 별칭(값 전체가 아닌 {…})은 풀리지 않으므로 위반이다', () => {
  const problems = lint({ f: { $type: 'fontFamily', a: { $value: 'Pretendard' }, b: { $value: '{f.a}, sans-serif' } } });
  assert.ok(has(problems, /f\.b.*전체/), problems.join(' / '));
  assert.ok(has(lint({ f: { $type: 'fontFamily', $value: ['x', 'a {f.a}'] } }), /^f: .*전체/));
});

// ---------------------------------------------------------------- FE-T45 ④ 확장 키

test('FE-T45 ④ 확장 키는 seed·override와 com.peaket.*만 받는다', () => {
  assert.deepEqual(lint({ x: { $type: 'number', $value: 1, $extensions: { override: '까닭', 'com.peaket.note': 1 } } }), []);
  assert.deepEqual(lint({ pattern: { $extensions: { 'com.peaket.pattern': { seat: { a: 'solid' } } } } }), []);
  for (const bad of ['foo', 'com.other.x', 'com.peaket', 'org.peaket.x']) {
    assert.ok(has(lint({ x: { $type: 'number', $value: 1, $extensions: { [bad]: 1 } } }), /확장 키/), bad);
  }
});

// ---------------------------------------------------------------- FE-T45 ⑤ SEED 대응 이름

test('FE-T45 ⑤ $extensions.seed는 붙인 SEED 판의 변수·중단점에 있어야 한다', () => {
  const ok = { c: { $type: 'color', $value: '#ffffff', $extensions: { seed: '$color.bg.layer-default' } }, f: { $type: 'fontFamily', $value: 'x', $extensions: { seed: '--seed-font-family' } } };
  assert.deepEqual(lint(ok), []);
  for (const bad of ['$color.bg.nope', '--seed-nope', 'breakpoints.xx', 'color.fg.neutral', '', 3]) {
    assert.ok(has(lint({ c: { $type: 'color', $value: '#ffffff', $extensions: { seed: bad } } }), /SEED/), String(bad));
  }
});

// ---------------------------------------------------------------- FE-T45 ⑥ 중단점

test('FE-T45 ⑥ 중단점 값은 SEED 중단점과 같고, base 밖의 SEED 중단점이 모두 있어야 한다', () => {
  assert.deepEqual(lintTokens(tokens(), SEED), []);
  const wrong = { breakpoint: { ...BP.breakpoint, md: { $type: 'dimension', $value: '760px', $extensions: { seed: 'breakpoints.md' } } } };
  assert.ok(has(lintTokens(wrong, SEED), /md.*768/));
  const missing = { breakpoint: { sm: BP.breakpoint.sm } };
  assert.ok(has(lintTokens(missing, SEED), /md/));
  const extra = { breakpoint: { ...BP.breakpoint, xs: { $type: 'dimension', $value: '360px' } } };
  assert.ok(has(lintTokens(extra, SEED), /xs/));
  assert.ok(has(lintTokens({}, SEED), /중단점/));
});

// ---------------------------------------------------------------- FE-T45 ⑦ 색 모드 선택자

const SEED_CSS = `@layer seed-base {
  :root { --seed-dimension-x1: 4px; }
  :root, :root[data-seed-color-mode="system"][data-seed-user-color-scheme="light"], :root[data-seed-color-mode="light-only"], :root [data-seed-color-mode="light-only"] {
    --seed-color-fg-neutral: #1a1c20;
  }
  :root[data-seed-color-mode="system"][data-seed-user-color-scheme="dark"],
  :root[data-seed-color-mode="dark-only"], :root [data-seed-color-mode="dark-only"] {
    --seed-color-fg-neutral: #f3f4f5;
  }
  [data-seed-color-mode="dark-only"] { color-scheme: dark; }
}`;

test('FE-T45 ⑦ SEED base에서 정의한 변수 이름을 모은다', () => {
  assert.deepEqual([...seedVarsFromCss(SEED_CSS)].sort(), ['--seed-color-fg-neutral', '--seed-dimension-x1']);
});

test('FE-T45 ⑦ SEED base의 라이트·다크 색 모드 선택자를 읽는다', () => {
  const modes = seedColorModeSelectors(SEED_CSS);
  assert.deepEqual(modes.light, [
    ':root',
    ':root[data-seed-color-mode="system"][data-seed-user-color-scheme="light"]',
    ':root[data-seed-color-mode="light-only"]',
    ':root [data-seed-color-mode="light-only"]',
  ]);
  assert.deepEqual(modes.dark, [
    ':root[data-seed-color-mode="system"][data-seed-user-color-scheme="dark"]',
    ':root[data-seed-color-mode="dark-only"]',
    ':root [data-seed-color-mode="dark-only"]',
  ]);
});

test('FE-T45 ⑦ 토큰 빌드 선택자에 SEED 선택자가 빠지면 위반이고, 피켓이 더한 선택자는 괜찮다', () => {
  const modes = seedColorModeSelectors(SEED_CSS);
  assert.deepEqual(checkSeedSelectors(modes, { light: [...modes.light], dark: ['.pk.dark', ...modes.dark] }), []);
  const problems = checkSeedSelectors(modes, { light: modes.light.slice(1), dark: modes.dark });
  assert.ok(has(problems, /라이트.*:root/), problems.join(' / '));
  assert.ok(has(checkSeedSelectors({ light: [], dark: [] }, { light: [], dark: [] }), /찾지 못했다/));
});

// ---------------------------------------------------------------- FE-T44 대비 계산

test('FE-T44 상대 휘도와 대비는 WCAG 2.2 식을 따른다', () => {
  assert.equal(relativeLuminance('#000000'), 0);
  assert.equal(relativeLuminance('#ffffff'), 1);
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#000000'), 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
  // #777777 / #ffffff는 4.48:1로 알려진 값이다(4.5:1에 못 미침)
  assert.equal(Math.round(contrastRatio('#777777', '#ffffff') * 100) / 100, 4.48);
  // 0.04045 경계 아래는 12.92로 나눈다(#0a0a0a = 10/255)
  assert.equal(relativeLuminance('#0a0a0a'), 10 / 255 / 12.92);
});

const TABLE = `# D2

## 5. 색 대비 검증

설명.

| 전경색(Foreground) / 배경색(Background) | 요구 기준 | 라이트 모드 측정치 | 다크 모드 측정치 |
| --- | --- | --- | --- |
| \`text\` / \`surface\` | 4.5:1 | 21.00 (통과) | 21.00 (통과) |
| \`seat.mine\` / \`surface\` | 3.0:1 | 4.48 (통과) | 4.48 (통과) |
| \`text-disabled\` / \`surface\` | 비활성 예외 | 1.00 | 1.00 |

## 6. 다음 절

| \`not\` / \`this\` | 4.5:1 | 1.00 | 1.00 |
`;

test('FE-T44 d2 §5 대비표의 짝·기준·측정치를 읽는다(§5 밖의 표는 읽지 않는다)', () => {
  const { rows, problems } = parseContrastTable(TABLE);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    rows.map(({ fg, bg, need, light, dark }) => ({ fg, bg, need, light, dark })),
    [
      { fg: 'text', bg: 'surface', need: 4.5, light: 21, dark: 21 },
      { fg: 'seat.mine', bg: 'surface', need: 3, light: 4.48, dark: 4.48 },
      { fg: 'text-disabled', bg: 'surface', need: null, light: 1, dark: 1 },
    ],
  );
  assert.ok(rows.every((r) => Number.isInteger(r.line) && r.line > 0));
});

test('FE-T44 대비표가 없거나 행 모양이 틀리면 문제로 낸다', () => {
  assert.ok(has(parseContrastTable('# 없음\n').problems, /§5/));
  const bad = TABLE.replace('| 4.5:1 | 21.00 (통과)', '| 4.5 | 21.00 (통과)');
  assert.ok(has(parseContrastTable(bad).problems, /기준/));
  const noNumber = TABLE.replace('| 1.00 | 1.00 |\n\n## 6', '| 없음 | 1.00 |\n\n## 6');
  assert.ok(has(parseContrastTable(noNumber).problems, /측정치/));
});

/** 대비표 시험용 토큰: 라이트·다크 모두 같은 값 */
function semantic(values) {
  return { color: { semantic: { light: values, dark: values } } };
}
const C = (v) => ({ $type: 'color', $value: v });
const ROWS = (light, dark = light, need = 4.5, fg = 'text', bg = 'surface') => [{ fg, bg, need, light, dark, line: 9 }];

test('FE-T44 기준을 넘고 표의 측정치가 계산값과 같으면 문제가 없다', () => {
  const raw = semantic({ text: C('#000000'), surface: C('#ffffff') });
  assert.deepEqual(checkContrast(raw, ROWS(21, 21)), []);
});

test('FE-T44 별칭과 점 이름(seat.mine)을 풀어 계산한다', () => {
  const raw = {
    color: {
      gray: { 1000: C('#777777') },
      semantic: { light: { seat: { mine: C('{color.gray.1000}') }, surface: C('#ffffff') }, dark: { seat: { mine: C('#777777') }, surface: C('#ffffff') } },
    },
  };
  assert.deepEqual(checkContrast(raw, ROWS(4.48, 4.48, 3, 'seat.mine')), []);
});

test('FE-T44 표의 측정치가 계산값(소수 둘째 자리)과 다르면 문제다', () => {
  const raw = semantic({ text: C('#777777'), surface: C('#ffffff') });
  const problems = checkContrast(raw, ROWS(4.49, 4.48, 3));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /라이트.*4\.49.*4\.48/);
});

test('FE-T44 기준에 못 미치면 표의 숫자가 맞아도 문제다(반올림 전 값으로 판정)', () => {
  const raw = semantic({ text: C('#777777'), surface: C('#ffffff') });
  const problems = checkContrast(raw, ROWS(4.48, 4.48, 4.5));
  assert.equal(problems.length, 2);
  assert.ok(problems.every((p) => /4\.5:1/.test(p)));
});

test('FE-T44 반올림하면 기준에 닿아도(4.496 → 4.50) 실제 대비가 모자라면 문제다', () => {
  const raw = semantic({ text: C('#6363f8'), surface: C('#ffffff') });
  assert.equal(Math.round(contrastRatio('#6363f8', '#ffffff') * 100) / 100, 4.5);
  const problems = checkContrast(raw, ROWS(4.5, 4.5, 4.5));
  assert.equal(problems.length, 2, problems.join(' / '));
  assert.ok(problems.every((p) => /4\.496:1이 기준 4\.5:1에 못 미친다/.test(p)));
});

test('FE-T44 비활성 예외 짝은 기준을 보지 않고 측정치만 맞춘다', () => {
  const raw = semantic({ text: C('#777777'), surface: C('#777777') });
  assert.deepEqual(checkContrast(raw, ROWS(1, 1, null)), []);
  assert.equal(checkContrast(raw, ROWS(1.5, 1, null)).length, 1);
});

test('FE-T44 의미 색에 없는 이름과 불투명하지 않은 색은 문제다', () => {
  const raw = semantic({ text: C('#000000'), surface: C('#ffffff'), scrim: C('#0000007a') });
  assert.ok(has(checkContrast(raw, ROWS(21, 21, 4.5, 'nope')), /nope/));
  assert.ok(has(checkContrast(raw, ROWS(21, 21, 4.5, 'scrim')), /scrim.*불투명/));
});
