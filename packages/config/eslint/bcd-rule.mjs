// 목표 브라우저 밖의 전역 웹 API·ES 내장 기능을 MDN 브라우저 지원 자료로 직접 막는 린트 규칙(docs/frontend.md §1.5, NFR-019, BUILD_ORDER BAS-210).
// eslint-plugin-compat 7.0.2는 판 자료를 ast-metadata-inferer 0.8.1에서 가져와 AbortSignal.any·Promise.withResolvers·Object.groupBy 같은
// 새 기능을 모른다(2026-11-04 확인). 그래서 이 규칙이 @mdn/browser-compat-data(판은 잠금 파일)를 읽어 같은 일을 한다.
//
// 보는 것: 전역 이름(`OffscreenCanvas`, `requestIdleCallback`), 전역 이름의 속성(`AbortSignal.any`, `Promise.withResolvers`),
// 몇몇 전역 객체의 속성(`navigator.wakeLock`, `document.startViewTransition`). 보지 않는 것: 타입을 알아야 하는 인스턴스 메서드
// (`[].toSorted()`), 두 단계 넘는 속성(`navigator.storage.estimate`), 문법(이것은 빌드가 바꾼다). 정본은 §1.5 표다.
//
// 기능을 먼저 확인한 코드는 보고하지 않는다: `typeof X.y`, `if (X.y)`, `X.y ? … : …`, `X.y && …`, `X.y || …`, `'y' in X`, `X.y?.()`.
// 선언 안 된 전역 이름 X 자체는 `typeof X`와 `'X' in globalThis`(window·self)만 확인으로 친다(`if (X)`는 없는 브라우저에서 ReferenceError).
// 상위 객체만 확인한 것(`typeof document`)은 그 속성의 지원 범위가 상위 객체와 같을 때만 속성 확인으로 친다.
// 같은 함수(또는 그것을 감싼 함수·모듈 맨 위) 안에서 확인한 뒤(소스 차례로 확인보다 뒤)의 사용만 통과한다.
// TypeScript 문법(`as`·`!`·`satisfies`)을 거친 확인과 사용도 같은 것으로 보고, `globalThis.X.y`·`window.X.y`도 `X.y`로 본다.
// 접두사·플래그·다른 이름으로만 있는 것은 지원으로 치지 않는다. 부분 지원(partial_implementation)은 지원으로 친다. 부분 지원은 대개
// 특정 인자에서만 다르게 도는 것(예: iOS의 window.open은 `_blank` 대상만 안 된다)이라 이름만으로 막으면 헛보고가 많다. 그런 차이는
// §1.5 표가 맡는다(예: Screen Wake Lock은 iOS 18.4부터로 센다).
import bcd from '@mdn/browser-compat-data' with { type: 'json' };
import browserslist from 'browserslist';

/** browserslist 이름 → MDN 자료 브라우저 이름 */
const BROWSER_IDS = {
  chrome: 'chrome',
  edge: 'edge',
  firefox: 'firefox',
  safari: 'safari',
  ios_saf: 'safari_ios',
  samsung: 'samsunginternet_android',
  and_chr: 'chrome_android',
  and_ff: 'firefox_android',
  android: 'webview_android',
  opera: 'opera',
};
const BROWSER_NAMES = {
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  safari: 'Safari',
  safari_ios: 'iOS Safari',
  samsunginternet_android: 'Samsung Internet',
  chrome_android: 'Android Chrome',
  firefox_android: 'Android Firefox',
  webview_android: 'Android WebView',
  opera: 'Opera',
};

/** 인터페이스 하나를 가리키는 전역 객체 */
const SINGLETONS = {
  navigator: 'Navigator',
  document: 'Document',
  location: 'Location',
  history: 'History',
  screen: 'Screen',
  performance: 'Performance',
  crypto: 'Crypto',
  localStorage: 'Storage',
  sessionStorage: 'Storage',
  indexedDB: 'IDBFactory',
  caches: 'CacheStorage',
  scheduler: 'Scheduler',
  visualViewport: 'VisualViewport',
};
/** 전역 공간 자체를 가리키는 이름(`window.X`는 전역 `X`와 같게 본다) */
const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis']);

const num = (v) => {
  const [a = 0, b = 0, c = 0] = String(v).replace(/^≤/, '').split(/[.-]/).map(Number);
  return a * 1e6 + b * 1e3 + c;
};

/** 목표 브라우저 질의 → { MDN 브라우저 이름: 가장 낮은 판 } */
export function resolveTargets(queries) {
  const low = {};
  for (const entry of browserslist(queries)) {
    const [family, version] = entry.split(' ');
    const id = BROWSER_IDS[family];
    if (!id) continue;
    const v = version.split('-')[0];
    if (!(id in low) || num(v) < num(low[id])) low[id] = v;
  }
  return low;
}

function supportedIn(statement, version) {
  const list = Array.isArray(statement) ? statement : [statement];
  return list.some((s) => {
    if (s.flags || s.prefix || s.alternative_name) return false;
    const added = s.version_added;
    if (added === null || added === undefined) return true; // 자료가 모름: 막지 않는다
    if (added === false || added === 'preview') return false;
    if (added !== true && num(added) > num(version)) return false;
    const removed = s.version_removed;
    // 'preview'에서 빠지는 것은 정식 판에는 아직 있다
    return !removed || removed === 'preview' || num(removed) > num(version);
  });
}

/** 그 기능을 지원하지 않는 목표 브라우저 목록(빈 배열이면 다 지원) */
export function unsupportedTargets(compat, targets) {
  const out = [];
  for (const [id, version] of Object.entries(targets)) {
    const st = compat.support[id];
    if (st === undefined) continue; // 그 브라우저 자료가 없다: 막지 않는다
    if (!supportedIn(st, version)) out.push(`${BROWSER_NAMES[id] ?? id} ${version}`);
  }
  return out;
}

const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);
const compatOf = (node) => (node && node.__compat ? node.__compat : undefined);

/** 전역 이름 하나의 자료 */
function lookupGlobal(name) {
  return compatOf(own(bcd.api, name)) ?? compatOf(own(bcd.javascript.builtins, name)) ?? compatOf(own(bcd.api.Window, name));
}

/** `X.y`의 자료. X가 전역 객체(navigator 등)면 그 인터페이스의 속성을, 아니면 정적 속성을 본다 */
function lookupMember(object, property) {
  if (SINGLETONS[object]) return compatOf(own(own(bcd.api, SINGLETONS[object]), property));
  const api = own(bcd.api, object);
  const js = own(bcd.javascript.builtins, object);
  return compatOf(own(api, `${property}_static`)) ?? compatOf(own(js, property)) ?? compatOf(own(api, property));
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'Program']);
const COMPARE = new Set(['===', '!==', '==', '!=', 'in', 'instanceof']);

/**
 * 값을 읽는 자리가 '있는지 확인하는' 자리인가. 'typeof'는 `typeof X` 꼴(선언 안 된 전역 이름도 안전하게 확인한다),
 * 'test'는 `if (X.y)`·`X.y && …`·`X.y?.()` 같은 꼴(속성 확인에는 안전하나, 선언 안 된 전역 이름이면 없는 브라우저에서 ReferenceError다)
 * @returns {'typeof' | 'test' | false}
 */
function isDetection(node) {
  let cur = node;
  for (let parent = cur.parent; parent; cur = parent, parent = parent.parent) {
    switch (parent.type) {
      case 'UnaryExpression':
        if (parent.operator === 'typeof') return 'typeof';
        continue;
      case 'BinaryExpression':
        if (!COMPARE.has(parent.operator)) return false;
        continue;
      case 'LogicalExpression':
        if (cur === parent.left) return 'test';
        continue;
      case 'ChainExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
      case 'TSSatisfiesExpression':
      case 'TSTypeAssertion':
        continue;
      case 'MemberExpression':
        if (cur === parent.object && parent.optional) return 'test';
        return false;
      case 'CallExpression':
        if (cur === parent.callee && parent.optional) return 'test';
        return false;
      case 'IfStatement':
      case 'ConditionalExpression':
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'ForStatement':
        return cur === parent.test ? 'test' : false;
      default:
        return false;
    }
  }
  return false;
}

function enclosingFunctions(node) {
  const out = [];
  for (let n = node.parent; n; n = n.parent) if (FUNCTION_TYPES.has(n.type)) out.push(n);
  return out;
}

const propertyName = (member) => {
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  if (member.computed && member.property.type === 'Literal' && typeof member.property.value === 'string') return member.property.value;
  return undefined;
};

export function createBcdRule() {
  return {
    meta: {
      type: 'problem',
      docs: { description: '목표 브라우저 밖의 전역 웹 API·ES 내장 기능을 MDN 자료로 막는다(docs/frontend.md §1.5)' },
      schema: [],
      messages: {
        unsupported: '{{name}}은(는) 목표 브라우저 {{targets}}에서 지원되지 않는다(MDN 자료 {{bcd}}). 기능을 먼저 확인하거나 §1.5 표의 대체 함수를 쓴다',
      },
    },
    create(context) {
      const targets = resolveTargets(context.settings?.browsers ?? []);
      const sourceCode = context.sourceCode;
      return {
        'Program:exit'(program) {
          const scope = sourceCode.getScope(program);
          const refs = [...scope.through];
          for (const v of scope.variables) if (v.defs.length === 0) refs.push(...v.references);
          const uses = [];
          const guards = new Map(); // 함수 노드 → 확인한 이름 → 가장 앞선 확인의 소스 위치
          const guard = (node, key) => {
            const fn = enclosingFunctions(node)[0];
            if (!guards.has(fn)) guards.set(fn, new Map());
            const m = guards.get(fn);
            const at = node.range?.[0] ?? 0;
            if (!m.has(key) || at < m.get(key)) m.set(key, at);
          };
          /** 그 함수에서 key를 use보다 앞에서 확인했는가 */
          const guardedBefore = (fn, key, use) => {
            const at = guards.get(fn)?.get(key);
            return at !== undefined && at < (use.range?.[0] ?? 0);
          };
          // TypeScript 문법 감싸기를 벗긴다(`(X as any).y`의 X)
          const TS_WRAP = new Set(['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'TSTypeAssertion']);
          const unwrapUp = (n) => {
            let cur = n;
            while (cur.parent && TS_WRAP.has(cur.parent.type) && cur.parent.expression === cur) cur = cur.parent;
            return cur;
          };
          for (const ref of refs) {
            if (ref.isValueReference === false) continue; // 타입 자리
            const id = ref.identifier;
            const idw = unwrapUp(id);
            const parent = idw.parent;
            let name = id.name;
            let node = id;
            let compat;
            if (GLOBAL_OBJECTS.has(name) && parent?.type === 'MemberExpression' && parent.object === idw) {
              const p = propertyName(parent);
              if (!p) continue;
              const pw = unwrapUp(parent);
              const grand = pw.parent;
              const q = grand?.type === 'MemberExpression' && grand.object === pw ? propertyName(grand) : undefined;
              const member = q ? lookupMember(p, q) : undefined;
              if (member) {
                // globalThis.X.y → X.y
                name = `${p}.${q}`;
                node = grand;
                compat = member;
              } else {
                name = p;
                node = parent;
                compat = lookupGlobal(p);
              }
            } else if (parent?.type === 'MemberExpression' && parent.object === idw && propertyName(parent)) {
              const p = propertyName(parent);
              name = `${id.name}.${p}`;
              node = parent;
              compat = lookupMember(id.name, p) ?? undefined;
              // 속성 자료가 없으면 전역 이름 자체를 본다(예: 없는 인터페이스의 아무 속성)
              if (!compat) {
                name = id.name;
                node = id;
                compat = SINGLETONS[id.name] ? undefined : lookupGlobal(id.name);
              }
            } else {
              compat = SINGLETONS[name] ? undefined : lookupGlobal(name);
            }
            // `'y' in X`(X는 전역 이름이나 window류)
            if (parent?.type === 'BinaryExpression' && parent.operator === 'in' && parent.right === idw) {
              const left = parent.left;
              if (left.type === 'Literal' && typeof left.value === 'string') {
                guard(id, GLOBAL_OBJECTS.has(id.name) ? left.value : `${id.name}.${left.value}`);
              }
              continue;
            }
            const detection = isDetection(node);
            // 선언 안 된 전역 이름을 바로 읽는 확인(`if (X)`)은 없는 브라우저에서 ReferenceError라 확인으로 치지 않는다
            const bare = node === id && !GLOBAL_OBJECTS.has(id.name);
            if (detection && (!bare || detection === 'typeof')) {
              guard(node, name);
              continue;
            }
            if (!compat) continue;
            const missing = unsupportedTargets(compat, targets);
            if (missing.length) uses.push({ node, name, missing });
          }
          // 상위 객체 확인(`'scheduler' in globalThis`)은 그 객체가 있는 곳에서 속성도 늘 있을 때만 속성 확인으로 친다.
          // 그래서 서버 그리기 확인(`typeof document`)이나 `typeof AbortSignal`은 document.startViewTransition·AbortSignal.any를 통과시키지 않는다
          const headCovers = (u, head) => {
            const hc = lookupGlobal(head);
            if (!hc) return false;
            const headMissing = unsupportedTargets(hc, targets);
            return u.missing.every((m) => headMissing.includes(m));
          };
          for (const u of uses) {
            const head = u.name.split('.')[0];
            const fns = enclosingFunctions(u.node);
            const dotted = u.name.includes('.');
            if (fns.some((fn) => guardedBefore(fn, u.name, u.node) || (dotted && guardedBefore(fn, head, u.node) && headCovers(u, head)))) continue;
            context.report({
              node: u.node,
              messageId: 'unsupported',
              data: { name: u.name, targets: u.missing.join(', '), bcd: bcd.__meta.version },
            });
          }
        },
      };
    },
  };
}

export const bcdPlugin = { rules: { bcd: createBcdRule() } };
