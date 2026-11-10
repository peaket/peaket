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
// - sql-raw-allowlist(ADR-0037, architecture §8.3 SQL 주입 행, ADR-0263 결정 6, BUILD_ORDER BAS-011 ②. 처음에는 Semgrep에 맡겼던 몫):
//   drizzle-orm(하위 경로 포함)에서 가져온 sql(이름을 바꿔 가져온 것, 이름공간 가져오기의 .sql 포함)의 raw에는 글자 그대로의 문자열·식 없는 템플릿 글자나
//   같은 파일의 그런 const(글자끼리 + 로 이은 것 포함)만 넘긴다. 그 밖(식이 든 템플릿, 변수, 함수 결과, 가져온 이름)과 raw를 부르지 않고 값으로
//   넘기거나 떼어 내는 것은 허용 목록(sql-raw-allowlist.json의 파일과 까닭)에 든 파일만 받는다. sql을 다시 담은 별칭(const q = sql, 이름공간 구조 분해
//   const { sql: s } = d, [sql][0])도 sql로 본다. execute·query에 ${…}를 끼운 템플릿 글자(sql 태그 없이 글을 이어 만든 SQL)도 같은 규칙으로 막는다
//   (끼운 값이 모두 같은 파일의 const 글자면 받는다, 리뷰 뒤 더한 규칙 ⑥). 이 규칙과 아래 원형 규칙은 공용 서버 패키지(sharedRoots)에도 건다.
// - no-prototype-mutation(ASVS 15.3.6, ADR-0263 결정 6): js-security.mjs의 규칙을 이 플러그인 이름으로도 싣는다(화면은 peaket-web/).
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import tsParser from '@typescript-eslint/parser';
import { prototypeMutationRule } from './js-security.mjs';

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

const SQL_RAW_MESSAGE =
  'sql.raw()에는 글자 그대로의 문자열이나 같은 파일의 그런 const만 넘긴다. 값은 sql`…${값}` 템플릿으로 묶고(매개변수 바인딩), 동적 식별자가 꼭 필요하면 미리 정한 목록으로 검증한 뒤 그 파일과 까닭을 packages/config/eslint/sql-raw-allowlist.json에 적는다(ADR-0037, ASVS 1.2.4)';
const isDrizzle = (source) => /^drizzle-orm(\/.*)?$/.test(String(source));

const sqlRawRule = {
  meta: {
    type: 'problem',
    docs: { description: 'drizzle-orm sql.raw()에 동적 글자를 넘기는 것을 허용 목록 밖에서 막는다(ADR-0037, ASVS 1.2.4)' },
    schema: [{ type: 'object', properties: { allowDynamic: { type: 'boolean' } }, additionalProperties: false }],
  },
  create(context) {
    if (context.options[0]?.allowDynamic === true) return {};
    const src = context.sourceCode;
    const report = (node) => context.report({ node, message: SQL_RAW_MESSAGE });
    /** 이름이 가리키는 drizzle-orm 가져오기(범위를 거슬러 올라가 찾는다). 가져오기가 아니거나 형만 가져오기면 null */
    const importOf = (id) => {
      for (let s = src.getScope(id); s; s = s.upper) {
        const v = s.set.get(id.name);
        if (!v) continue;
        const d = v.defs[0];
        if (d?.type !== 'ImportBinding' || !isDrizzle(d.parent.source.value) || d.parent.importKind === 'type' || d.node.importKind === 'type') return null;
        return d.node;
      }
      return null;
    };
    /** 이름이 가리키는 변수 선언(같은 파일). 없으면 null */
    const variableOf = (id) => {
      for (let s = src.getScope(id); s; s = s.upper) {
        const v = s.set.get(id.name);
        if (v) return v;
      }
      return null;
    };
    /** 식이 drizzle-orm 이름공간 가져오기(import * as d)인가. 그것을 다시 담은 별칭도 따라간다 */
    const isNamespace = (node, depth = 0) => {
      const n = unwrap(node);
      if (n?.type !== 'Identifier' || depth > 8) return false;
      if (importOf(n)?.type === 'ImportNamespaceSpecifier') return true;
      const d = variableOf(n)?.defs[0];
      return d?.type === 'Variable' && d.node.id.type === 'Identifier' && isNamespace(d.node.init, depth + 1);
    };
    /** 식이 drizzle-orm의 sql인가: sql, 이름을 바꾼 sql, 이름공간.sql, 그것을 다시 담은 별칭(const q = sql, const { sql: s } = d), [sql][0] */
    const isSql = (node, depth = 0) => {
      const n = unwrap(node);
      if (!n || depth > 8) return false;
      if (n.type === 'Identifier') {
        const spec = importOf(n);
        if (spec) return spec.type === 'ImportSpecifier' && (spec.imported.name ?? spec.imported.value) === 'sql';
        const d = variableOf(n)?.defs[0];
        if (d?.type !== 'Variable') return false;
        if (d.node.id.type === 'Identifier') return isSql(d.node.init, depth + 1);
        // const { sql: s } = d(이름공간), const { sql } = d
        if (d.node.id.type === 'ObjectPattern' && isNamespace(d.node.init)) {
          return d.node.id.properties.some((p) => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === 'sql' && unwrap(p.value)?.type === 'Identifier' && unwrap(p.value).name === n.name);
        }
        return false;
      }
      if (n.type === 'MemberExpression') {
        if (propertyName(n) === 'sql' && isNamespace(n.object)) return true;
        // [sql][0]
        const obj = unwrap(n.object);
        if (obj?.type === 'ArrayExpression' && n.computed && n.property.type === 'Literal' && Number.isInteger(n.property.value)) return isSql(obj.elements[n.property.value], depth + 1);
      }
      return false;
    };
    /** 글자 그대로 정해진 SQL 조각인가: 문자열·식 없는 템플릿, 그것끼리의 +, 같은 파일의 그런 const */
    const isStatic = (node, depth = 0) => {
      const n = unwrap(node);
      if (!n || depth > 8) return false;
      if (staticString(n) !== null) return true;
      if (n.type === 'BinaryExpression' && n.operator === '+') return isStatic(n.left, depth + 1) && isStatic(n.right, depth + 1);
      if (n.type !== 'Identifier') return false;
      for (let s = src.getScope(n); s; s = s.upper) {
        const v = s.set.get(n.name);
        if (!v) continue;
        const d = v.defs[0];
        return v.defs.length === 1 && d?.type === 'Variable' && d.parent.kind === 'const' && d.node.id.type === 'Identifier' && isStatic(d.node.init, depth + 1);
      }
      return false;
    };
    return {
      MemberExpression(node) {
        if (propertyName(node) !== 'raw' || !isSql(node.object)) return;
        // sql.raw(…)로 부르는 곳만 인자를 본다. 값으로 넘기기(xs.map(sql.raw))는 무엇이 들어갈지 볼 수 없다
        let call = node;
        while (call.parent && TS_WRAPPERS.has(call.parent.type)) call = call.parent;
        const p = call.parent;
        if (p?.type === 'CallExpression' && p.callee === call) {
          if (!(p.arguments.length === 1 && isStatic(p.arguments[0]))) report(p);
        } else report(node);
      },
      // const { raw } = sql
      "VariableDeclarator[id.type='ObjectPattern']"(node) {
        if (!isSql(node.init)) return;
        for (const prop of node.id.properties) if (prop.type === 'Property' && !prop.computed && (prop.key.name ?? prop.key.value) === 'raw') report(prop);
      },
      // x.execute(`…${값}…`)·x.query(`…`): sql 태그 없이 글을 이어 만든 SQL. 끼운 값이 모두 같은 파일의 const 글자면 받는다
      CallExpression(node) {
        const callee = unwrap(node.callee);
        const name = callee?.type === 'MemberExpression' ? propertyName(callee) : null;
        if (name !== 'execute' && name !== 'query') return;
        const arg = unwrap(node.arguments[0]);
        if (arg?.type === 'TemplateLiteral' && arg.expressions.length > 0 && !arg.expressions.every((e) => isStatic(e))) report(node);
      },
    };
  },
};

export const serviceSecurityPlugin = {
  rules: { 'no-direct-outbound-http': outboundRule, 'route-response-schema': responseSchemaRule, 'sql-raw-allowlist': sqlRawRule, 'no-prototype-mutation': prototypeMutationRule },
};

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
  {
    file: 'services/bundle/src/management.ts',
    allow: ['fetch'],
    reason: '한 프로세스 합본의 관리 포트가 같은 프로세스 안 서비스 관리 포트(127.0.0.1 고정)의 /ready·/metrics를 모은다. 바깥 주소를 부르지 않는 시험 도구다(PEAKET_ENV local·ci에서만 시작, docs/verification.md §3.8 합본의 v1 무대, BUILD_ORDER PRF-215)',
  },
];

/** 기준선: HEAD 320e213a의 라우트 처리기 가운데 응답 스키마 표시가 없는 것('파일 경로#클래스.메서드') */
export const RESPONSE_SCHEMA_BASELINE = JSON.parse(readFileSync(new URL('./response-schema-baseline.json', import.meta.url), 'utf8')).handlers;

/** sql.raw에 동적 글자를 넘겨도 되는 파일과 까닭(ADR-0037, ADR-0263 결정 6) */
export const SQL_RAW_ALLOWLIST = JSON.parse(readFileSync(new URL('./sql-raw-allowlist.json', import.meta.url), 'utf8')).files;

/** 허용 목록 줄: 파일 하나(글롭 없이), 까닭, 겹침 없음. root를 주면 그 파일이 있는지도 본다 */
function checkSqlRawAllowlist(list, root) {
  if (!Array.isArray(list)) throw new TypeError('sql.raw 허용 목록은 { file, reason } 줄의 목록이다');
  const seen = new Set();
  for (const e of list) {
    if (typeof e?.file !== 'string' || !/^[\w@./-]+$/.test(e.file) || e.file.includes('*') || e.file.startsWith('/')) throw new TypeError(`sql.raw 허용 목록은 파일 하나를 경로로 적는다: ${e?.file}`);
    if (typeof e.reason !== 'string' || e.reason.trim() === '') throw new TypeError(`sql.raw 허용 목록 줄에 까닭이 없다: ${e.file}`);
    if (seen.has(e.file)) throw new TypeError(`sql.raw 허용 목록 줄이 겹친다: ${e.file}`);
    seen.add(e.file);
    if (root !== undefined && !existsSync(join(root, e.file))) throw new TypeError(`sql.raw 허용 목록이 가리키는 파일이 없다(옮겼으면 고치고, 지웠으면 그 줄을 지운다): ${e.file}`);
  }
  return list;
}

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
 * @param {string[]} roots 서비스 소스 폴더 글롭(예: 'services/*\/src'). 네 규칙을 모두 건다
 * @param {{ exceptions?: typeof OUTBOUND_HTTP_EXCEPTIONS, baseline?: string[], sqlRawAllowlist?: typeof SQL_RAW_ALLOWLIST, sharedRoots?: string[], root?: string }} [o]
 *   sharedRoots: 서비스가 함께 쓰는 서버 패키지 소스(packages/platform/src). sql.raw·원형 규칙만 건다(공용 외부 호출 클라이언트 자신은 fetch를 쓴다).
 *   root: 저장소 뿌리. 주면 허용 목록이 가리키는 파일이 있는지 본다(뿌리 eslint.config.mjs가 준다)
 * @returns {import('eslint').Linter.Config[]}
 */
export function serviceSecurityConfigs(roots, { exceptions = OUTBOUND_HTTP_EXCEPTIONS, baseline = RESPONSE_SCHEMA_BASELINE, sqlRawAllowlist = SQL_RAW_ALLOWLIST, sharedRoots = [], root } = {}) {
  checkExceptions(exceptions);
  checkSqlRawAllowlist(sqlRawAllowlist, root);
  const languageOptions = { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' };
  const shared = { 'peaket-service/sql-raw-allowlist': 'error', 'peaket-service/no-prototype-mutation': 'error' };
  return [
    {
      files: roots.map((r) => `${r}/**/*.ts`),
      languageOptions,
      plugins: { 'peaket-service': serviceSecurityPlugin },
      rules: {
        'peaket-service/no-direct-outbound-http': 'error',
        'peaket-service/route-response-schema': ['error', { baseline }],
        ...shared,
      },
    },
    ...(sharedRoots.length > 0 ? [{ files: sharedRoots.map((r) => `${r}/**/*.ts`), languageOptions, plugins: { 'peaket-service': serviceSecurityPlugin }, rules: shared }] : []),
    ...exceptions.map((e) => ({ files: [e.file], rules: { 'peaket-service/no-direct-outbound-http': ['error', { allow: e.allow }] } })),
    ...sqlRawAllowlist.map((e) => ({ files: [e.file], rules: { 'peaket-service/sql-raw-allowlist': ['error', { allowDynamic: true }] } })),
  ];
}
