// 서비스 보안 린트(BUILD_ORDER BAS-010 ①, ADR-0259 결정 10·11). 새 패키지 없이 이 파일의 작은 규칙(peaket-service/*)으로 둔다.
// - no-direct-outbound-http(V-T31 ③, ASVS 15.3.2, FND-060이 넘긴 것): 서비스 코드는 바깥 HTTP를 공용 외부 호출 클라이언트
//   (@peaket/platform의 createExternalHttpClient: 리디렉트를 따르지 않고 추적 머리를 싣지 않는다)로만 부른다. 그 밖에서 전역 fetch,
//   node:http·node:https(접두사 없는 http·https도)의 요청 함수(request·get)와 ClientRequest, node:http2의 connect, undici를 쓰면 막는다.
//   전역 객체(globalThis·global·window·self)에서 fetch를 떼어 내는 구조 분해와 형 단언을 씌운 전역 객체도 본다. 별칭(const g = globalThis)은 따라가지 않는다.
//   서버를 여는 쓰임(createServer 등)과 형만 가져오기는 막지 않는다. 형 정보 없이 구문과 범위(scope)만 본다.
// - route-response-schema(ASVS 15.3.1, FND-070이 넘긴 것): @nestjs/common(하위 경로 포함)의 라우트 장식자(Get·Post·Put·Patch·Delete·Head·Options·All·
//   Search·RequestMapping·Sse)를 단 처리기는 응답 스키마 표시 @ContractRouteSchema({ …, responses: { 200: <응답 Zod> } })(@peaket/platform)를 단다.
//   responses는 객체 글자(같은 파일 const 포함)이고 성공(2xx) 응답이 하나 이상 있어야 한다. 이 표시는 Fastify 직렬화
//   스키마라 스키마에 없는 칸을 내보내지 않는다(packages/platform/src/request-checks.ts). 지금 있는 처리기는 기준선 목록
//   (response-schema-baseline.json, '파일 경로#클래스.메서드')에 두어 통과시키고 새 처리기만 막는다. 기준선 줄은 줄기만 한다: 기준선의 처리기가
//   파일에서 사라졌거나 이미 응답 스키마를 달았으면 그 줄을 지우라고 알린다. 기준선 처리기를 채우는 일은 서비스마다 따로 둘 단계가 한다.
import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import tsParser from '@typescript-eslint/parser';

const CLIENT = '@peaket/platform의 createExternalHttpClient(공용 외부 호출 클라이언트)를 쓴다(ASVS 15.3.2, V-T31 ③, ADR-0259)';
// 요청을 여는 것: request·get 함수와 ClientRequest 생성자(new http.ClientRequest, 리뷰 R8), http2의 connect
const HTTP_MODULES = { http: ['request', 'get', 'ClientRequest'], https: ['request', 'get', 'ClientRequest'], http2: ['connect'] };
/** 'node:https' → 'https'. 막을 모듈이 아니면 null */
const httpModule = (source) => {
  const m = /^(?:node:)?(https?|http2)$/.exec(String(source));
  return m ? m[1] : null;
};
const isUndici = (source) => /^undici(\/.*)?$/.test(String(source));
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);

const MESSAGES = {
  fetch: `전역 fetch를 직접 부르지 않는다. ${CLIENT}`,
  'node-http-request': `node:http(s)의 요청 함수(request·get·ClientRequest, http2.connect)를 직접 쓰지 않는다. ${CLIENT}`,
  undici: `undici를 직접 쓰지 않는다. ${CLIENT}`,
};
export const OUTBOUND_KINDS = Object.keys(MESSAGES);

const TS_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression']);
/** 형 단언을 벗긴다 */
function unwrap(node) {
  let n = node;
  while (n && TS_WRAPPERS.has(n.type)) n = n.expression;
  return n;
}
/** 글자 그대로 정해진 문자열 값(Literal·식 없는 템플릿 글자). 아니면 null */
function staticString(node) {
  const n = unwrap(node);
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked;
  return null;
}
function propertyName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  if (member.computed) return member.property.type === 'Literal' ? String(member.property.value) : staticString(member.property);
  return null;
}
/** 형 단언을 벗긴 식이 전역 객체 이름(globalThis·global·window·self)이면 그 식별자 */
function globalObject(node) {
  const n = unwrap(node);
  return n?.type === 'Identifier' && GLOBAL_OBJECTS.has(n.name) ? n : null;
}
/** 범위를 거슬러 올라가 그 이름을 직접 선언한 변수가 없으면(전역·내장) 참 */
function isGlobal(scope, identifier) {
  for (let s = scope; s; s = s.upper) {
    const v = s.set.get(identifier.name);
    if (v && v.defs.length > 0) return false;
  }
  return true;
}
const inTypePosition = (node) => {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'TSTypeQuery' || n.type === 'TSTypeReference' || n.type === 'TSQualifiedName') return true;
    if (!n.type.startsWith('TS') && n.type !== 'MemberExpression') return false;
  }
  return false;
};

const outboundRule = {
  meta: {
    type: 'problem',
    docs: { description: '서비스 코드가 공용 외부 호출 클라이언트 밖에서 바깥 HTTP를 부르는 것을 막는다(ASVS 15.3.2, V-T31 ③)' },
    schema: [{ type: 'object', properties: { allow: { type: 'array', items: { enum: OUTBOUND_KINDS }, uniqueItems: true } }, additionalProperties: false }],
  },
  create(context) {
    const allow = new Set(context.options[0]?.allow ?? []);
    const report = (node, kind) => {
      if (!allow.has(kind)) context.report({ node, message: MESSAGES[kind] });
    };
    const src = context.sourceCode;
    /** 모듈 전체를 담은 이름(기본·이름공간·require 묶기)의 쓰임에서 요청 함수를 찾는다 */
    const checkModuleObject = (declNode, mod) => {
      const fns = HTTP_MODULES[mod];
      for (const v of src.getDeclaredVariables(declNode)) {
        for (const ref of v.references) {
          const id = ref.identifier;
          const p = id.parent;
          if (p.type === 'MemberExpression' && p.object === id && fns.includes(propertyName(p))) report(p, 'node-http-request');
          // 모듈 전체를 그대로 내보내면 받는 쪽의 .request를 이 파일에서 볼 수 없다(export { http }, export default https)
          if ((p.type === 'ExportSpecifier' && p.local === id) || (p.type === 'ExportDefaultDeclaration' && p.declaration === id)) report(p, 'node-http-request');
          // const { request } = https
          if (p.type === 'VariableDeclarator' && p.init === id && p.id.type === 'ObjectPattern') checkPattern(p.id, mod);
        }
      }
    };
    const checkPattern = (pattern, mod) => {
      for (const prop of pattern.properties) {
        const key = prop.type === 'Property' ? (prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value)) : null;
        if (key && HTTP_MODULES[mod].includes(key)) report(prop, 'node-http-request');
      }
    };
    const checkGlobalPattern = (pattern, init) => {
      const obj = globalObject(init);
      if (!obj || !isGlobal(src.getScope(pattern), obj)) return;
      for (const prop of pattern.properties) {
        const key = prop.type === 'Property' ? (prop.computed ? staticString(prop.key) : prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value)) : null;
        if (key === 'fetch') report(prop, 'fetch');
      }
    };
    const staticSource = (node) => (node && node.type === 'Literal' ? node.value : node && node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null);

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        const source = node.source.value;
        if (isUndici(source)) return report(node, 'undici');
        const mod = httpModule(source);
        if (!mod) return;
        for (const s of node.specifiers) {
          if (s.type === 'ImportSpecifier') {
            if (s.importKind !== 'type' && HTTP_MODULES[mod].includes(s.imported.name ?? s.imported.value)) report(s, 'node-http-request');
          } else {
            checkModuleObject(s, mod);
          }
        }
      },
      'ExportNamedDeclaration[source], ExportAllDeclaration'(node) {
        if (node.exportKind === 'type' || !node.source) return;
        if (isUndici(node.source.value)) return report(node, 'undici');
        const mod = httpModule(node.source.value);
        if (!mod) return;
        if (node.type === 'ExportAllDeclaration') return report(node, 'node-http-request');
        // default는 모듈 전체를 다시 내보낸다(다시 보기 S2)
        for (const s of node.specifiers) {
          const local = s.local.name ?? s.local.value;
          if (local === 'default' || HTTP_MODULES[mod].includes(local)) report(s, 'node-http-request');
        }
      },
      ImportExpression(node) {
        const source = staticSource(node.source);
        if (isUndici(source)) report(node, 'undici');
        else if (httpModule(source)) report(node, 'node-http-request');
      },
      "CallExpression[callee.type='Identifier'][callee.name='require']"(node) {
        const source = staticSource(node.arguments[0]);
        if (isUndici(source)) return report(node, 'undici');
        const mod = httpModule(source);
        if (!mod) return;
        const p = node.parent;
        if (p.type === 'MemberExpression' && p.object === node && HTTP_MODULES[mod].includes(propertyName(p))) report(p, 'node-http-request');
        else if (p.type === 'VariableDeclarator' && p.init === node) {
          if (p.id.type === 'ObjectPattern') checkPattern(p.id, mod);
          else checkModuleObject(p, mod);
        }
      },
      // globalThis.fetch(…), window['fetch'], (globalThis as any).fetch 등
      MemberExpression(node) {
        if (propertyName(node) !== 'fetch') return;
        const obj = globalObject(node.object);
        if (obj && isGlobal(src.getScope(node), obj)) report(node, 'fetch');
      },
      // const { fetch } = globalThis, ({ fetch: f } = window) 같은 떼어 내기(리뷰 R8)
      "VariableDeclarator[id.type='ObjectPattern']"(node) {
        checkGlobalPattern(node.id, node.init);
      },
      "AssignmentExpression[left.type='ObjectPattern']"(node) {
        checkGlobalPattern(node.left, node.right);
      },
      // 전역 fetch의 모든 값 쓰임(부르기, 넘기기, bind). typeof fetch 같은 형 자리는 뺀다
      'Program:exit'(program) {
        const globalScope = src.getScope(program);
        const refs = [...globalScope.through.filter((r) => r.identifier.name === 'fetch')];
        const v = globalScope.set.get('fetch');
        if (v && v.defs.length === 0) refs.push(...v.references);
        for (const r of refs) if (!inTypePosition(r.identifier)) report(r.identifier, 'fetch');
      },
    };
  },
};

// HTTP 메서드 장식자와 RequestMapping(메서드를 인자로 받는다)·Sse(서버 보낸 사건). @nestjs/common과 그 하위 경로(decorators/…)에서 가져온 것(리뷰 R7 ④)
const ROUTE_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All', 'Search', 'RequestMapping', 'Sse']);
/** 아무 값이나 받아 칸을 거르지 않는 zod 스키마 */
const LOOSE_ZOD = new Set(['any', 'unknown']);
const isNestCommon = (source) => source === '@nestjs/common' || String(source).startsWith('@nestjs/common/');
const isPlatform = (source) => source === '@peaket/platform' || String(source).startsWith('@peaket/platform/');
const MARK = '@ContractRouteSchema({ …, responses: { 200: <응답 Zod 스키마> } })(@peaket/platform)';

/** 파일 경로(작업 폴더 기준, /로 나눔) */
function repoPath(context) {
  const f = context.filename;
  return (isAbsolute(f) ? relative(context.cwd, f) : f).replaceAll('\\', '/');
}
const keyName = (k, src) => (k.type === 'Identifier' ? k.name : k.type === 'PrivateIdentifier' ? `#${k.name}` : k.type === 'Literal' ? String(k.value) : src.getText(k));

const responseSchemaRule = {
  meta: {
    type: 'problem',
    docs: { description: '응답 스키마 표시가 없는 새 라우트 처리기를 막는다(ASVS 15.3.1, ADR-0259 결정 11)' },
    schema: [{ type: 'object', properties: { baseline: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
  },
  create(context) {
    const src = context.sourceCode;
    const file = repoPath(context);
    const prefix = `${file}#`;
    const baseline = new Set((context.options[0]?.baseline ?? []).filter((l) => l.startsWith(prefix)));
    const routes = new Map(); // 지역 이름 → 라우트 장식자
    const nestNs = new Set();
    const marks = new Set();
    const zodNs = new Set(); // zod를 담은 이름(z, zod, 기본 가져오기)
    const zodLoose = new Set(); // zod에서 이름으로 가져온 any·unknown
    const platformNs = new Set();
    const seen = new Map(); // 기준선 키 → 응답 스키마가 있는가

    /** 장식자 식이 라우트 장식자인가 */
    const isRoute = (callee) =>
      (callee.type === 'Identifier' && routes.has(callee.name)) ||
      (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && nestNs.has(callee.object.name) && ROUTE_DECORATORS.has(propertyName(callee)));
    const isMark = (callee) =>
      (callee.type === 'Identifier' && marks.has(callee.name)) ||
      (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && platformNs.has(callee.object.name) && propertyName(callee) === 'ContractRouteSchema');
    /** 같은 파일의 const 객체 글자를 따라간다 */
    const objectOf = (node) => {
      if (node?.type === 'ObjectExpression') return node;
      if (node?.type !== 'Identifier') return null;
      for (let s = src.getScope(node); s; s = s.upper) {
        const v = s.set.get(node.name);
        if (!v) continue;
        const d = v.defs[0];
        return d?.type === 'Variable' && d.parent.kind === 'const' && d.node.init?.type === 'ObjectExpression' ? d.node.init : null;
      }
      return null;
    };
    /**
     * 표시 장식자의 첫 인자에 성공(2xx) 응답의 스키마가 있는가. 첫 인자와 responses는 객체 글자이거나 같은 파일의 const 객체 글자여야 하고,
     * 가져온 이름·함수 호출 결과·펼치기·계산 칸처럼 따라갈 수 없는 것은 표시로 치지 않는다(리뷰 R7 ③)
     */
    const hasResponses = (call) => {
      const obj = objectOf(call.arguments[0]);
      const prop = obj?.properties.find((p) => p.type === 'Property' && !p.computed && keyName(p.key, src) === 'responses');
      const responses = prop ? objectOf(prop.value) : null;
      if (!responses) return false;
      const success = responses.properties.filter((p) => p.type === 'Property' && !p.computed && p.key.type === 'Literal' && /^2\d\d$/.test(String(p.key.value)));
      // 성공 응답이 둘 이상이면 모두 진짜 스키마여야 한다(z.any()·z.unknown()은 칸을 거르지 않는다, 다시 보기 S2)
      if (success.some((p) => looseSchema(p.value))) return false;
      return responses.properties.some((p) => {
        if (p.type !== 'Property' || p.computed || p.key.type !== 'Literal') return false;
        const code = Number(p.key.value);
        const empty = (p.value.type === 'Identifier' && p.value.name === 'undefined') || (p.value.type === 'Literal' && p.value.value === null);
        return /^\d{3}$/.test(String(p.key.value)) && code >= 200 && code <= 299 && !empty;
      });
    };
    /** zod의 any()·unknown()(뒤에 .optional() 같은 사슬이 붙어도)이거나 같은 파일 const로 그것을 담은 이름이면 참 */
    const looseSchema = (node, depth = 0) => {
      let n = node;
      if (n?.type === 'Identifier' && depth === 0) {
        for (let s = src.getScope(n); s; s = s.upper) {
          const v = s.set.get(n.name);
          if (!v) continue;
          const d = v.defs[0];
          return d?.type === 'Variable' && d.parent.kind === 'const' && d.node.init ? looseSchema(d.node.init, 1) : false;
        }
        return false;
      }
      while (n?.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.type === 'CallExpression') n = n.callee.object;
      if (n?.type !== 'CallExpression') return false;
      const c = n.callee;
      if (c.type === 'Identifier') return zodLoose.has(c.name);
      return c.type === 'MemberExpression' && c.object.type === 'Identifier' && zodNs.has(c.object.name) && LOOSE_ZOD.has(propertyName(c));
    };
    const className = (method) => {
      const cls = method.parent?.parent;
      if (cls?.id?.name) return cls.id.name;
      if (cls?.parent?.type === 'VariableDeclarator' && cls.parent.id.type === 'Identifier') return cls.parent.id.name;
      return '<익명>';
    };

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        if (isNestCommon(node.source.value)) {
          for (const s of node.specifiers) {
            if (s.type === 'ImportNamespaceSpecifier') nestNs.add(s.local.name);
            else if (s.type === 'ImportSpecifier' && ROUTE_DECORATORS.has(s.imported.name ?? s.imported.value)) routes.set(s.local.name, s.imported.name);
          }
        } else if (/^zod(\/.*)?$/.test(String(node.source.value))) {
          for (const s of node.specifiers) {
            if (s.type !== 'ImportSpecifier') zodNs.add(s.local.name);
            else if ((s.imported.name ?? s.imported.value) === 'z') zodNs.add(s.local.name);
            else if (LOOSE_ZOD.has(s.imported.name ?? s.imported.value)) zodLoose.add(s.local.name);
          }
        } else if (isPlatform(node.source.value)) {
          for (const s of node.specifiers) {
            if (s.type === 'ImportNamespaceSpecifier') platformNs.add(s.local.name);
            else if (s.type === 'ImportSpecifier' && (s.imported.name ?? s.imported.value) === 'ContractRouteSchema') marks.add(s.local.name);
          }
        }
      },
      MethodDefinition(node) {
        const calls = (node.decorators ?? []).map((d) => d.expression).filter((e) => e.type === 'CallExpression');
        const route = calls.find((c) => isRoute(c.callee));
        if (!route) return;
        const ok = calls.some((c) => isMark(c.callee) && hasResponses(c));
        const key = `${file}#${className(node)}.${keyName(node.key, src)}`;
        if (baseline.has(key)) {
          seen.set(key, ok);
          return;
        }
        if (!ok) context.report({ node: route, message: `응답 스키마 표시가 없는 새 라우트 처리기(${key})다. ${MARK}를 단다. 스키마에 없는 칸은 내보내지 않는다(ASVS 15.3.1, ADR-0259 결정 11)` });
      },
      'Program:exit'(program) {
        for (const key of baseline) {
          if (!seen.has(key)) context.report({ node: program, loc: { line: 1, column: 0 }, message: `기준선의 처리기(${key})가 이 파일에 없다. 기준선(packages/config/eslint/response-schema-baseline.json)에서 그 줄을 지운다` });
          else if (seen.get(key)) context.report({ node: program, loc: { line: 1, column: 0 }, message: `기준선의 처리기(${key})는 이제 응답 스키마가 있다. 기준선(packages/config/eslint/response-schema-baseline.json)에서 그 줄을 지운다` });
        }
      },
    };
  },
};

export const serviceSecurityPlugin = { rules: { 'no-direct-outbound-http': outboundRule, 'route-response-schema': responseSchemaRule } };

/**
 * 이름을 단 외부 호출 예외(파일 하나, 푸는 쓰임, 까닭). 공용 외부 호출 클라이언트에 넘길 연결을 만드는 곳과, 바깥이 아닌 안쪽으로 넘기는 곳만 둔다.
 * @type {{ file: string, allow: ('fetch' | 'node-http-request' | 'undici')[], reason: string }[]}
 */
export const OUTBOUND_HTTP_EXCEPTIONS = [
  {
    file: 'services/payment-svc/src/modules/payment/adapters/pg/pg-http.ts',
    allow: ['fetch', 'undici'],
    reason: '결제사 연결 묶음: undici Agent를 dispatcher로 준 fetch를 만들어 공용 외부 호출 클라이언트의 fetch 주입으로만 넘긴다(createExternalHttpClient가 리디렉트·시간 초과·추적 머리를 맡는다, BUILD_ORDER PRF-183)',
  },
  {
    file: 'services/v0-monolith/src/gateway/server.ts',
    allow: ['node-http-request'],
    reason: 'v0 게이트웨이 대역이 받은 요청을 클러스터 안 앱(설정의 upstream)으로 넘기는 역방향 프록시다. 바깥 주소를 부르지 않는다(docs/infra.md §3 v0 배포)',
  },
];

/** 기준선: HEAD 320e213a의 라우트 처리기 가운데 응답 스키마 표시가 없는 것('파일 경로#클래스.메서드') */
export const RESPONSE_SCHEMA_BASELINE = JSON.parse(readFileSync(new URL('./response-schema-baseline.json', import.meta.url), 'utf8')).handlers;

function checkExceptions(exceptions) {
  for (const e of exceptions) {
    if (typeof e.file !== 'string' || !/^[\w@./-]+$/.test(e.file) || e.file.includes('*')) throw new TypeError(`외부 호출 예외는 파일 하나를 경로로 적는다: ${e.file}`);
    if (typeof e.reason !== 'string' || e.reason.trim() === '') throw new TypeError(`외부 호출 예외에 까닭이 없다: ${e.file}`);
    if (!Array.isArray(e.allow) || e.allow.length === 0) throw new TypeError(`외부 호출 예외에 푸는 쓰임이 없다: ${e.file}`);
    for (const k of e.allow) if (!OUTBOUND_KINDS.includes(k)) throw new TypeError(`외부 호출 예외의 모르는 쓰임: ${k} (${e.file})`);
  }
  return exceptions;
}

/**
 * @param {string[]} roots 서비스 소스 폴더 글롭(예: 'services/*\/src')
 * @param {{ exceptions?: typeof OUTBOUND_HTTP_EXCEPTIONS, baseline?: string[] }} [o]
 * @returns {import('eslint').Linter.Config[]}
 */
export function serviceSecurityConfigs(roots, { exceptions = OUTBOUND_HTTP_EXCEPTIONS, baseline = RESPONSE_SCHEMA_BASELINE } = {}) {
  checkExceptions(exceptions);
  return [
    {
      files: roots.map((r) => `${r}/**/*.ts`),
      languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
      plugins: { 'peaket-service': serviceSecurityPlugin },
      rules: {
        'peaket-service/no-direct-outbound-http': 'error',
        'peaket-service/route-response-schema': ['error', { baseline }],
      },
    },
    ...exceptions.map((e) => ({ files: [e.file], rules: { 'peaket-service/no-direct-outbound-http': ['error', { allow: e.allow }] } })),
  ];
}
