// 좌석맵 에디터 화면 보안 시험(ADR-0264 결정 2, asvs/seat-hold.md 1.3.2·3.4.3, asvs/frontend.md 15.1.4).
// 뿌리 ESLint 설정을 실제로 읽어 위반 표본을 린트하고, 파트너 콘솔 proxy를 에디터 경로로 불러 응답 머리를 본다.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

register('../../shared/lib/test-ts-resolve.mjs', import.meta.url);

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: join(ROOT, 'eslint.config.mjs') });
async function rules(code, file) {
  const [r] = await eslint.lintText(code, { filePath: join(ROOT, file) });
  return r.messages.filter((m) => m.severity === 2).map((m) => m.ruleId);
}
const PAGE = 'apps/partner/src/_pages/seatmap-editor/ui/live/Sample.tsx';
const HOME = 'apps/partner/src/widgets/seatmap-canvas/sample.ts';

test('konva는 CMP-051 폴더 밖에서 가져오지 않는다 [ASVS v5.0.0-15.1.4]', async () => {
  // 밖: 정적·동적 가져오기 모두 막는다
  assert.deepEqual(await rules("import Konva from 'konva/lib/Core';\nexport const k = Konva;\n", PAGE), ['no-restricted-imports']);
  // Next.js 경로 파일은 다시 내보내기만 받으므로(docs/frontend.md §2.2, ADR-0329 결정 5) 표본도 그 꼴로 둔다: 가져온 뒤 내보내기, 다시 내보내기로 잇는 우회
  const ROUTE = 'apps/partner/app/(console)/events/[id]/seatmap/page.tsx';
  assert.deepEqual(await rules("import Konva from 'konva';\nexport { Konva as default };\n", ROUTE), ['no-restricted-imports']);
  assert.deepEqual(await rules("export { default } from 'konva';\n", ROUTE), ['no-restricted-imports']);
  assert.deepEqual(await rules("export const load = () => import('konva/lib/shapes/Rect');\n", PAGE), ['no-restricted-syntax']);
  // 안: 받는다
  assert.deepEqual(await rules("import Konva from 'konva/lib/Core';\nimport { Rect } from 'konva/lib/shapes/Rect';\nexport const k = [Konva, Rect];\n", HOME), []);
  // 덮어쓴 규칙이 목업 금지를 지우지 않는다(같은 규칙 이름을 함께 싣는다)
  assert.deepEqual(await rules("import { http } from 'msw';\nexport const h = http;\n", PAGE), ['no-restricted-imports']);
  assert.deepEqual(await rules("import { http } from 'msw';\nexport const h = http;\n", HOME), ['no-restricted-imports']);
  // 지금 코드에서 konva를 가져오는 파일은 그 폴더 안뿐이다
  const offenders = konvaImporters(fileURLToPath(new URL('../../../', import.meta.url)));
  assert.deepEqual(offenders, []);
});

/** 앱 폴더(node_modules·빌드 산출 빼고)에서 konva를 가져오는 파일(작은·큰따옴표, 템플릿 글자, require, 동적 가져오기). CMP-051 폴더는 뺀다 */
function konvaImporters(root) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n.startsWith('.next')) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(n) && !/\.test\.|\.spec\./.test(n) && KONVA_IMPORT.test(readFileSync(p, 'utf8')) && !p.replaceAll('\\', '/').includes('/widgets/seatmap-canvas/')) out.push(p);
    }
  };
  walk(root);
  return out;
}
const KONVA_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"`]konva(?:[/'"`])/m;

test('konva 가져오기 막기는 require()·템플릿 글자 import()·큰따옴표와 jsx·cjs·mjs·mts·앱 뿌리 파일까지 덮는다 [ASVS v5.0.0-15.1.4]', async () => {
  const blocked = [
    ["const K = require('konva');\nexport default K;\n", 'apps/partner/src/_pages/seatmap-editor/ui/a.ts'],
    ['export const load = () => import(`konva`);\n', 'apps/partner/src/_pages/seatmap-editor/ui/b.ts'],
    ['import Konva from "konva/lib/Core";\nexport const k = Konva;\n', 'apps/partner/src/_pages/seatmap-editor/ui/c.tsx'],
    ["import Konva from 'konva';\nexport const k = Konva;\n", 'apps/partner/src/_pages/seatmap-editor/ui/d.jsx'],
    ["const K = require('konva/lib/Core');\nmodule.exports = K;\n", 'apps/partner/src/e.cjs'],
    ["import Konva from 'konva';\nexport const k = Konva;\n", 'apps/partner/src/f.mts'],
    ["import Konva from 'konva';\nexport const k = Konva;\n", 'apps/partner/proxy.ts'],
  ];
  for (const [code, file] of blocked) assert.ok((await rules(code, file)).length > 0, file);
  // 훑기도 같은 꼴을 잡는다
  for (const [code] of blocked) assert.ok(KONVA_IMPORT.test(code), code);
  assert.equal(KONVA_IMPORT.test("import { x } from 'konvalike';\n"), false);
});

test('eval·new Function·문자열 타이머 금지가 화면 패키지·서비스 소스에도 걸린다 [ASVS v5.0.0-1.3.2]', async () => {
  for (const file of ['packages/seatmap/src/sample.ts', 'packages/ds/src/sample.ts', 'packages/api-client/src/sample.ts', 'services/core-svc/src/sample.ts']) {
    assert.deepEqual(await rules('export const f = (s: string) => eval(s);\n', file), ['no-eval'], file);
  }
});

test('에디터 Worker의 메시지 수신은 별칭으로 비켜 가지 않고 화면 보안 린트 허용 목록에 까닭과 함께 있다 [ASVS v5.0.0-3.5.5]', async () => {
  const worker = readFileSync(new URL('./model/editor.worker.ts', import.meta.url), 'utf8');
  assert.match(worker, /\bself\.onmessage\s*=/);
  const { WEB_SECURITY_EXCEPTIONS } = await import('../../../../../packages/config/eslint/web-security.mjs');
  const e = WEB_SECURITY_EXCEPTIONS.find((x) => x.file === 'apps/partner/src/_pages/seatmap-editor/model/editor.worker.ts');
  assert.ok(e && e.allow.includes('windowMessage') && e.reason.length > 10);
  const [r] = await eslint.lintFiles([join(ROOT, 'apps/partner/src/_pages/seatmap-editor/model/editor.worker.ts')]);
  assert.deepEqual(r.messages.filter((m) => m.severity === 2), []);
});

test('에디터 코드에 eval·new Function·문자열 타이머가 없고 뿌리 ESLint가 apps/partner에 그 규칙을 건다 [ASVS v5.0.0-1.3.2]', async () => {
  assert.deepEqual(await rules('export const f = (s: string) => eval(s);\n', PAGE), ['no-eval']);
  assert.deepEqual(await rules("export const f = () => new Function('return 1');\n", PAGE), ['no-new-func']);
  assert.deepEqual(await rules("export const f = () => setTimeout('alert(1)', 10);\n", HOME), ['no-implied-eval']);
  assert.deepEqual(await rules('export const f = () => setTimeout(() => 1, 10);\n', PAGE), []);
  // 에디터 폴더·캔버스 폴더의 실제 파일이 그 규칙에 걸리지 않는다
  const files = ['apps/partner/src/_pages/seatmap-editor', 'apps/partner/src/widgets/seatmap-canvas'].map((d) => join(ROOT, d));
  const results = await eslint.lintFiles(files);
  const hits = results.flatMap((r) => r.messages.filter((m) => ['no-eval', 'no-implied-eval', 'no-new-func'].includes(m.ruleId)).map((m) => `${r.filePath}:${m.line}`));
  assert.deepEqual(hits, []);
});

/** 파트너 Trusted Types 보고 머리(docs/frontend.md §5.14.1 'Trusted Types' 붙인 곳: 실제로 만드는 이름 peaket peaket-paste nextjs default, ADR-0360 결정 7) */
const PARTNER_TT_REPORT_ONLY = "require-trusted-types-for 'script'; trusted-types peaket peaket-paste nextjs default; report-to csp";

/** Next.js가 proxy matcher를 그 주소에 거는가(Next.js 시험 도구, 서버 내부 저장소가 AsyncLocalStorage 전역을 찾는다) */
async function proxyMatches(config, url) {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
  const { unstable_doesMiddlewareMatch } = await import('next/experimental/testing/server.js');
  return unstable_doesMiddlewareMatch({ config, url });
}

test('F-03-1 T11 파트너 proxy는 위저드·에디터 밖 화면 경로까지 걸리고 정적 자산·/_next·보고 받는 곳·기본 정책 파일에는 걸리지 않는다(OPS-340, frontend §5.14.1 붙인 곳)', async () => {
  const { config } = await import('../../../proxy.ts');
  const pages = ['/', '/login', '/events', '/events/new', '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01/seatmap', '/settlements', '/sitemap', '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01/json'];
  for (const url of pages) assert.equal(await proxyMatches(config, url), true, `${url}에 화면 보안 헤더가 걸리지 않는다`);
  const assets = ['/_next/static/chunks/app-1a2b.js', '/_next/image', '/_t/csp', '/trusted-types-default.js', '/favicon.ico', '/robots.txt', '/fonts/a.woff2'];
  for (const url of assets) assert.equal(await proxyMatches(config, url), false, `${url}에 화면 proxy가 걸린다`);
});

test('F-03-1 T10 FE-T41 좁은 기본 정책 파일은 무결성 값과 같고, 같은 출처 /_next/static/ 아래 .js 주소만 통과시키며 HTML·문자열 스크립트 규칙을 만들지 않는다(ADR-0360 결정 7)', async () => {
  const { createHash } = await import('node:crypto');
  const { runInNewContext } = await import('node:vm');
  const { TRUSTED_TYPES_DEFAULT_SRC, TRUSTED_TYPES_DEFAULT_SRI } = await import('../../shared/config/security.ts');
  assert.equal(TRUSTED_TYPES_DEFAULT_SRC, '/trusted-types-default.js');
  const source = readFileSync(join(ROOT, 'apps/partner/public/trusted-types-default.js'));
  assert.equal(TRUSTED_TYPES_DEFAULT_SRI, `sha384-${createHash('sha384').update(source).digest('base64')}`, '무결성 값이 파일과 다르다(파일을 고치면 다시 잰다)');
  const made = [];
  const trustedTypes = { defaultPolicy: null, createPolicy: (name, rules) => made.push({ name, rules }) };
  runInNewContext(source.toString('utf8'), { window: { trustedTypes }, location: { origin: 'https://partner.peaket.example' }, URL });
  assert.deepEqual(
    made.map((p) => [p.name, Object.keys(p.rules).sort()]),
    [['default', ['createScriptURL']]],
  );
  const pass = made[0].rules.createScriptURL;
  for (const ok of ['/_next/static/chunks/a1.js', 'https://partner.peaket.example/_next/static/chunks/b.js']) assert.equal(pass(ok), ok, ok);
  for (const bad of ['https://evil.example/_next/static/chunks/a.js', '/_next/static/chunks/a.css', '/static/a.js', '/_next/image?url=a.js', 'data:text/javascript,alert(1)', 'javascript:alert(1)', '/_next/static/../x.js?.js'])
    assert.equal(pass(bad), null, bad);
  // 이미 기본 정책이 있으면 만들지 않는다
  const again = [];
  runInNewContext(source.toString('utf8'), { window: { trustedTypes: { defaultPolicy: {}, createPolicy: (n) => again.push(n) } }, location: { origin: 'https://partner.peaket.example' }, URL });
  assert.deepEqual(again, []);
});

test('F-03-1 T11 위저드 밖 화면도 묶음 B 파트너 CSP·PAGE_HEADERS.partner·Trusted Types 이름 목록 보고 머리를 단다', async () => {
  const { NextRequest } = await import('next/server.js');
  const { proxy } = await import('../../../proxy.ts');
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    for (const path of ['/', '/settlements', '/events/new']) {
      const res = proxy(new NextRequest(`http://localhost${path}`));
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]{24}' 'strict-dynamic'/, path);
      assert.match(csp, /object-src 'none'/, path);
      assert.match(csp, /frame-ancestors 'none'/, path);
      assert.match(csp, /report-to csp/, path);
      assert.equal(res.headers.get('content-security-policy-report-only'), PARTNER_TT_REPORT_ONLY, path);
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
      assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin', path);
      assert.ok(res.headers.get('permissions-policy'), `${path}: Permissions-Policy`);
      assert.equal(res.headers.get('cache-control'), 'private, no-store', path);
      // 루트 레이아웃이 기본 정책 스크립트에 붙일 nonce를 요청 머리로 넘긴다(응답 CSP의 nonce와 같다)
      assert.equal(res.headers.get('x-middleware-request-x-nonce'), csp.match(/nonce-([^']+)/)[1], `${path}: 요청 nonce`);
    }
  } finally {
    process.env.NODE_ENV = before;
  }
});

test('에디터 경로 응답이 묶음 B 파트너 CSP(nonce, worker-src \'self\', object-src \'none\')와 Trusted Types 보고 머리를 단다 [ASVS v5.0.0-3.4.3]', async () => {
  const { NextRequest } = await import('next/server.js');
  const { config, proxy } = await import('../../../proxy.ts');
  // F-03-1(OPS-340): matcher는 두 경로에서 모든 화면 경로로 넓어졌다(위 T11 시험)
  assert.equal(await proxyMatches(config, '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01/seatmap'), true);
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = proxy(new NextRequest('http://localhost/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01/seatmap'));
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]{24}' 'strict-dynamic'/);
    assert.match(csp, /worker-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /connect-src 'self' https:\/\/partner-api\.peaket\.example/);
    assert.equal(res.headers.get('content-security-policy-report-only'), PARTNER_TT_REPORT_ONLY);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.ok(res.headers.get('reporting-endpoints').includes('csp='));
    // 요청마다 nonce가 다르다
    const again = proxy(new NextRequest('http://localhost/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01/seatmap')).headers.get('content-security-policy');
    assert.notEqual(again.match(/nonce-([^']+)/)[1], csp.match(/nonce-([^']+)/)[1]);
  } finally {
    process.env.NODE_ENV = before;
  }
});
