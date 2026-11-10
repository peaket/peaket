// 프로토타입 오염 린트 규칙(docs/security/asvs/delivery.md 15.3.6, docs/devops.md §4.4 '보안 린트', ADR-0263 결정 6, BUILD_ORDER BAS-011 ②).
// Semgrep 사용자 규칙 대신 새 패키지 없이 이 파일에 직접 만든 규칙 하나(no-prototype-mutation)를 화면(peaket-web/)과 서비스(peaket-service/)
// 플러그인 둘에 같은 규칙으로 싣는다. 그래서 줄 안 주석 끄기 검사(tools/ci/check-lint-disables.mjs, 두 이름만 본다)가 그대로 본다.
// ESLint 기본 규칙(no-proto·no-extend-native)과 하는 일이 겹치지만 그 이름은 끄기 검사가 보지 않아 우리 이름 아래 둔다(ADR-0263 '검토한 다른 안').
// 막는 것(구문과 범위만 본다, 형 정보 없음. 형 단언은 벗겨 본다. 별칭(const O = Object)은 따라가지 않는다):
//   1. __proto__ 읽기·쓰기(점, 글자 그대로의 계산 키, 구조 분해)와 객체 글자로 원형 주기({ __proto__: x }, x가 null이면 받는다)
//   2. Object.setPrototypeOf·Reflect.setPrototypeOf(두 번째 인자가 글자 그대로의 null이면 받는다)와 그 함수를 떼어 쓰기(구조 분해, 변수에 담기,
//      .call·.apply, Reflect.apply에 넘기기: 바로 부르지 않는 모든 쓰임)
//   3. 원형 고치기: 내장 원형(Array.prototype.x = …, Array.prototype = …)과 Object·Reflect.getPrototypeOf(…)·x.constructor.prototype을 거친 원형의
//      대입·++·delete, Object.defineProperty(ies)·Reflect.defineProperty·Object.assign의 첫 인자
//   4. 깊은 병합·경로 대입 함수 가져오기(lodash·lodash/fp merge·set 무리, es-toolkit merge, flat unflatten, deepmerge, dot-prop setProperty,
//      object-path set 등): import·require(…)(.이름)·import()·다시 내보내기(export * 포함)
// (리뷰 뒤 더한 규칙 ⑥, devops §4.4, ADR-0263 결정 13)
// 값의 흐름을 따라가야 하는 오염(외부 키로 속성 대입)은 CodeQL 프로토타입 오염 쿼리 셋이 본다(devops §4.4 '외부 보안 검사 게이트').
// 외부 JSON은 공용 안전 파서(@peaket/validation)로 읽는다.

const WHY = '프로토타입 오염을 막는다(ASVS 15.3.6, ADR-0263 결정 6)';
const MESSAGES = {
  proto: `__proto__를 읽거나 쓰지 않는다. 원형은 Object.getPrototypeOf로 읽고, 키·값 모음은 Map·Set이나 Object.create(null)을 쓴다. ${WHY}`,
  protoLiteral: `객체 글자의 __proto__로 원형을 주지 않는다(null만 받는다). Object.create(proto)를 쓴다. ${WHY}`,
  setPrototypeOf: `Object·Reflect.setPrototypeOf로 원형을 바꾸지 않는다(두 번째 인자가 null인 것만 받는다). ${WHY}`,
  builtin: `내장 원형(Array.prototype 등)을 고치지 않는다. 필요한 동작은 함수로 둔다. ${WHY}`,
  deepMerge: `깊은 병합·경로 대입 함수를 쓰지 않는다. 바깥 값은 스키마로 읽고 필요한 칸만 옮긴다. ${WHY}`,
};

/** 원형을 고치면 안 되는 내장 생성자(JS 내장과 화면·Node 공용 전역) */
const BUILTINS = new Set([
  'Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Iterator', 'Intl',
  'URL', 'URLSearchParams', 'Headers', 'Request', 'Response', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'Blob', 'FormData', 'Event', 'EventTarget',
  'Node', 'Element', 'HTMLElement', 'Document', 'Window', 'Buffer',
]);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);
const PROTO_DEFINERS = { Object: ['defineProperty', 'defineProperties', 'assign'], Reflect: ['defineProperty', 'set'] };
const PROTO_GETTERS = { Object: ['getPrototypeOf'], Reflect: ['getPrototypeOf'] };

/** 깊은 병합·경로 대입 함수: 모듈 전체가 그 함수인 것과, 모듈의 그 이름들 */
const LODASH_DEEP = ['merge', 'mergeWith', 'defaultsDeep', 'set', 'setWith', 'zipObjectDeep', 'update', 'updateWith'];
const LODASH_FP_DEEP = [...LODASH_DEEP, 'assoc', 'assocPath', 'setIn'];
const ES_TOOLKIT_DEEP = ['merge', 'mergeWith', 'toMerged'];
const NAMED_DEEP = {
  lodash: LODASH_DEEP,
  'lodash-es': LODASH_DEEP,
  'lodash/fp': LODASH_FP_DEEP,
  'es-toolkit': ES_TOOLKIT_DEEP,
  'es-toolkit/object': ES_TOOLKIT_DEEP,
  'es-toolkit/compat': [...LODASH_DEEP, ...ES_TOOLKIT_DEEP],
  flat: ['unflatten'],
  'dot-prop': ['setProperty'],
  'object-path': ['set', 'insert', 'push', 'ensureExists'],
};
const WHOLE_DEEP = new Set(['deepmerge', 'deep-extend', 'merge-deep', 'mixin-deep', 'merge', 'set-value', 'deep-set', 'dset', 'just-merge', 'just-safe-set', 'assign-deep', 'defaults-deep', 'merge-options']);
const LODASH_SUBPATH = new RegExp(`^lodash(?:-es)?/(?:${LODASH_DEEP.join('|')}|fp/(?:${LODASH_FP_DEEP.join('|')}))(?:\\.js)?$`);
const LODASH_SINGLE = new RegExp(`^lodash\\.(?:${LODASH_DEEP.map((n) => n.toLowerCase()).join('|')})$`);
const wholeDeep = (source) => WHOLE_DEEP.has(source) || LODASH_SUBPATH.test(source) || LODASH_SINGLE.test(source) || source.startsWith('dset/');

const TS_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression']);
/** 형 단언과 괄호를 벗긴다 */
function unwrap(node) {
  let n = node;
  while (n && (TS_WRAPPERS.has(n.type) || n.type === 'ChainExpression')) n = n.expression;
  return n;
}
/** 글자 그대로 정해진 문자열 값(Literal·식 없는 템플릿 글자). 아니면 null */
function staticString(node) {
  const n = unwrap(node);
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked;
  return null;
}
/** 멤버 식(a.b, a['b'], a[`b`])의 이름. 계산되는 이름이면 null */
function memberName(m) {
  if (m?.type !== 'MemberExpression') return null;
  if (!m.computed) return m.property.type === 'Identifier' ? m.property.name : null;
  return staticString(m.property);
}
/** 객체 칸의 이름(계산 칸은 null: { ['__proto__']: 1 }은 자기 속성을 만든다) */
const keyName = (p) => (p.computed ? null : p.key.type === 'Identifier' ? p.key.name : typeof p.key.value === 'string' ? p.key.value : null);
const isNull = (node) => {
  const n = unwrap(node);
  return n?.type === 'Literal' && n.value === null && n.raw === 'null';
};

/** 그 이름을 직접 선언한 변수가 범위에 없으면(전역·내장) 참 */
function isGlobal(scope, identifier) {
  for (let s = scope; s; s = s.upper) {
    const v = s.set.get(identifier.name);
    if (v && v.defs.length > 0) return false;
  }
  return true;
}

export const prototypeMutationRule = {
  meta: {
    type: 'problem',
    docs: { description: '프로토타입 오염 꼴(__proto__, setPrototypeOf, 내장 원형 고치기, 깊은 병합·경로 대입 함수)을 막는다(ASVS 15.3.6)' },
    schema: [],
  },
  create(context) {
    const src = context.sourceCode;
    const report = (node, kind) => context.report({ node, message: MESSAGES[kind] });
    /** 전역 이름(형 단언·globalThis.X를 벗김)이면 그 이름 */
    const globalName = (node) => {
      const n = unwrap(node);
      if (n?.type === 'Identifier') return isGlobal(src.getScope(n), n) ? n.name : null;
      if (n?.type === 'MemberExpression') {
        const obj = unwrap(n.object);
        if (obj?.type === 'Identifier' && GLOBAL_OBJECTS.has(obj.name) && isGlobal(src.getScope(obj), obj)) return memberName(n);
      }
      return null;
    };
    /** 내장 생성자의 원형 식(Array.prototype)인가 */
    const builtinPrototype = (node) => {
      const n = unwrap(node);
      return n?.type === 'MemberExpression' && memberName(n) === 'prototype' && BUILTINS.has(globalName(n.object) ?? '');
    };
    /** Object·Reflect.getPrototypeOf(…) 부르기이거나 x.constructor.prototype인가(어느 원형이든 가리킨다) */
    const reachedPrototype = (node) => {
      const n = unwrap(node);
      if (n?.type === 'CallExpression') {
        const c = unwrap(n.callee);
        const owner = c?.type === 'MemberExpression' ? globalName(c.object) : null;
        return Boolean(owner && PROTO_GETTERS[owner]?.includes(memberName(c)));
      }
      return n?.type === 'MemberExpression' && memberName(n) === 'prototype' && unwrap(n.object)?.type === 'MemberExpression' && memberName(unwrap(n.object)) === 'constructor';
    };
    /** 고치는 대상이 내장 원형이거나 그 칸, 또는 getPrototypeOf·constructor.prototype으로 닿은 원형이나 그 칸인가 */
    const builtinTarget = (node) => {
      const n = unwrap(node);
      return builtinPrototype(n) || reachedPrototype(n) || (n?.type === 'MemberExpression' && (builtinPrototype(n.object) || reachedPrototype(n.object)));
    };
    /** 형 단언·괄호를 지나 올라가 이 식을 바로 부르는 곳인가(f(…)의 f) */
    const isCalled = (node) => {
      let n = node;
      while (n.parent && (TS_WRAPPERS.has(n.parent.type) || n.parent.type === 'ChainExpression')) n = n.parent;
      return n.parent?.type === 'CallExpression' && n.parent.callee === n;
    };
    /** 모듈 전체를 담은 이름(기본·이름공간·require 묶기)의 쓰임에서 깊은 병합 이름을 찾는다 */
    const checkModuleObject = (declNode, names) => {
      for (const v of src.getDeclaredVariables(declNode)) {
        for (const ref of v.references) {
          const p = ref.identifier.parent;
          if (p.type === 'MemberExpression' && p.object === ref.identifier && names.includes(memberName(p))) report(p, 'deepMerge');
          if (p.type === 'VariableDeclarator' && p.init === ref.identifier && p.id.type === 'ObjectPattern') checkPattern(p.id, names);
        }
      }
    };
    const checkPattern = (pattern, names) => {
      for (const prop of pattern.properties) if (prop.type === 'Property' && names.includes(keyName(prop) ?? staticString(prop.key) ?? '')) report(prop, 'deepMerge');
    };
    /** 가져오기 한 곳(import·require·다시 내보내기)을 본다 */
    const checkSource = (node, source, { specifiers = null, declarator = null } = {}) => {
      if (typeof source !== 'string') return;
      if (wholeDeep(source)) return report(node, 'deepMerge');
      const names = NAMED_DEEP[source];
      if (!names) return;
      if (specifiers) {
        for (const s of specifiers) {
          if (s.type === 'ImportSpecifier' || s.type === 'ExportSpecifier') {
            const imported = s.type === 'ImportSpecifier' ? s.imported : s.local;
            if (s.importKind !== 'type' && names.includes(imported.name ?? imported.value)) report(s, 'deepMerge');
          } else checkModuleObject(s, names);
        }
      } else if (declarator) {
        if (declarator.id.type === 'ObjectPattern') checkPattern(declarator.id, names);
        else checkModuleObject(declarator, names);
      } else report(node, 'deepMerge');
    };

    return {
      MemberExpression(node) {
        if (memberName(node) === '__proto__') report(node, 'proto');
        // Object·Reflect.setPrototypeOf를 바로 부르지 않는 쓰임(변수에 담기, .call·.apply, Reflect.apply에 넘기기)
        const owner = globalName(node.object);
        if ((owner === 'Object' || owner === 'Reflect') && memberName(node) === 'setPrototypeOf' && !isCalled(node)) report(node, 'setPrototypeOf');
      },
      Property(node) {
        if (keyName(node) !== '__proto__') return;
        if (node.parent.type === 'ObjectPattern') report(node, 'proto');
        else if (node.parent.type === 'ObjectExpression' && !node.shorthand && !node.method && !isNull(node.value)) report(node, 'protoLiteral');
      },
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee?.type !== 'MemberExpression') return;
        const owner = globalName(callee.object);
        const name = memberName(callee);
        if ((owner === 'Object' || owner === 'Reflect') && name === 'setPrototypeOf' && !isNull(node.arguments[1])) report(node, 'setPrototypeOf');
        if (owner && PROTO_DEFINERS[owner]?.includes(name) && builtinTarget(node.arguments[0])) report(node, 'builtin');
      },
      AssignmentExpression(node) {
        if (builtinTarget(node.left)) report(node, 'builtin');
      },
      UpdateExpression(node) {
        if (builtinTarget(node.argument)) report(node, 'builtin');
      },
      'UnaryExpression[operator="delete"]'(node) {
        if (builtinTarget(node.argument)) report(node, 'builtin');
      },
      // const { setPrototypeOf } = Object 같은 떼어 내기
      "VariableDeclarator[id.type='ObjectPattern']"(node) {
        const owner = globalName(node.init);
        if (owner !== 'Object' && owner !== 'Reflect') return;
        for (const prop of node.id.properties) if (prop.type === 'Property' && keyName(prop) === 'setPrototypeOf') report(prop, 'setPrototypeOf');
      },
      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        if (node.specifiers.length === 0) return checkSource(node, node.source.value);
        checkSource(node, node.source.value, { specifiers: node.specifiers });
      },
      'ExportNamedDeclaration[source], ExportAllDeclaration'(node) {
        if (node.exportKind === 'type') return;
        if (node.type === 'ExportAllDeclaration') return checkSource(node, node.source.value);
        checkSource(node, node.source.value, { specifiers: node.specifiers });
      },
      ImportExpression(node) {
        checkSource(node, staticString(node.source));
      },
      "CallExpression[callee.type='Identifier'][callee.name='require']"(node) {
        const source = staticString(node.arguments[0]);
        const p = node.parent;
        if (p.type === 'VariableDeclarator' && p.init === node) checkSource(node, source, { declarator: p });
        else if (p.type === 'MemberExpression' && p.object === node && source && (NAMED_DEEP[source]?.includes(memberName(p)) || wholeDeep(source))) report(p, 'deepMerge');
        else if (source && wholeDeep(source)) report(node, 'deepMerge');
      },
    };
  },
};
