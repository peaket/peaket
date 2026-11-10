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
  assert.deepEqual(await rules("import Konva from 'konva';\nexport const k = Konva;\n", 'apps/partner/app/(console)/events/[id]/seatmap/page.tsx'), ['no-restricted-imports']);
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

test('에디터 경로 응답이 묶음 B 파트너 CSP(nonce, worker-src \'self\', object-src \'none\')와 Trusted Types 보고 머리를 단다 [ASVS v5.0.0-3.4.3]', async () => {
  const { NextRequest } = await import('next/server.js');
  const { config, proxy } = await import('../../../proxy.ts');
  assert.deepEqual(config.matcher, ['/events/new', '/events/:id/seatmap']);
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
    assert.equal(res.headers.get('content-security-policy-report-only'), "require-trusted-types-for 'script'; report-to csp");
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.ok(res.headers.get('reporting-endpoints').includes('csp='));
    // 요청마다 nonce가 다르다
    const again = proxy(new NextRequest('http://localhost/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01/seatmap')).headers.get('content-security-policy');
    assert.notEqual(again.match(/nonce-([^']+)/)[1], csp.match(/nonce-([^']+)/)[1]);
  } finally {
    process.env.NODE_ENV = before;
  }
});
