// 화면 보안 린트 시험(docs/security/asvs/delivery.md 3.2.2·3.5.5, ADR-0259 결정 10, BUILD_ORDER BAS-010 ①).
// 실행: cd packages/config && node --test "eslint/*.test.mjs"
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import { WEB_SECURITY_EXCEPTIONS, webSecurityConfigs } from './web-security.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HTML = 'peaket-web/no-html-injection';
const MESSAGE = 'peaket-web/no-window-message';
const linter = new Linter({ configType: 'flat' });

/** 그 코드를 화면 파일 자리(x.tsx)에서 린트해 규칙 ID마다 오류 수를 돌려준다 */
function ruleErrors(code, { filename = 'apps/web/src/x.tsx', configs = webSecurityConfigs(['**/*.{ts,tsx}']) } = {}) {
  const out = linter.verify(code, configs, { filename });
  const fatal = out.filter((m) => m.fatal);
  assert.deepEqual(fatal, [], `해석 실패: ${code}`);
  return out.filter((m) => m.severity === 2).map((m) => m.ruleId);
}
const blocked = (rule, code, opts) => ruleErrors(code, opts).includes(rule);

const HTML_BLOCKED = [
  'export const A = (p: { h: string }) => <div dangerouslySetInnerHTML={{ __html: p.h }} />;',
  // JSX 밖에서 같은 속성을 만들어 펼쳐도 막는다
  "import { createElement } from 'react';\nexport const A = (h: string) => createElement('div', { dangerouslySetInnerHTML: { __html: h } });",
  'export const props = (h: string) => ({ dangerouslySetInnerHTML: { __html: h } });',
  'export function f(el: HTMLElement, h: string) { el.innerHTML = h; }',
  'export function f(el: HTMLElement, h: string) { el.outerHTML = h; }',
  'export function f(el: HTMLElement, h: string) { el.innerHTML += h; }',
  "export function f(el: HTMLElement, h: string) { el['innerHTML'] = h; }",
  "export function f(el: HTMLElement, h: string) { el.insertAdjacentHTML('beforeend', h); }",
  "export function f(el: HTMLElement, h: string) { el['insertAdjacentHTML']('beforeend', h); }",
  'export function f(h: string) { document.write(h); }',
  'export function f(h: string) { document.writeln(h); }',
  'export function f(h: string) { window.document.write(h); }',
  'export function f(el: HTMLElement, h: string) { (el as any).setHTMLUnsafe(h); }',
  'export function f(h: string) { return document.createRange().createContextualFragment(h); }',
  'export const A = (p: { h: string }) => <iframe title="t" srcDoc={p.h} />;',
  'export function f(el: HTMLIFrameElement, h: string) { el.srcdoc = h; }',
];
const HTML_ALLOWED = [
  'export function f(el: HTMLElement, t: string) { el.textContent = t; }',
  'export const read = (el: HTMLElement) => el.innerHTML.length;',
  'export const A = (p: { t: string }) => <div title={p.t}>{p.t}</div>;',
  "export function f(el: HTMLElement, t: string) { el.insertAdjacentText('beforeend', t); }",
  "export function f(el: HTMLElement, c: HTMLElement) { el.insertAdjacentElement('beforeend', c); }",
  'export function f(w: { write(s: string): void }, t: string) { w.write(t); }',
  'export const A = (p: { src: string }) => <iframe title="t" src={p.src} />;',
];

test('[ASVS v5.0.0-3.2.2] dangerouslySetInnerHTML·innerHTML 계열을 막는다', () => {
  for (const code of HTML_BLOCKED) assert.ok(blocked(HTML, code), `막아야 한다: ${code}`);
  for (const code of HTML_ALLOWED) assert.deepEqual(ruleErrors(code), [], `막지 않아야 한다: ${code}`);
  // 오류 글은 대신 쓸 것(글로 그리기)과 근거를 알려 준다
  const [m] = linter.verify(HTML_BLOCKED[0], webSecurityConfigs(['**/*.{ts,tsx}']), { filename: 'x.tsx' });
  assert.match(m.message, /3\.2\.2/);
  assert.match(m.message, /textContent|글/);
});

const MESSAGE_BLOCKED = [
  "window.addEventListener('message', (e) => console.log(e.data));",
  "self.addEventListener('message', () => {});",
  "globalThis.addEventListener('message', () => {});",
  "parent.addEventListener('message', () => {});",
  "addEventListener('message', () => {});",
  'window.addEventListener(`message`, () => {});',
  'window.onmessage = () => {};',
  'onmessage = () => {};',
];
const MESSAGE_ALLOWED = [
  "window.addEventListener('resize', () => {});",
  "window.addEventListener('pageshow', () => {});",
  // 창이 아닌 통로(MessagePort·BroadcastChannel)의 메시지는 이 규칙이 보지 않는다(화면별 판정은 기능 표)
  "export function f(port: MessagePort) { port.addEventListener('message', () => {}); }",
  "export function f(c: BroadcastChannel) { c.onmessage = () => {}; }",
];

test('[ASVS v5.0.0-3.5.5] 창 메시지 수신기를 막는다', () => {
  for (const code of MESSAGE_BLOCKED) assert.ok(blocked(MESSAGE, code, { filename: 'apps/web/src/x.ts' }), `막아야 한다: ${code}`);
  for (const code of MESSAGE_ALLOWED) assert.deepEqual(ruleErrors(code, { filename: 'apps/web/src/x.ts' }), [], `막지 않아야 한다: ${code}`);
});

test('[ASVS v5.0.0-3.2.2] 예외는 적은 파일에서 적은 항목만 풀고, 목록의 항목은 파일·항목·까닭을 모두 적는다', () => {
  const exceptions = [{ file: 'apps/web/src/rich/Description.tsx', allow: ['dangerouslySetInnerHTML'], reason: '시험용: 정화한 HTML을 그린다' }];
  const configs = webSecurityConfigs(['**/*.{ts,tsx}'], { exceptions });
  const jsx = HTML_BLOCKED[0];
  assert.deepEqual(ruleErrors(jsx, { filename: 'apps/web/src/rich/Description.tsx', configs }), []);
  // 같은 파일이라도 적지 않은 항목(innerHTML)은 막고, 다른 파일은 그대로 막는다
  assert.ok(blocked(HTML, HTML_BLOCKED[3], { filename: 'apps/web/src/rich/Description.tsx', configs }));
  assert.ok(blocked(HTML, jsx, { filename: 'apps/web/src/rich/Other.tsx', configs }));
  // 까닭 없는 예외·모르는 항목은 설정을 만들 때 거절한다
  assert.throws(() => webSecurityConfigs(['**/*.tsx'], { exceptions: [{ file: 'a.tsx', allow: ['dangerouslySetInnerHTML'], reason: '' }] }), /까닭/);
  assert.throws(() => webSecurityConfigs(['**/*.tsx'], { exceptions: [{ file: 'a.tsx', allow: ['eval'], reason: 'x' }] }), /eval/);
  assert.throws(() => webSecurityConfigs(['**/*.tsx'], { exceptions: [{ file: 'apps/**/*.tsx', allow: ['innerHTML'], reason: 'x' }] }), /파일 하나/);
  for (const e of WEB_SECURITY_EXCEPTIONS) {
    assert.ok(existsSync(`${ROOT}${e.file}`), `예외 파일이 없다: ${e.file}`);
    assert.ok(e.reason.trim().length > 0 && e.allow.length > 0, e.file);
  }
});

test('[ASVS v5.0.0-3.2.2] 뿌리 설정이 화면 코드(앱·화면 패키지)에 화면 보안 규칙을 걸고 시험 파일과 서비스에는 걸지 않는다', async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const jsx = HTML_BLOCKED[0];
  const rulesAt = async (path, code) => {
    const [r] = await eslint.lintText(code, { filePath: `${ROOT}${path}` });
    return r.messages.filter((m) => m.severity === 2).map((m) => m.ruleId);
  };
  for (const path of ['apps/web/src/_probe/x.tsx', 'apps/partner/app/_probe/x.tsx', 'apps/scanner/src/_probe/x.tsx', 'packages/ds/src/_probe/x.tsx', 'packages/seatmap/src/_probe/x.tsx']) {
    assert.ok((await rulesAt(path, jsx)).includes(HTML), path);
    assert.ok((await rulesAt(path.replace(/x\.tsx$/, 'y.ts'), MESSAGE_BLOCKED[0])).includes(MESSAGE), path);
  }
  // 목업 금지 규칙(no-restricted-syntax)이 같은 파일에 걸려도 창 메시지 규칙이 덮이지 않는다
  const both = `import('msw');\n${MESSAGE_BLOCKED[0]}`;
  const r = await rulesAt('apps/web/src/_probe/z.ts', both);
  assert.ok(r.includes('no-restricted-syntax') && r.includes(MESSAGE), r.join(','));
  assert.deepEqual((await rulesAt('apps/web/src/_probe/x.test.tsx', jsx)).filter((id) => id === HTML), []);
  assert.deepEqual((await rulesAt('services/demo-svc/src/x.ts', 'export function f(el: any, h: string) { el.innerHTML = h; }')).filter((id) => id === HTML), []);
});

// ---------- 리뷰 R8(2026-11-10) 재현 시험: 규칙 빠져나갈 길 ----------
test('[ASVS v5.0.0-3.2.2] Object.assign·Reflect.set·setAttribute·템플릿 글자 계산 속성으로 HTML을 넣는 길도 막는다', () => {
  const blockedCases = [
    'export function f(el: HTMLElement, h: string) { Object.assign(el, { innerHTML: h }); }',
    'export function f(el: HTMLElement, innerHTML: string) { Object.assign(el, { innerHTML }); }',
    "export function f(el: HTMLElement, h: string) { Object.assign(el, { ['outerHTML']: h }); }",
    'export function f(el: HTMLElement, h: string) { Object.assign(el, { [`innerHTML`]: h }); }',
    'export function f(el: HTMLElement, h: string) { Object.assign(el, { title: "t" }, { outerHTML: h }); }',
    'export function f(el: HTMLIFrameElement, h: string) { Object.assign(el, { srcdoc: h }); }',
    "export function f(el: HTMLElement, h: string) { Reflect.set(el, 'innerHTML', h); }",
    "export function f(el: HTMLIFrameElement, h: string) { el.setAttribute('srcdoc', h); }",
    "export function f(el: HTMLElement, h: string) { el.setAttribute('onclick', h); }",
    "export function f(el: HTMLElement, h: string) { el.setAttribute('ONLOAD', h); }",
    'export function f(el: HTMLElement, h: string) { el.setAttribute(`onerror`, h); }',
    "export function f(el: HTMLElement, h: string) { el.setAttributeNS(null, 'onclick', h); }",
    'export function f(el: HTMLElement, h: string) { el[`innerHTML`] = h; }',
    'export function f(el: HTMLElement, h: string) { el[`outerHTML`] = h; }',
    "export function f(el: HTMLElement, h: string) { el['insertAdjacentHTML' as const]('beforeend', h); }",
  ];
  for (const code of blockedCases) assert.ok(blocked(HTML, code, { filename: 'apps/web/src/x.ts' }), `막아야 한다: ${code}`);
  const allowedCases = [
    "export function f(el: HTMLElement, t: string) { el.setAttribute('title', t); el.setAttribute('data-on', t); el.setAttribute('aria-label', t); }",
    'export function f(el: HTMLElement, t: string) { Object.assign(el, { textContent: t }); Object.assign(el.style, { color: t }); }',
  ];
  for (const code of allowedCases) assert.deepEqual(ruleErrors(code, { filename: 'apps/web/src/x.ts' }), [], `막지 않아야 한다: ${code}`);
});

test('[ASVS v5.0.0-3.5.5] 형 단언(as const·satisfies·<const>)을 씌운 message 수신기도 막는다', () => {
  const blockedCases = [
    "window.addEventListener('message' as const, () => {});",
    "window.addEventListener('message' satisfies string, () => {});",
    "addEventListener(<const>'message', () => {});",
    "self.addEventListener(('message' as const) as 'message', () => {});",
    "globalThis.addEventListener(`message` as const, () => {});",
  ];
  for (const code of blockedCases) assert.ok(blocked(MESSAGE, code, { filename: 'apps/web/src/x.ts' }), `막아야 한다: ${code}`);
  assert.deepEqual(ruleErrors("window.addEventListener('resize' as const, () => {});", { filename: 'apps/web/src/x.ts' }), []);
});

// ---------- 다시 보기 S2(2026-11-10) 재현 시험 ----------
test('[ASVS v5.0.0-3.2.2] DOMParser.parseFromString으로 HTML을 해석하는 것도 막는다', () => {
  const blockedCases = [
    "export const d = (h: string) => new DOMParser().parseFromString(h, 'text/html');",
    "const p = new DOMParser();\nexport const d = (h: string) => p.parseFromString(h, 'text/html');",
    "export const d = (h: string) => new window.DOMParser()['parseFromString'](h, 'image/svg+xml');",
    'export const d = (h: string) => new DOMParser().parseFromString(h, `text/html`).body;',
  ];
  for (const code of blockedCases) assert.ok(blocked(HTML, code, { filename: 'apps/web/src/x.ts' }), `막아야 한다: ${code}`);
  const [m] = linter.verify(blockedCases[0], webSecurityConfigs(['**/*.{ts,tsx}']), { filename: 'x.ts' }).filter((x) => x.ruleId === HTML);
  assert.match(m.message, /DOMParser/);
  assert.deepEqual(ruleErrors('export const j = (h: string) => JSON.parse(h);', { filename: 'apps/web/src/x.ts' }), []);
});
