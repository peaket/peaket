// 화면 앱 구조 린트(ADR-0329). 소비자 웹·파트너 콘솔·관제 콘솔의 FSD 층(docs/frontend.md §2.2 '층 의존'·'Next.js 경로 폴더')을 기계로 지킨다.
// 서비스 안 구조(받는 층 → 유스케이스 → 도메인)는 service-layers.mjs가 따로 지키고, 이 파일은 화면 앱만 본다.
// - layer-direction: 층은 위에서 아래로만 가져온다(_app → _pages → widgets → features → entities → shared). 같은 층의 다른 조각끼리도 막는다.
//   문서는 이 일을 Steiger fsd/forbidden-imports에 맡겼지만 저장소에 Steiger가 없어 ESLint로 옮겼다(ADR-0329 결정 1).
// - no-slice-internals: 아래 층의 조각은 그 조각의 공개 파일로만 가져온다. 공개 파일은 index.ts(x), 브라우저 전용 browser.ts,
//   서버 전용 server/ 아래 파일이다. 공개 파일이 없는 조각은 폴더 전체가 공개다. 타입만 가져오기와 늦게 싣기 import()는 보지 않는다(ADR-0329 결정 2).
// - file-naming: .ts·.mjs는 소문자-하이픈, .tsx는 단어 첫 글자 대문자(부품 하나) 또는 소문자-하이픈(부품 묶음), 폴더는 소문자-하이픈(결정 3).
// - props-type-naming: 화면 부품 Foo가 받는 값에 이름 붙인 타입을 쓰면 그 이름은 FooProps다. 그 자리에 바로 적는 객체 타입과
//   여러 부품이 함께 쓰는 공용 이름(PageProps 등)은 받는다(결정 4).
// - route-reexport-only: Next.js app/ 경로 파일은 src/_pages·src/_app의 것을 다시 내보내기만 한다(§2.2 'Next.js 경로 폴더', 결정 5).
// 규칙을 들이기 전부터 있던 위반은 web-boundaries-baseline.json에 까닭과 함께 두고 줄이기만 한다(docs/devops.md §4.4 '보안 린트'와 같은 방식).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tsParser from '@typescript-eslint/parser';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BASELINE_FILE = fileURLToPath(new URL('./web-boundaries-baseline.json', import.meta.url));

/** 저장소 뿌리 기준 / 경로 */
const relOf = (root, file) => path.relative(root, file).split(path.sep).join('/');

// ── import 해석 ──────────────────────────────────────────────────────────────────────────────

const EXTS = ['.ts', '.tsx', '.mjs', '.js', '.d.ts'];
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** 확장자 없는 경로·폴더·`.js`로 적은 TS 경로를 실제 파일로. 못 찾으면 폴더면 폴더 경로, 아니면 null */
function resolveFile(base) {
  if (isFile(base)) return base;
  for (const e of EXTS) if (isFile(base + e)) return base + e;
  const noExt = base.replace(/\.(m?js)$/, '');
  if (noExt !== base) for (const e of EXTS) if (isFile(noExt + e)) return noExt + e;
  if (isDir(base)) {
    for (const n of ['index.ts', 'index.tsx']) if (isFile(path.join(base, n))) return path.join(base, n);
    return base;
  }
  return null;
}

/** import 문자열 → 화면 앱 src 안의 절대 경로(상대 경로와 @/ 별칭만). 바깥 패키지는 null */
function resolveImport(importer, spec, src) {
  if (spec.startsWith('.')) return resolveFile(path.resolve(path.dirname(importer), spec));
  if (spec.startsWith('@/')) return resolveFile(path.join(src, spec.slice(2)));
  return null;
}

/**
 * import 경로가 놓인 모든 자리: import·export from·export *·import()·require().
 * check(node, kind)의 kind: 'type'(타입만, 실행 때 사라짐) · 'lazy'(import(), 따로 떼어 늦게 싣기) · 'static'(그 밖)
 */
function importVisitors(check) {
  const lit = (n) => (n?.type === 'Literal' && typeof n.value === 'string' ? n : null);
  const typeOnly = (n) => n.importKind === 'type' || (n.specifiers.length > 0 && n.specifiers.every((s) => s.importKind === 'type'));
  return {
    ImportDeclaration: (n) => check(n.source, typeOnly(n) ? 'type' : 'static'),
    ExportNamedDeclaration: (n) => n.source && check(n.source, n.exportKind === 'type' ? 'type' : 'static'),
    ExportAllDeclaration: (n) => check(n.source, n.exportKind === 'type' ? 'type' : 'static'),
    ImportExpression: (n) => lit(n.source) && check(n.source, 'lazy'),
    CallExpression: (n) => n.callee.type === 'Identifier' && n.callee.name === 'require' && lit(n.arguments[0]) && check(n.arguments[0], 'static'),
  };
}

// ── 층·조각 ────────────────────────────────────────────────────────────────────────────────

/**
 * 파일이 놓인 층과 조각. 맨 위 층(app)과 맨 아래 층(shared)은 조각으로 나누지 않는다(FSD).
 * @returns {{ index: number, layer: string, slice: string | null, rest: string } | null}
 */
function placeOf(file, src, layers) {
  const parts = path.relative(src, file).split(path.sep);
  if (parts[0] === '..' || path.isAbsolute(parts[0])) return null;
  const index = layers.indexOf(parts[0]);
  if (index === -1) return null;
  const sliced = index !== 0 && index !== layers.length - 1;
  const slice = sliced && parts.length >= 2 ? parts[1] : null;
  return { index, layer: parts[0], slice, rest: parts.slice(slice ? 2 : 1).join('/') };
}

/** 조각의 공개 파일인가: index.ts(x), browser.ts(x), server/ 아래, 또는 조각 폴더 자체 */
const isEntry = (rest) => rest === '' || /^(index|browser)\.tsx?$/.test(rest) || rest.startsWith('server/');
const hasIndex = (dir) => isFile(path.join(dir, 'index.ts')) || isFile(path.join(dir, 'index.tsx'));

const appSchema = {
  type: 'object',
  properties: {
    root: { type: 'string' },
    src: { type: 'string' },
    layers: { type: 'array', items: { type: 'string' }, minItems: 2 },
    baseline: { type: 'array', items: { type: 'string' } },
  },
  required: ['src', 'layers'],
  additionalProperties: false,
};

/** 기준선 키: '파일#가져오는 경로'. 줄 수는 시험이 늘지 않게 막는다 */
const importKey = (root, file, spec) => `${relOf(root, file)}#${spec}`;

const layerDirection = {
  meta: {
    type: 'problem',
    docs: { description: '화면 앱 층은 위에서 아래로만 가져오고, 같은 층의 다른 조각끼리 가져오지 않는다(ADR-0329 결정 1)' },
    schema: [appSchema],
    messages: {
      reverse: "'{{from}}' 층은 위 층 '{{to}}'을(를) 가져오지 않는다. 층은 {{order}} 방향으로만 가져온다(docs/frontend.md §2.2 '층 의존', ADR-0329)",
      crossSlice: "'{{layer}}' 층의 '{{fromSlice}}'은(는) 같은 층의 다른 조각 '{{toSlice}}'을(를) 가져오지 않는다. 함께 쓰는 부분은 아래 층으로 내린다(ADR-0329)",
    },
  },
  create(context) {
    const { root = context.cwd, src, layers, baseline = [] } = context.options[0];
    const skip = new Set(baseline);
    const file = context.filename;
    const from = placeOf(file, src, layers);
    if (!from) return {};
    const order = layers.join(' → ');
    return importVisitors((node) => {
      const target = resolveImport(file, node.value, src);
      const to = target && placeOf(target, src, layers);
      if (!to || skip.has(importKey(root, file, node.value))) return;
      if (to.index < from.index) {
        context.report({ node, messageId: 'reverse', data: { from: from.layer, to: to.layer, order } });
      } else if (to.index === from.index && from.slice && to.slice && from.slice !== to.slice) {
        context.report({ node, messageId: 'crossSlice', data: { layer: from.layer, fromSlice: from.slice, toSlice: to.slice } });
      }
    });
  },
};

const noSliceInternals = {
  meta: {
    type: 'problem',
    docs: { description: '다른 층의 조각은 그 조각의 공개 파일(index·browser·server/)로만 가져온다(ADR-0329 결정 2)' },
    schema: [appSchema],
    messages: {
      internal: "'{{spec}}'은(는) '{{slice}}' 조각의 안쪽 파일이다. 공개 파일 '{{entry}}'로 가져온다(브라우저 전용은 browser.ts, 서버 전용은 server/, ADR-0329)",
    },
  },
  create(context) {
    const { root = context.cwd, src, layers, baseline = [] } = context.options[0];
    const skip = new Set(baseline);
    const file = context.filename;
    const from = placeOf(file, src, layers);
    if (!from) return {};
    return importVisitors((node, kind) => {
      // 타입만 가져오기는 실행 때 사라지고, import()는 첫 화면 묶음에서 떼어 늦게 싣는 자리라 공개 파일로 모으면 안 된다(ADR-0329 결정 2)
      if (kind !== 'static') return;
      const target = resolveImport(file, node.value, src);
      const to = target && placeOf(target, src, layers);
      // 위 층·같은 층 사이는 layer-direction이 본다(같은 조각이면 안쪽 파일도 자유, 그 밖은 그 규칙이 막는다)
      if (!to || !to.slice || to.index <= from.index || isEntry(to.rest)) return;
      const sliceDir = path.join(src, to.layer, to.slice);
      if (!hasIndex(sliceDir) || skip.has(importKey(root, file, node.value))) return;
      const entry = node.value.startsWith('@/') ? `@/${to.layer}/${to.slice}` : node.value.slice(0, node.value.indexOf(to.slice) + to.slice.length);
      context.report({ node, messageId: 'internal', data: { spec: node.value, slice: `${to.layer}/${to.slice}`, entry } });
    });
  },
};

// ── 이름 ────────────────────────────────────────────────────────────────────────────────────

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
/** 프레임워크·관례가 정한 이름: index, _app·_pages, Next.js [id]·(묶음)·@슬롯, __tests__ */
const NAME_IGNORE = /^(index|_app|_pages|\[.+\]|\(.+\)|@.+|__\w+__)$/;

const fileNaming = {
  meta: {
    type: 'suggestion',
    docs: { description: '화면 앱 파일·폴더 이름 표기(ADR-0329 결정 3)' },
    schema: [{ type: 'object', properties: { src: { type: 'string' } }, required: ['src'], additionalProperties: false }],
    messages: {
      file: "파일 이름 '{{name}}'은(는) {{expected}}로 쓴다(ADR-0329)",
      dir: "폴더 '{{dir}}'의 이름 '{{name}}'은(는) 소문자-하이픈(kebab-case)으로 쓴다(ADR-0329)",
    },
  },
  create(context) {
    const { src } = context.options[0];
    const rel = path.relative(src, context.filename).split(path.sep);
    if (rel[0] === '..') return {};
    return {
      Program(node) {
        const base = rel.at(-1);
        const stem = base.split('.')[0];
        const tsx = base.endsWith('.tsx');
        const ok = (tsx ? PASCAL.test(stem) || KEBAB.test(stem) : KEBAB.test(stem)) || NAME_IGNORE.test(stem) || stem === '';
        if (!ok) {
          const expected = tsx ? '단어 첫 글자 대문자(PascalCase) 또는 소문자-하이픈(kebab-case)' : '소문자-하이픈(kebab-case)';
          context.report({ node, loc: { line: 1, column: 0 }, messageId: 'file', data: { name: stem, expected } });
        }
        rel.slice(0, -1).forEach((name, i) => {
          if (KEBAB.test(name) || NAME_IGNORE.test(name)) return;
          context.report({ node, loc: { line: 1, column: 0 }, messageId: 'dir', data: { name, dir: rel.slice(0, i + 1).join('/') } });
        });
      },
    };
  },
};

/** 노드 아래에 JSX가 있는가(안쪽 함수 포함) */
function hasJsx(root) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (Array.isArray(n)) {
      stack.push(...n);
      continue;
    }
    if (n !== root && (n.type === 'JSXElement' || n.type === 'JSXFragment')) return true;
    for (const [k, v] of Object.entries(n)) if (k !== 'parent' && k !== 'loc' && k !== 'range' && v && typeof v === 'object') stack.push(v);
  }
  return false;
}

const propsTypeNaming = {
  meta: {
    type: 'suggestion',
    docs: { description: '화면 부품 Foo가 받는 값에 이름 붙인 타입은 FooProps로 짓는다(ADR-0329 결정 4)' },
    schema: [
      {
        type: 'object',
        properties: {
          root: { type: 'string' },
          baseline: { type: 'array', items: { type: 'string' } },
          allowInline: { type: 'boolean' },
          sharedNames: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      mismatch: "부품 '{{component}}'의 받는 값 타입은 '{{expected}}'로 이름 짓는다(지금 '{{actual}}', ADR-0329)",
      inline: "부품 '{{component}}'의 받는 값을 그 자리 객체 타입으로 적었다. '{{expected}}'로 이름을 붙여 둔다(ADR-0329)",
    },
  },
  create(context) {
    const { root = context.cwd, baseline = [], allowInline = false, sharedNames = [] } = context.options[0] ?? {};
    const skip = new Set(baseline);
    const shared = new Set(sharedNames);
    const check = (name, fn) => {
      if (!PASCAL.test(name) || !hasJsx(fn)) return;
      const annotation = fn.params[0]?.typeAnnotation?.typeAnnotation;
      if (!annotation || skip.has(`${relOf(root, context.filename)}#${name}`)) return;
      const expected = `${name}Props`;
      if (annotation.type === 'TSTypeLiteral') {
        if (allowInline) return;
        context.report({ node: annotation, messageId: 'inline', data: { component: name, expected } });
        return;
      }
      // Readonly<FooProps>, A & B, NS.FooProps 같은 감싼 타입은 판단하지 않는다
      if (annotation.type !== 'TSTypeReference' || annotation.typeName.type !== 'Identifier' || annotation.typeArguments) return;
      if (annotation.typeName.name !== expected && !shared.has(annotation.typeName.name)) {
        context.report({ node: annotation, messageId: 'mismatch', data: { component: name, expected, actual: annotation.typeName.name } });
      }
    };
    return {
      FunctionDeclaration: (n) => n.id && check(n.id.name, n),
      VariableDeclarator: (n) => {
        if (n.id.type === 'Identifier' && (n.init?.type === 'ArrowFunctionExpression' || n.init?.type === 'FunctionExpression')) check(n.id.name, n.init);
      },
    };
  },
};

// ── Next.js 경로 파일 ────────────────────────────────────────────────────────────────────────

/** 경로 파일에 직접 적어야 하는 Next.js 경로 설정 이름(다시 내보내기로는 읽지 못한다). 값은 글자·수·참거짓만 받는다 */
const SEGMENT_CONFIG = new Set(['dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration', 'instant', 'experimental_ppr']);
const isPlainLiteral = (n) => n?.type === 'Literal' || (n?.type === 'UnaryExpression' && n.argument.type === 'Literal');

const routeReexportOnly = {
  meta: {
    type: 'problem',
    docs: { description: 'Next.js app/ 경로 파일은 src/_pages·src/_app의 것을 다시 내보내기만 한다(ADR-0329 결정 5)' },
    schema: [{ type: 'object', properties: { root: { type: 'string' }, baseline: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      logic: "경로 파일은 src/_pages·src/_app의 것을 다시 내보내기만 한다. 이 코드는 그쪽 조각으로 옮기고 여기서는 export {{ … }} from 으로 잇는다(docs/frontend.md §2.2 'Next.js 경로 폴더', ADR-0329)",
    },
  },
  create(context) {
    const { root = context.cwd, baseline = [] } = context.options[0] ?? {};
    if (new Set(baseline).has(relOf(root, context.filename))) return {};
    const allowed = (s) => {
      if (s.type === 'ExpressionStatement' && s.directive) return true; // 'use client'·'use server'
      if (s.type === 'ImportDeclaration' || s.type === 'ExportAllDeclaration') return true;
      if (s.type === 'ExportNamedDeclaration' && !s.declaration) return true; // export { a } from '…' / export { a }
      if (s.type === 'ExportDefaultDeclaration') return s.declaration.type === 'Identifier';
      if (s.type === 'ExportNamedDeclaration' && s.declaration.type === 'VariableDeclaration') {
        return s.declaration.declarations.every((d) => d.id.type === 'Identifier' && SEGMENT_CONFIG.has(d.id.name) && isPlainLiteral(d.init));
      }
      return false;
    };
    return {
      Program(program) {
        const first = program.body.find((s) => !allowed(s));
        if (first) context.report({ node: first, messageId: 'logic' });
      },
    };
  },
};

export const webBoundariesPlugin = {
  rules: {
    'layer-direction': layerDirection,
    'no-slice-internals': noSliceInternals,
    'file-naming': fileNaming,
    'props-type-naming': propsTypeNaming,
    'route-reexport-only': routeReexportOnly,
  },
};

// ── 설정 ────────────────────────────────────────────────────────────────────────────────────

const FSD = ['_app', '_pages', 'widgets', 'features', 'entities', 'shared'];

/**
 * 여러 부품이 함께 쓰는 받는 값 타입 이름(ADR-0329 결정 4). 경로 화면들이 같은 params 꼴을 나눠 쓰는 PageProps·RouteProps,
 * 위저드 단계들이 같은 꼴을 나눠 쓰는 StepProps. 이름 하나를 여러 부품이 함께 쓸 때만 여기에 더한다.
 */
export const SHARED_PROPS_NAMES = ['PageProps', 'RouteProps', 'StepProps'];

/** FSD 층을 쓰는 화면 앱. 관제 콘솔은 Next.js가 아니라 층 이름에 밑줄을 붙이지 않는다(docs/frontend.md §2.2) */
export const WEB_BOUNDARY_APPS = [
  { app: 'apps/web', layers: FSD, routes: true },
  { app: 'apps/partner', layers: FSD, routes: true },
  { app: 'apps/console-host', layers: ['app', 'pages', 'widgets', 'features', 'entities', 'shared'], routes: false },
];

/**
 * 층 규칙이 보지 않는 파일과 까닭.
 * - 시험·이야기: 시험은 여러 조각의 안쪽을 한꺼번에 확인하고, 운영 묶음에 실리지 않는다(뿌리의 목업 금지와 같은 범위).
 * - 관제 콘솔 미리보기(apps/console-host/src/app/preview): ?state= 미리보기(ADR-0170)가 화면마다 상태 예시(pages/<화면>/states)를 모은다.
 *   상태 예시를 공개 파일에 넣으면 운영 화면 묶음에 미리보기 자료가 실린다.
 */
export const WEB_BOUNDARY_IGNORES = ['**/*.test.*', '**/*.spec.*', '**/*.stories.*', 'apps/console-host/src/app/preview/**'];

/**
 * 기준선(규칙을 들이기 전부터 있던 위반, 까닭 포함). 줄이기만 한다: web-boundaries.test.mjs가 줄 수가 늘거나 이미 고친 줄이 남으면 막는다.
 * @returns {{ rule: string, key: string, reason: string }[]}
 */
export function readWebBoundaryBaseline(file = BASELINE_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).entries;
}

/**
 * @param {{ root?: string, apps?: typeof WEB_BOUNDARY_APPS, baseline?: { rule: string, key: string }[], ignores?: string[] }} [o]
 * @returns {import('eslint').Linter.Config[]}
 */
export function webBoundaryConfigs({ root = ROOT, apps = WEB_BOUNDARY_APPS, baseline = readWebBoundaryBaseline(), ignores = WEB_BOUNDARY_IGNORES } = {}) {
  const keysOf = (rule) => baseline.filter((e) => e.rule === rule).map((e) => e.key);
  const languageOptions = { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' } };
  const plugins = { 'peaket-web-boundaries': webBoundariesPlugin };
  return apps.flatMap(({ app, layers, routes }) => {
    const src = path.join(root, app, 'src');
    const options = { root, src, layers };
    const blocks = [
      {
        files: [`${app}/src/**/*.{ts,tsx,mjs,js}`],
        ignores,
        languageOptions,
        plugins,
        rules: {
          'peaket-web-boundaries/layer-direction': ['error', { ...options, baseline: keysOf('layer-direction') }],
          'peaket-web-boundaries/no-slice-internals': ['error', { ...options, baseline: keysOf('no-slice-internals') }],
        },
      },
      {
        files: [`${app}/src/**/*.{ts,tsx,mjs,js}`],
        languageOptions,
        plugins,
        rules: { 'peaket-web-boundaries/file-naming': ['error', { src }] },
      },
      {
        files: [`${app}/src/**/*.tsx`],
        ignores: ['**/*.test.*', '**/*.spec.*', '**/*.stories.*'],
        languageOptions,
        plugins,
        rules: { 'peaket-web-boundaries/props-type-naming': ['error', { root, allowInline: true, sharedNames: SHARED_PROPS_NAMES, baseline: keysOf('props-type-naming') }] },
      },
    ];
    if (routes) {
      blocks.push({
        files: [`${app}/app/**/{page,layout,template,default,loading,error,not-found,global-error,route}.{ts,tsx}`],
        languageOptions,
        plugins,
        rules: { 'peaket-web-boundaries/route-reexport-only': ['error', { root, baseline: keysOf('route-reexport-only') }] },
      });
    }
    return blocks;
  });
}
