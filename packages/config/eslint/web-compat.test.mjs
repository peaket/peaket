// 화면 코드 브라우저 지원 린트 시험(docs/frontend.md §1.5, NFR-019, BUILD_ORDER BAS-210)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import { webCompatConfigs, BROWSERS } from './web-compat.mjs';
import { resolveTargets } from './bcd-rule.mjs';

const linter = new Linter({ configType: 'flat' });
const lint = (code) => linter.verify(code, webCompatConfigs(['**/*.ts']), { filename: 'x.ts' });
const RULES = new Set(['compat/compat', 'peaket-compat/bcd']);
const errors = (code) => lint(code).filter((m) => RULES.has(m.ruleId));
// 두 규칙이 같은 기능을 함께 보고할 수 있어(compat이 아는 옛 기능) 이름으로 모은다
const flagged = (code) => [...new Set(errors(code).map((m) => m.message.split(/은\(는\)| is not supported/)[0]))];

test('NFR-019 목표 브라우저는 주요 브라우저의 최신 2개 판과 iOS·iPadOS Safari 16.4 이상이다', () => {
  assert.ok(BROWSERS.includes('iOS >= 16.4'));
  for (const b of ['Chrome', 'Edge', 'Firefox', 'Safari', 'Samsung']) assert.ok(BROWSERS.includes(`last 2 ${b} versions`), b);
  const t = resolveTargets(BROWSERS);
  assert.equal(t.safari_ios, '16.4');
  for (const id of ['chrome', 'edge', 'firefox', 'safari', 'samsunginternet_android']) assert.ok(t[id], id);
});

test('NFR-019 목표 밖의 웹 API와 ES 내장 기능을 바로 쓰면 막는다(§1.5 표의 AbortSignal.any 포함)', () => {
  assert.deepEqual(flagged('export const s = AbortSignal.any([new AbortController().signal]);'), ['AbortSignal.any']);
  assert.deepEqual(flagged('export const r = Promise.withResolvers();'), ['Promise.withResolvers']);
  assert.deepEqual(flagged('export const g = Object.groupBy([1], (x) => x);'), ['Object.groupBy']);
  assert.deepEqual(flagged('export const v = () => document.startViewTransition(() => {});'), ['document.startViewTransition']);
  // compat은 scheduler를, 보조 규칙은 window.X.y를 X.y로 보아 scheduler.yield를 잡는다
  assert.deepEqual(flagged('export const y = () => window.scheduler.yield();'), ['scheduler', 'scheduler.yield']);
  const msg = errors('export const s = AbortSignal.any([]);')[0].message;
  assert.match(msg, /iOS Safari 16\.4/);
  assert.match(msg, /MDN 자료 8\./);
});

test('NFR-019 기능을 먼저 확인하고 쓰면 통과한다', () => {
  const ok = [
    "export function f(s: AbortSignal[]) { if (typeof AbortSignal.any === 'function') return AbortSignal.any(s); return s[0]; }",
    'export function f(s: AbortSignal[]) { if (!AbortSignal.any) return s[0]; return AbortSignal.any(s); }',
    'export const f = (s: AbortSignal[]) => (AbortSignal.any ? AbortSignal.any(s) : s[0]);',
    "export const f = (s: AbortSignal[]) => ('any' in AbortSignal ? AbortSignal.any(s) : s[0]);",
    'export const v = () => document.startViewTransition?.(() => {});',
    "export function y() { if ('scheduler' in globalThis) return scheduler.yield(); return Promise.resolve(); }",
    "export const c = () => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : null);",
  ];
  for (const code of ok) assert.deepEqual(errors(code), [], code);
});

test('NFR-019 목표 안의 기능, 같은 이름의 지역 변수, 타입 자리는 막지 않는다', () => {
  const ok = [
    'export const c = structuredClone({ a: 1 });',
    'export const t = AbortSignal.timeout(1000);',
    'export const o = new OffscreenCanvas(1, 1);',
    // 부분 지원은 지원으로 친다(iOS의 window.open은 `_blank` 대상만 안 된다)
    "export const w = () => window.open('about:blank', 'verify');",
    'const Promise = { withResolvers: () => 1 }; export const r = Promise.withResolvers();',
    'export function f(signal: AbortSignal): AbortSignal { return signal; }',
  ];
  for (const code of ok) assert.deepEqual(errors(code), [], code);
});

test('NFR-019 Node에서 도는 시험 파일은 보지 않는다', () => {
  const code = 'export const n = () => new Promise((r) => setImmediate(r));';
  assert.equal(linter.verify(code, webCompatConfigs(['**/*.ts']), { filename: 'x.ts' }).length, 1);
  assert.deepEqual(linter.verify(code, webCompatConfigs(['**/*.ts']), { filename: 'flow.test.ts' }).filter((m) => RULES.has(m.ruleId)), []);
});

test('NFR-019 아직 싣지 않은 React·접근성 규칙을 가리키는 주석은 오류를 내지 않는다', () => {
  assert.deepEqual(lint('// eslint-disable-next-line react-hooks/exhaustive-deps\nexport const a = 1;'), []);
});

test('NFR-019 상위 객체만 확인한 코드(서버 그리기 확인 등)는 그 아래 새 기능을 통과시키지 않는다(새 맥락 리뷰 재현)', () => {
  assert.deepEqual(
    flagged("export function v() { if (typeof document === 'undefined') return; document.startViewTransition(() => {}); }"),
    ['document.startViewTransition'],
  );
  assert.deepEqual(flagged("export function f(s: AbortSignal[]) { if (typeof AbortSignal !== 'undefined') return AbortSignal.any(s); return s[0]; }"), ['AbortSignal.any']);
  assert.deepEqual(flagged("export function w() { if (typeof navigator === 'undefined') return; return navigator.wakeLock; }").length, 0, '부분 지원은 지원으로 친다');
});

test('NFR-019 선언 안 된 전역 이름은 typeof·in으로 확인해야 한다(if (X)는 없는 브라우저에서 ReferenceError, 새 맥락 리뷰 재현)', () => {
  assert.deepEqual(flagged('export function i(cb: () => void) { if (requestIdleCallback) requestIdleCallback(cb); }'), ['requestIdleCallback']);
  assert.deepEqual(errors("export function i(cb: () => void) { if (typeof requestIdleCallback === 'function') requestIdleCallback(cb); }"), []);
  assert.deepEqual(errors("export function i(cb: () => void) { if ('requestIdleCallback' in window) requestIdleCallback(cb); }"), []);
});
