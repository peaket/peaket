// 프로토타입 오염 린트 규칙(no-prototype-mutation) 시험(docs/security/asvs/delivery.md 15.3.6, docs/devops.md §4.4 '보안 린트', ADR-0263 결정 6,
// BUILD_ORDER BAS-011 ②). 실행: cd packages/config && node --test "eslint/*.test.mjs"
// 규칙 시험(구문마다 막고 받는가)과 뿌리 설정 연결 시험(어느 파일에 걸리고, 줄 안 주석 끄기 검사가 그 이름을 보안 규칙으로 세는가)을 나눈다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { lintPaths, parseDirective, SECURITY_RULE, touchesSecurity } from '../../../tools/ci/check-lint-disables.mjs';
import { prototypeMutationRule } from './js-security.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RULE = 'probe/no-prototype-mutation';
const linter = new Linter({ configType: 'flat' });
const CONFIG = [{ files: ['**/*.{ts,tsx}'], languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' }, plugins: { probe: { rules: { 'no-prototype-mutation': prototypeMutationRule } } }, rules: { [RULE]: 'error' } }];

/** 그 코드에서 규칙이 낸 오류 수 */
function count(code) {
  const out = linter.verify(code, CONFIG, { filename: 'x.ts' });
  assert.deepEqual(out.filter((m) => m.fatal), [], `해석 실패: ${code}`);
  return out.filter((m) => m.ruleId === RULE).length;
}

const BLOCKED = [
  // __proto__ 읽기·쓰기: 점, 계산된 글자 키, 식 없는 템플릿 글자, 형 단언, 구조 분해, 객체 글자로 원형 주기
  ['export const f = (o: any) => o.__proto__;', 1],
  ['export function f(o: any, v: unknown) { o.__proto__ = v; }', 1],
  ["export const f = (o: any) => o['__proto__'];", 1],
  ['export const f = (o: any) => o[`__proto__`];', 1],
  ['export const f = (o: unknown) => (o as any).__proto__.polluted;', 1],
  ['export function f(o: any) { const { __proto__: p } = o; return p; }', 1],
  ['const base = { admin: true };\nexport const o = { __proto__: base, a: 1 };', 1],
  // Object·Reflect.setPrototypeOf(두 번째 인자가 null이 아님), 계산된 이름, 떼어 내기
  ['export function f(o: object, p: object) { Object.setPrototypeOf(o, p); }', 1],
  ['export function f(o: object, p: object) { return Reflect.setPrototypeOf(o, p); }', 1],
  ["export function f(o: object) { Object['setPrototypeOf'](o, {}); }", 1],
  ['export function f(o: object, p: object | null) { Object.setPrototypeOf(o, p); }', 1],
  ['const { setPrototypeOf } = Object;\nexport const f = (o: object) => setPrototypeOf(o, {});', 1],
  // 내장 원형 고치기: 대입, 원형 바꾸기, 늘리기, 지우기, defineProperty·defineProperties·assign
  ['Object.defineProperty(Array.prototype, "last", { value() { return 1; } });', 1],
  ["(Array.prototype as any).last = function () { return this[this.length - 1]; };", 1],
  ['Object.prototype.toJSON = () => ({});', 1],
  ["(String.prototype as any)['pad'] = () => '';", 1],
  ['Function.prototype.call = Function.prototype.apply;', 1],
  ['(Promise as any).prototype = {};', 1],
  ['delete (Object.prototype as any).toString;', 1],
  ['(Object.prototype as any).count++;', 1],
  ['Object.defineProperties(Map.prototype, { x: { value: 1 } });', 1],
  ['Object.assign(Promise.prototype, { y: 1 });', 1],
  ['Reflect.defineProperty(Set.prototype, "z", { value: 1 });', 1],
  ['globalThis.Array.prototype.flat = () => [];', 1],
  // 깊은 병합·경로 대입 함수 가져오기
  ["import merge from 'lodash/merge';\nexport { merge };", 1],
  ["import { merge } from 'lodash';\nexport { merge };", 1],
  ["import { set as setIn } from 'lodash-es';\nexport { setIn };", 1],
  ["import _ from 'lodash';\nexport const f = (a: object, b: object) => _.merge(a, b);", 1],
  ["import * as L from 'lodash';\nexport const f = (a: object) => L.defaultsDeep(a, {});", 1],
  ["import deepmerge from 'deepmerge';\nexport { deepmerge };", 1],
  ["import extend from 'deep-extend';\nexport { extend };", 1],
  ["import { setProperty } from 'dot-prop';\nexport { setProperty };", 1],
  ["import mergeWith from 'lodash.mergewith';\nexport { mergeWith };", 1],
  ["import objectPath from 'object-path';\nexport const f = (o: object) => objectPath.set(o, 'a.b', 1);", 1],
  ["const merge = require('lodash.merge');\nexport { merge };", 1],
  ["const { zipObjectDeep } = require('lodash');\nexport { zipObjectDeep };", 1],
  ["export const load = () => import('set-value');", 1],
  ["export { merge } from 'lodash';", 1],
  // 리뷰 뒤 더한 규칙 ⑥(독립 틀린 구현 검사의 우회 길): 떼어 부르기
  ['export function f(o: object, p: object) { const sp = Object.setPrototypeOf; sp(o, p); }', 1],
  ['export function f(o: object, p: object) { Object.setPrototypeOf.call(Object, o, p); }', 1],
  ['export function f(o: object, p: object) { Object.setPrototypeOf.apply(Object, [o, p]); }', 1],
  ['export function f(o: object, p: object) { Reflect.apply(Object.setPrototypeOf, null, [o, p]); }', 1],
  ['export function f(o: object, p: object) { Reflect.apply(Reflect.setPrototypeOf, null, [o, p]); }', 1],
  ['export const sp = Object.setPrototypeOf;', 1],
  // getPrototypeOf(…)·constructor.prototype를 거친 원형 고치기
  ['export function f(v: unknown) { (Object.getPrototypeOf({}) as any).polluted = v; }', 1],
  ['export function f(v: unknown) { (Reflect.getPrototypeOf([]) as any).polluted = v; }', 1],
  ['export function f(v: unknown) { ({} as any).constructor.prototype.polluted = v; }', 1],
  ['export function f(o: any, v: unknown) { o.constructor.prototype.polluted = v; }', 1],
  ['export function f(o: any) { delete Object.getPrototypeOf(o).toString; }', 1],
  ['export function f(o: any) { Object.defineProperty(Object.getPrototypeOf(o), "x", { value: 1 }); }', 1],
  // 깊은 병합 라이브러리를 더 막는다
  ["import set from 'lodash/fp/set';\nexport { set };", 1],
  ["import { assocPath } from 'lodash/fp';\nexport { assocPath };", 1],
  ["import { merge } from 'es-toolkit';\nexport { merge };", 1],
  ["import { merge } from 'es-toolkit/compat';\nexport { merge };", 1],
  ["import { unflatten } from 'flat';\nexport { unflatten };", 1],
  ["import flat from 'flat';\nexport const f = (o: object) => flat.unflatten(o);", 1],
  ["export * from 'lodash';", 1],
  ["export const m = require('lodash').merge;", 1],
  // 한 줄에 둘이면 둘이다
  ['export function f(o: any, p: object) { o.__proto__ = Object.setPrototypeOf(o, p); }', 2],
];

const ALLOWED = [
  'export const o = Object.setPrototypeOf({}, null);',
  'export const f = (o: object) => Reflect.setPrototypeOf(o, null);',
  "export const isBad = (k: string) => k === '__proto__';",
  "const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);\nexport const bad = (k: string) => UNSAFE.has(k);",
  'export const o = { __proto__: null, a: 1 };',
  "export const o = { ['__proto__']: 1 };",
  'export const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);',
  'export const p = Object.getPrototypeOf([]) === Array.prototype;',
  'class Point { x = 0 }\n(Point.prototype as any).describe = function () { return "p"; };\nexport { Point };',
  'const Array = class {};\n(Array.prototype as any).x = 1;\nexport { Array };',
  "import { pick, groupBy } from 'lodash';\nexport { pick, groupBy };",
  "import { merge } from 'rxjs';\nexport { merge };",
  "import { mergeConfig } from 'vitest/config';\nexport { mergeConfig };",
  "import _ from 'lodash';\nexport const f = (a: object) => _.pick(a, ['x']);",
  'export const proto = (o: object) => Object.getPrototypeOf(o);',
  'export const same = (o: object) => Object.getPrototypeOf(o) === Object.prototype;',
  'export const name = (o: object) => o.constructor.name;',
  'export const isPlain = (o: object) => Object.getPrototypeOf(o)?.constructor === Object;',
  'export const n = (o: object) => Object.setPrototypeOf(o, null);',
  "import { pick } from 'es-toolkit';\nexport { pick };",
  "import { flatten } from 'flat';\nexport { flatten };",
  "export function f(o: Record<string, unknown>) { Object.defineProperty(o, '__proto__', { value: 1, enumerable: true }); }",
];

test('[ASVS v5.0.0-15.3.6] __proto__ 읽기·쓰기(점·계산된 글자 키), Object·Reflect.setPrototypeOf, 내장 원형 대입, 깊은 병합·경로 대입 함수 가져오기를 막고 setPrototypeOf(x, null)·\'__proto__\' 문자열 값은 받는다', () => {
  for (const [code, n] of BLOCKED) assert.equal(count(code), n, `막을 오류 수가 다르다: ${code}`);
  for (const code of ALLOWED) assert.equal(count(code), 0, `받아야 한다: ${code}`);
  // 오류 글은 바꿀 길을 알린다
  const [m] = linter.verify('export const f = (o: any) => o.__proto__;', CONFIG, { filename: 'x.ts' });
  assert.match(m.message, /15\.3\.6/);
});

test('[ASVS v5.0.0-15.3.6] 원형 규칙이 화면 파일과 서비스 파일, packages/platform/src 모두에 걸리고 줄 안 주석 끄기 검사가 그 규칙 이름을 보안 규칙으로 센다', async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const code = 'export const f = (o: any) => o.__proto__;\n';
  const rulesAt = async (path) => {
    const [r] = await eslint.lintText(code, { filePath: `${ROOT}${path}` });
    return r.messages.filter((x) => x.severity === 2).map((x) => x.ruleId);
  };
  const web = 'peaket-web/no-prototype-mutation';
  const service = 'peaket-service/no-prototype-mutation';
  for (const [path, rule] of [
    ['apps/web/src/_probe/x.ts', web],
    ['apps/partner/app/_probe/x.tsx', web],
    ['packages/validation/src/_probe/x.ts', web],
    ['packages/api-client/src/_probe/x.ts', web],
    ['services/demo-svc/src/modules/note/domain/x.ts', service],
    ['packages/platform/template/src/x.ts', service],
    ['packages/platform/src/_probe.ts', service],
    ['packages/shuffle/src/_probe.ts', service],
    ['packages/search-normalize/src/_probe.ts', service],
  ]) {
    assert.deepEqual((await rulesAt(path)).filter((id) => id.endsWith('/no-prototype-mutation')), [rule], path);
  }
  // 시험 파일에는 걸지 않는다
  assert.deepEqual((await rulesAt('services/demo-svc/test/x.test.ts')).filter((id) => id.endsWith('/no-prototype-mutation')), []);
  // 줄 안 주석 끄기 검사가 두 이름 모두를 보안 규칙으로 센다
  for (const name of [web, service]) {
    assert.ok(SECURITY_RULE.test(name), name);
    assert.equal(touchesSecurity(parseDirective(`// eslint-disable-next-line ${name}`), { securityFile: true }), true, name);
  }
  // 그 검사가 읽는 뿌리 lint 경로에 packages/platform/src와 공용 패키지 둘이 든다
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8'));
  for (const p of ['packages/platform/src', 'packages/shuffle/src', 'packages/search-normalize/src']) assert.ok(lintPaths(pkg.scripts.lint).includes(p), `${p}: ${pkg.scripts.lint}`);
});

test('[ASVS v5.0.0-15.3.6] 뿌리 lint 경로에서 ESLint가 보는 모든 파일에 원형 규칙이 켜져 있고 설정에서 끄지 않는다(시험·이야기·스크립트·설정 파일 포함)', async () => {
  const { readdirSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const eslint = new ESLint({ cwd: ROOT });
  const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8'));
  const files = [];
  const SKIP = new Set(['node_modules', 'dist', 'dist-poc', '.next', '.turbo']);
  const walk = (d) => {
    let es;
    try {
      es = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.next-')) walk(p);
      } else files.push(p);
    }
  };
  for (const p of lintPaths(pkg.scripts.lint)) walk(join(ROOT, p));
  const on = (c, r) => {
    const v = c.rules?.[r];
    const sev = Array.isArray(v) ? v[0] : v;
    return sev === 2 || sev === 'error';
  };
  let linted = 0;
  const off = [];
  for (const f of files) {
    if (await eslint.isPathIgnored(f)) continue;
    const c = await eslint.calculateConfigForFile(f);
    if (!c) continue;
    linted++;
    if (!on(c, 'peaket-web/no-prototype-mutation') && !on(c, 'peaket-service/no-prototype-mutation')) off.push(relative(ROOT, f).replace(/\\/g, '/'));
  }
  assert.ok(linted > 1000, `린트 대상 파일이 너무 적다: ${linted}`);
  assert.deepEqual(off.slice(0, 20), [], `원형 규칙이 꺼진 린트 대상 ${off.length}개`);
});
