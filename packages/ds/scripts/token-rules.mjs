// 토큰 검사 규칙(docs/frontend.md §5.17 FE-T44·FE-T45, docs/design/d2 §1 '단일 소스 관리 체계'·§5, BUILD_ORDER BAS-170).
// 파일을 읽지 않는 순수 함수만 둔다. 정본 파일을 읽는 것은 token-canon.mjs, 명령줄은 check-tokens.mjs다.
// 문제는 모두 '<토큰 경로>: <무엇이 틀렸나>' 꼴의 한국어 글로 돌려준다(빈 배열이면 통과).

// ---------------------------------------------------------------- SEED 색 모드 선택자
// SEED base.layered.css가 색 변수에 쓰는 선택자를 옮긴 것이다(@seed-design/css 3.0.3·3.1.0에서 확인).
// SEED는 system 모드에서 prefers-color-scheme을 CSS로 보지 않고, 색 모드 스크립트(@seed-design/css/theming)가
// html에 data-seed-user-color-scheme을 달아 고른다. 토큰 빌드(build-tokens.mjs)는 같은 선택자로 --seed-* 변수를 덮어
// SEED와 함께 바뀌게 한다. 붙인 SEED 판의 선택자가 바뀌면 FE-T45 ⑦이 잡는다.
export const LIGHT_SELECTORS = [
  ':root',
  ':root[data-seed-color-mode="system"][data-seed-user-color-scheme="light"]',
  ':root[data-seed-color-mode="light-only"]',
  ':root [data-seed-color-mode="light-only"]',
];
// 퍼블리싱 화면은 키트처럼 맨 바깥(body)의 `.pk.dark`로 다크를 켜므로(SEED 색 모드 스크립트는 아직 싣지 않는다) 그 선택자도 둔다.
export const DARK_SELECTORS = [
  '.pk.dark',
  ':root[data-seed-color-mode="system"][data-seed-user-color-scheme="dark"]',
  ':root[data-seed-color-mode="dark-only"]',
  ':root [data-seed-color-mode="dark-only"]',
];

// ---------------------------------------------------------------- DTCG 이름과 형식
/** DTCG가 정한 $ 속성. 이것 말고 $로 시작하는 이름은 쓰지 않는다 */
const DTCG_PROPS = new Set(['$type', '$value', '$description', '$extensions', '$deprecated', '$schema']);
/** DTCG 형식 이름(2025.10 판). 값 표기를 보는 것은 tokens.json이 쓰는 여덟이다 */
const DTCG_TYPES = new Set([
  'color', 'dimension', 'fontFamily', 'fontWeight', 'duration', 'cubicBezier', 'number',
  'strokeStyle', 'border', 'transition', 'shadow', 'gradient', 'typography',
]);
/** 형식마다 문제 글에 쓰는 이름 */
const KO = { color: '색', dimension: '치수', duration: '시간', cubicBezier: '3차 베지어', shadow: '그림자', fontWeight: '글꼴 굵기', fontFamily: '글꼴', number: '수' };
const SHADOW_KEYS = ['color', 'offsetX', 'offsetY', 'blur', 'spread'];
const BAD_NAME = /[.{}]/;
const EXT_KEY = /^(seed|override|com\.peaket\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*)$/;
const ALIAS = /^\{([^{}]+)\}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const show = (v) => JSON.stringify(v);

/** 별칭이 아닌 값 하나가 형식 표기에 맞는지. 맞으면 null, 아니면 까닭 */
function formatError(type, value) {
  switch (type) {
    case 'color':
      return typeof value === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? null : `색 값은 #rrggbb·#rrggbbaa여야 한다(받은 값 ${show(value)})`;
    case 'dimension':
      return typeof value === 'string' && /^-?(\d+(\.\d+)?|\.\d+)(px|rem)$/.test(value) ? null : `치수 값은 px·rem을 붙인 수여야 한다(받은 값 ${show(value)})`;
    case 'duration':
      return typeof value === 'string' && /^(\d+(\.\d+)?|\.\d+)ms$/.test(value) ? null : `시간 값은 ms를 붙인 0 이상의 수여야 한다(받은 값 ${show(value)})`;
    case 'cubicBezier': {
      const ok =
        Array.isArray(value) &&
        value.length === 4 &&
        value.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
        value[0] >= 0 && value[0] <= 1 && value[2] >= 0 && value[2] <= 1;
      return ok ? null : `3차 베지어 값은 수 넷이고 첫째·셋째(x)는 0~1이어야 한다(받은 값 ${show(value)})`;
    }
    case 'fontWeight':
      return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 1000 ? null : `글꼴 굵기 값은 1~1000의 수여야 한다(받은 값 ${show(value)})`;
    case 'fontFamily': {
      const ok =
        (typeof value === 'string' && value.trim() !== '') ||
        (Array.isArray(value) && value.length > 0 && value.every((s) => typeof s === 'string' && s.trim() !== ''));
      return ok ? null : `글꼴 값은 빈 글이 아닌 글이나 글 배열이어야 한다(받은 값 ${show(value)})`;
    }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `수 값은 유한한 수여야 한다(받은 값 ${show(value)})`;
    default:
      return null; // tokens.json이 쓰지 않는 형식은 형식 이름만 본다
  }
}

/** 토큰 묶음을 훑어 토큰·그룹 목록과 이름·형식·확장 키 문제를 모은다 */
function collect(raw) {
  const tokens = new Map(); // 경로 → { node, type }
  const groups = new Set();
  const problems = [];
  const extCheck = (node, where) => {
    if (node.$extensions === undefined) return;
    if (!isObj(node.$extensions)) {
      problems.push(`${where}: $extensions는 객체여야 한다`);
      return;
    }
    for (const key of Object.keys(node.$extensions)) {
      if (!EXT_KEY.test(key)) problems.push(`${where}: 확장 키 ${show(key)}는 seed·override나 역도메인 com.peaket.*여야 한다`);
    }
  };
  const visit = (node, path, inherited) => {
    const where = path.join('.') || '(뿌리)';
    if (!isObj(node)) {
      problems.push(`${where}: 토큰이나 그룹(객체)이어야 한다(받은 값 ${show(node)})`);
      return;
    }
    if (node.$type !== undefined && !DTCG_TYPES.has(node.$type)) problems.push(`${where}: DTCG에 없는 형식 ${show(node.$type)}`);
    const type = node.$type ?? inherited;
    extCheck(node, where);
    if ('$value' in node) {
      tokens.set(where, { node, type, path });
      if (type === undefined) problems.push(`${where}: $type이 없다(그룹에서도 물려받지 못했다)`);
    } else if (path.length > 0) {
      groups.add(where);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) {
        if (!DTCG_PROPS.has(key)) problems.push(`${[...path, key].join('.')}: 이름이 $로 시작한다(DTCG가 정한 속성이 아니다)`);
        continue;
      }
      if (BAD_NAME.test(key)) problems.push(`${[...path, key].join('.')}: 이름에 마침표·중괄호를 쓸 수 없다`);
      if (key === '') problems.push(`${where}: 빈 이름이 있다`);
      visit(child, [...path, key], type);
    }
  };
  visit(raw, [], undefined);
  return { tokens, groups, problems };
}

/**
 * 값 하나를 끝까지 푼다. 별칭이면 가리키는 토큰의 값을 따라가고, 돌거나 없으면 문제를 남긴다.
 * want가 있으면 별칭이 가리킨 토큰의 형식이 want와 같아야 한다. 풀지 못하면 undefined.
 */
function resolveValue(ctx, value, where, want, stack = []) {
  if (typeof value !== 'string') return value;
  const m = ALIAS.exec(value);
  if (!m) return value;
  const target = m[1];
  if (stack.includes(target)) {
    ctx.problems.push(`${where}: 별칭이 돈다(${[...stack, target].join(' → ')})`);
    return undefined;
  }
  const hit = ctx.tokens.get(target);
  if (!hit) {
    ctx.problems.push(`${where}: 별칭 ${value}${ctx.groups.has(target) ? '는 그룹을 가리킨다' : '이 가리키는 토큰이 없다'}`);
    return undefined;
  }
  if (want !== undefined && hit.type !== want) {
    ctx.problems.push(`${where}: 별칭 ${value}의 형식 ${hit.type}이 기대한 형식 ${want}과 다르다`);
    return undefined;
  }
  return resolveValue(ctx, hit.node.$value, where, hit.type, [...stack, target]);
}

/** 그림자 값(객체 하나나 배열) 검사. 칸마다 별칭을 풀어 본다 */
function shadowErrors(ctx, value, where) {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || !list.every(isObj)) return [`그림자 값은 칸 다섯(color·offsetX·offsetY·blur·spread)을 가진 객체(또는 그 배열)여야 한다(받은 값 ${show(value)})`];
  const errors = [];
  for (const sh of list) {
    for (const key of SHADOW_KEYS) if (!(key in sh)) errors.push(`그림자 값에 ${key} 칸이 없다`);
    for (const key of Object.keys(sh)) if (![...SHADOW_KEYS, 'inset'].includes(key)) errors.push(`그림자 값에 모르는 칸 ${key}가 있다`);
    if ('inset' in sh && typeof sh.inset !== 'boolean') errors.push(`그림자 inset은 참·거짓이어야 한다(받은 값 ${show(sh.inset)})`);
    for (const key of SHADOW_KEYS) {
      if (!(key in sh)) continue;
      const sub = key === 'color' ? 'color' : 'dimension';
      const v = resolveValue(ctx, sh[key], where, sub);
      if (v === undefined) continue;
      const e = formatError(sub, v);
      if (e) errors.push(`그림자 ${key}: ${e}`);
    }
  }
  return errors;
}

/** `$extensions.seed` 값 → 확인할 SEED 이름. 형식이 틀리면 null */
function seedTarget(s) {
  if (typeof s !== 'string') return null;
  if (/^\$[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(s)) return { kind: 'var', name: `--seed-${s.slice(1).replaceAll('.', '-')}` };
  if (/^--seed-[A-Za-z0-9_-]+$/.test(s)) return { kind: 'var', name: s };
  const bp = /^breakpoints\.([A-Za-z0-9_-]+)$/.exec(s);
  if (bp) return { kind: 'breakpoint', name: bp[1] };
  return null;
}

/**
 * FE-T45 ①~⑥: tokens.json 형식 검사.
 * @param {object} raw tokens.json을 읽은 객체
 * @param {{ vars: Set<string>, breakpoints: Record<string, number> }} seed 붙인 @seed-design/css 판의 변수 이름과 중단점
 * @returns {string[]} 문제 목록
 */
export function lintTokens(raw, seed) {
  const ctx = collect(raw);
  const { tokens, problems } = ctx;
  for (const [where, { node, type }] of tokens) {
    // ② ③ 값 표기(별칭은 풀어서)
    if (type !== undefined && DTCG_TYPES.has(type)) {
      if (type === 'shadow') {
        const v = resolveValue(ctx, node.$value, where, 'shadow');
        if (v !== undefined) for (const e of shadowErrors(ctx, v, where)) problems.push(`${where}: ${e}`);
      } else {
        const v = resolveValue(ctx, node.$value, where, type);
        if (v !== undefined) {
          const e = formatError(type, v);
          if (e) problems.push(`${where}: ${e}`);
        }
      }
    }
    // ⑤ SEED 대응 이름
    const s = node.$extensions?.seed;
    if (s !== undefined) {
      const t = seedTarget(s);
      if (!t) problems.push(`${where}: $extensions.seed ${show(s)}는 SEED 이름 형식($경로·--seed-*·breakpoints.*)이 아니다`);
      else if (t.kind === 'var' && !seed.vars.has(t.name)) problems.push(`${where}: SEED 변수 ${t.name}이 붙인 SEED 판에 없다`);
      else if (t.kind === 'breakpoint' && !(t.name in seed.breakpoints)) problems.push(`${where}: SEED 중단점 ${t.name}이 붙인 SEED 판에 없다`);
    }
  }
  // ⑥ 중단점: tokens.json breakpoint 묶음이 SEED 중단점(base 밖)과 이름·값 모두 같아야 한다
  const bpGroup = raw.breakpoint;
  if (!isObj(bpGroup)) {
    problems.push('breakpoint: 중단점 그룹이 없다');
  } else {
    const ours = Object.entries(bpGroup).filter(([k, v]) => !k.startsWith('$') && isObj(v) && '$value' in v);
    const seedNames = Object.keys(seed.breakpoints).filter((n) => n !== 'base');
    for (const [name, tok] of ours) {
      if (!(name in seed.breakpoints) || name === 'base') {
        problems.push(`breakpoint.${name}: SEED 중단점에 없는 이름이다(SEED: ${seedNames.join('·')})`);
        continue;
      }
      const want = `${seed.breakpoints[name]}px`;
      if (tok.$value !== want) problems.push(`breakpoint.${name}: ${show(tok.$value)}가 SEED 중단점 ${name} ${want}와 다르다`);
    }
    for (const name of seedNames) {
      if (!ours.some(([k]) => k === name)) problems.push(`breakpoint.${name}: SEED 중단점 ${name}(${seed.breakpoints[name]}px)이 tokens.json에 없다`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- SEED base CSS 읽기
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** SEED base CSS가 정의하는 변수 이름(`--seed-*: …`) */
export function seedVarsFromCss(css) {
  return new Set([...stripComments(css).matchAll(/(--seed-[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]));
}

/** SEED base CSS에서 색 변수(--seed-color-*)를 정의하는 라이트·다크 블록의 선택자(처음 나온 차례) */
export function seedColorModeSelectors(css) {
  const light = [];
  const dark = [];
  for (const m of stripComments(css).matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    if (!/--seed-color-/.test(m[2])) continue;
    const sels = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const into = sels.includes(':root[data-seed-color-mode="light-only"]') ? light : sels.includes(':root[data-seed-color-mode="dark-only"]') ? dark : null;
    if (!into) continue;
    for (const s of sels) if (!into.includes(s)) into.push(s);
  }
  return { light, dark };
}

/** FE-T45 ⑦: 토큰 빌드 선택자(ours)가 SEED 색 모드 선택자(modes)를 모두 담는가 */
export function checkSeedSelectors(modes, ours) {
  if (modes.light.length === 0 || modes.dark.length === 0) return ['SEED base에서 색 모드 선택자(light-only·dark-only 블록)를 찾지 못했다'];
  const problems = [];
  for (const [ko, seedSels, ourSels] of [['라이트', modes.light, ours.light], ['다크', modes.dark, ours.dark]]) {
    for (const s of seedSels) if (!ourSels.includes(s)) problems.push(`${ko} 선택자 ${s}가 토큰 빌드(LIGHT_SELECTORS·DARK_SELECTORS)에 없다`);
  }
  return problems;
}

// ---------------------------------------------------------------- FE-T44 대비
/** WCAG 2.2 상대 휘도(#rrggbb) */
export function relativeLuminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 두 색의 대비(밝은 쪽 + 0.05) / (어두운 쪽 + 0.05). 순서와 무관하다 */
export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * d2 §5 '색 대비 검증'의 표를 읽는다. 행: | `전경` / `배경` | 4.5:1·3.0:1·비활성 예외 | 라이트 측정치 | 다크 측정치 |
 * @returns {{ rows: { fg: string, bg: string, need: number|null, light: number, dark: number, line: number }[], problems: string[] }}
 */
export function parseContrastTable(md) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## 5\. 색 대비 검증/.test(l));
  if (start < 0) return { rows: [], problems: ['d2 §5 대비표(## 5. 색 대비 검증)를 찾지 못했다'] };
  const rows = [];
  const problems = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const l = lines[i];
    if (!/^\|\s*`/.test(l)) continue;
    const at = `d2 ${i + 1}행`;
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    const pair = /^`([^`]+)`\s*\/\s*`([^`]+)`$/.exec(cells[0] ?? '');
    if (!pair || cells.length !== 4) {
      problems.push(`${at}: 짝 칸(\`전경\` / \`배경\`)과 칸 넷을 읽지 못했다`);
      continue;
    }
    let need;
    const n = /^(\d+(?:\.\d+)?):1$/.exec(cells[1]);
    if (n) need = Number(n[1]);
    else if (cells[1] === '비활성 예외') need = null;
    else {
      problems.push(`${at}: 요구 기준 ${show(cells[1])}를 읽지 못했다(4.5:1·3.0:1·비활성 예외)`);
      continue;
    }
    const nums = [cells[2], cells[3]].map((c) => /^(\d+(?:\.\d+)?)(\s|$)/.exec(c));
    if (nums.some((x) => !x)) {
      problems.push(`${at}: 라이트·다크 측정치를 읽지 못했다`);
      continue;
    }
    rows.push({ fg: pair[1], bg: pair[2], need, light: Number(nums[0][1]), dark: Number(nums[1][1]), line: i + 1 });
  }
  if (rows.length === 0 && problems.length === 0) problems.push('d2 §5 대비표에 짝이 없다');
  return { rows, problems };
}

/**
 * FE-T44: 대비표의 짝마다 tokens.json 의미 색으로 다시 계산해 기준과 표의 측정치를 본다.
 * @returns {string[]} 문제 목록
 */
export function checkContrast(raw, rows) {
  const ctx = collect(raw);
  const problems = [];
  for (const row of rows) {
    for (const [mode, ko] of [['light', '라이트'], ['dark', '다크']]) {
      const colors = [];
      for (const name of [row.fg, row.bg]) {
        const where = `color.semantic.${mode}.${name}`;
        const hit = ctx.tokens.get(where);
        if (!hit) {
          problems.push(`d2 ${row.line}행 ${name}(${ko}): tokens.json ${where}에 없다`);
          continue;
        }
        const sub = { tokens: ctx.tokens, groups: ctx.groups, problems: [] };
        const v = resolveValue(sub, hit.node.$value, where, 'color');
        if (v === undefined) {
          problems.push(`d2 ${row.line}행 ${name}(${ko}): ${sub.problems.join(' / ')}`);
          continue;
        }
        if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) {
          problems.push(`d2 ${row.line}행 ${name}(${ko}): 불투명한 #rrggbb가 아니다(${show(v)})`);
          continue;
        }
        colors.push(v);
      }
      if (colors.length !== 2) continue;
      const ratio = contrastRatio(colors[0], colors[1]);
      const rounded = Math.round(ratio * 100) / 100;
      const pair = `${row.fg} / ${row.bg}`;
      if (rounded !== row[mode]) problems.push(`d2 ${row.line}행 ${pair} ${ko}: 표 ${row[mode].toFixed(2)}, 계산 ${rounded.toFixed(2)}`);
      if (row.need !== null && ratio < row.need) problems.push(`d2 ${row.line}행 ${pair} ${ko}: ${ratio.toFixed(3)}:1이 기준 ${row.need.toFixed(1)}:1에 못 미친다`);
    }
  }
  return problems;
}
