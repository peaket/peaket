// 구간 1 끝 정리(docs/lanes/lane2.md '구간 끝 정리 목록', BAS-210 지적) 재현 시험. 고치기 전에 실패하는 것을 확인했다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import { webCompatConfigs, BROWSERS } from './web-compat.mjs';
import { resolveTargets } from './bcd-rule.mjs';

const linter = new Linter({ configType: 'flat' });
const flagged = (code) =>
  [...new Set(linter.verify(code, webCompatConfigs(['**/*.ts']), { filename: 'x.ts' }).filter((m) => m.ruleId === 'peaket-compat/bcd').map((m) => m.message.split('은(는)')[0]))];

test('NFR-019 확인보다 앞에서 쓴 것은 통과시키지 않는다(같은 함수 안에서도 차례를 본다)', () => {
  assert.deepEqual(flagged('export function f(s: AbortSignal[]) { const a = AbortSignal.any(s); if (!AbortSignal.any) return s[0]; return a; }'), ['AbortSignal.any']);
  assert.deepEqual(flagged('export function f(s: AbortSignal[]) { if (!AbortSignal.any) return s[0]; return AbortSignal.any(s); }'), []);
});

test('NFR-019 모듈 맨 위의 확인도 그 뒤의 사용만 통과시킨다', () => {
  assert.deepEqual(flagged('export const a = AbortSignal.any([]);\nexport const ok = typeof AbortSignal.any === "function";'), ['AbortSignal.any']);
});

test('NFR-019 TypeScript 문법을 거친 확인(as·!)을 알아보고, globalThis.X.y도 본다', () => {
  assert.deepEqual(flagged('export function f(s: AbortSignal[]) { if (typeof (AbortSignal as any).any === "function") return (AbortSignal as any).any(s); return s[0]; }'), []);
  // 옛 규칙이 헛보고하던 꼴: TS 문법으로 확인하고 그냥 쓴다
  assert.deepEqual(flagged('export function f(s: AbortSignal[]) { if (typeof (AbortSignal as any).any === "function") return AbortSignal.any(s); return s[0]; }'), []);
  assert.deepEqual(flagged('export function f(s: AbortSignal[]) { if ("any" in (AbortSignal as any)) return AbortSignal.any(s); return s[0]; }'), []);
  assert.deepEqual(flagged('export const a = globalThis.AbortSignal.any([]);'), ['AbortSignal.any']);
  assert.deepEqual(flagged('export const a = window.Promise.withResolvers();'), ['Promise.withResolvers']);
});

test('NFR-019 목표 브라우저에 Android Chrome(스캐너·콘솔)이 든다', () => {
  assert.ok(BROWSERS.includes('last 2 ChromeAndroid versions'));
  assert.ok(resolveTargets(BROWSERS).chrome_android);
});

test('NFR-019 화면이 묶는 생성물(api-client·ds의 src/gen)은 브라우저 지원 린트를 받고, 계약 생성물만 뺀다', async () => {
  const { ESLint } = await import('eslint');
  const { fileURLToPath } = await import('node:url');
  const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
  assert.equal(await eslint.isPathIgnored('packages/api-client/src/gen/seats.ts'), false);
  assert.equal(await eslint.isPathIgnored('packages/ds/src/gen/tokens.ts'), false);
  assert.equal(await eslint.isPathIgnored('packages/contracts/src/gen/openapi/seats.ts'), true);
  const cfg = await eslint.calculateConfigForFile('packages/api-client/src/gen/seats.ts');
  assert.equal(cfg.rules['peaket-compat/bcd']?.[0] ?? cfg.rules['peaket-compat/bcd'], 2);
});
