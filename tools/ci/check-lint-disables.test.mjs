// check-lint-disables.mjs 시험(docs/devops.md §4.4 '보안 린트' ①, ADR-0259 결정 12, 리뷰 R7 ①). 실행: node --test "tools/ci/*.test.mjs"
// 임시 저장소에 실제 보안 규칙 설정(packages/config/eslint)을 거는 eslint.config.mjs와 고정 사례 파일을 두고 명령줄로 돌린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { tempDir } from './git-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'check-lint-disables.mjs');
const REPO = resolve(here, '..', '..');
const mod = await import('./check-lint-disables.mjs');

test('보안 린트 끄기 주석을 읽는다: 줄·다음 줄·블록·줄 안 설정, 규칙 이름 없는 것은 모든 규칙', () => {
  const { parseDirective, touchesSecurity } = mod;
  const cases = [
    ['// eslint-disable-line peaket-web/no-html-injection', true],
    ['// eslint-disable-next-line peaket-service/no-direct-outbound-http -- 까닭', true],
    ['/* eslint-disable peaket-web/no-window-message */', true],
    ['/* eslint-disable react-hooks/exhaustive-deps, peaket-service/route-response-schema */', true],
    ['/* eslint-disable */', true],
    ['/* eslint-disable-line */', true],
    ['// eslint-disable-next-line', true],
    ['// eslint-disable-next-line -- 까닭만', true],
    ['/* eslint peaket-web/no-html-injection: "off" */', true],
    ['/* eslint peaket-service/route-response-schema: ["error", { "baseline": ["x"] }] */', true],
    ['// eslint-disable-next-line react-hooks/exhaustive-deps', false],
    ["{/* eslint-disable-next-line jsx-a11y/no-autofocus -- '새 이름'을 누른 뒤 */}".slice(1, -1), false],
    ['/* eslint-enable */', false],
    ['/* eslint-env node */', false],
    ['/* global fetch */', false],
    ['/* eslint no-console: "off" */', false],
  ];
  for (const [text, expected] of cases) {
    const d = parseDirective(text);
    assert.ok(d, `주석으로 읽어야 한다: ${text}`);
    assert.equal(touchesSecurity(d, { securityFile: true }), expected, text);
  }
  assert.deepEqual(parseDirective('/* eslint-disable */').rules, null);
  assert.deepEqual(parseDirective('// eslint-disable-line a/b, c -- 까닭').rules, ['a/b', 'c']);
  // 모든 규칙을 끄는 주석은 보안 규칙이 걸린 파일에서만 막는다(걸리지 않은 파일에서는 끌 보안 규칙이 없다)
  assert.equal(touchesSecurity(parseDirective('/* eslint-disable */'), { securityFile: false }), false);
  assert.equal(touchesSecurity(parseDirective('/* eslint-disable peaket-web/no-html-injection */'), { securityFile: false }), true);
  assert.deepEqual(mod.lintPaths('eslint --no-error-on-unmatched-pattern services apps packages/ds/src'), ['services', 'apps', 'packages/ds/src']);
  assert.throws(() => mod.lintPaths('turbo run lint'), /eslint/);
});

const configUrl = (f) => pathToFileURL(join(REPO, 'packages/config/eslint', f)).href;
const ESLINT_CONFIG = `import { webSecurityConfigs } from '${configUrl('web-security.mjs')}';
import { serviceSecurityConfigs } from '${configUrl('service-security.mjs')}';
export default [
  { ignores: ['**/node_modules/**'] },
  ...serviceSecurityConfigs(['services/*/src'], { baseline: [], exceptions: [] }),
  ...webSecurityConfigs(['apps/**/src/**/*.{ts,tsx}']),
];
`;
const HTML = 'export const A = (p: { h: string }) => <div dangerouslySetInnerHTML={{ __html: p.h }} />;';
function fixture(files, exceptions = []) {
  const root = tempDir('lint-disables-');
  const all = {
    'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: { lint: 'eslint --no-error-on-unmatched-pattern services apps' } }),
    'eslint.config.mjs': ESLINT_CONFIG,
    'exceptions.json': JSON.stringify({ exceptions }),
    ...files,
  };
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}
async function run(root) {
  try {
    const r = await promisify(execFile)(process.execPath, [script, '--root', root, '--exceptions', join(root, 'exceptions.json')], { encoding: 'utf8', cwd: REPO });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    return { code: e.code, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('[ASVS v5.0.0-3.2.2] 보안 규칙을 줄 안 주석으로 끄면 막고, 주석을 무시한 채 보안 규칙을 다시 돌린다', { timeout: 120_000 }, async () => {
  const bad = {
    'apps/web/src/a.tsx': `// eslint-disable-next-line peaket-web/no-html-injection\n${HTML}\n`,
    'apps/web/src/b.ts': 'export function f(el: HTMLElement, h: string) { el.innerHTML = h; } // eslint-disable-line peaket-web/no-html-injection -- 까닭\n',
    'apps/web/src/c.ts': "/* eslint-disable peaket-web/no-window-message */\nwindow.addEventListener('message', () => {});\n",
    'apps/web/src/d.ts': '/* eslint-disable */\nexport const x = 1;\n',
    'apps/web/src/e.ts': '// eslint-disable-next-line\nexport const y = 1;\n',
    'apps/web/src/f.ts': '/* eslint peaket-web/no-html-injection: "off" */\nexport const z = 1;\n',
    'services/demo/src/g.ts': '// eslint-disable-next-line peaket-service/no-direct-outbound-http\nexport const f = (u: string) => fetch(u);\n',
    'services/demo/src/h.ts': '/* eslint-disable no-console, peaket-service/route-response-schema */\nexport const w = 1;\n',
  };
  const ok = {
    'apps/web/src/ok.ts': '// eslint-disable-next-line no-console -- 시험\nexport const ok = 1;\n/* eslint-enable */\n',
    // 린트 범위 밖: 시험 파일은 화면 보안 규칙이 보지 않는다
    'apps/web/src/x.test.ts': '/* eslint-disable */\nexport const t = 1;\n',
  };
  const r = await run(fixture({ ...bad, ...ok }));
  assert.equal(r.code, 1, r.out);
  for (const f of Object.keys(bad)) assert.match(r.out, new RegExp(`${f.replaceAll('.', '\\.')}:\\d+`), `${f}를 알려야 한다\n${r.out}`);
  assert.doesNotMatch(r.out, /ok\.ts|x\.test\.ts/);
  // 주석이 숨긴 보안 규칙 위반도 알린다(주석을 무시하고 다시 돌린 결과)
  assert.match(r.out, /a\.tsx:2 .*peaket-web\/no-html-injection/);
  assert.match(r.out, /g\.ts:2 .*peaket-service\/no-direct-outbound-http/);
});

test('[ASVS v5.0.0-3.2.2] 이름을 단 예외의 주석만 넘기고, 예외 파일 안의 보안 위반과 쓰이지 않는 예외는 막는다', { timeout: 120_000 }, async () => {
  const reason = '시험: 디자인 캔버스에서 옮긴 보드';
  const clean = fixture({ 'apps/web/src/board.tsx': '// 옮긴 것\n/* eslint-disable */\nexport const B = () => <p>보드</p>;\n' }, [{ directive: '/* eslint-disable */', reason, files: ['apps/web/src/board.tsx'] }]);
  const ok = await run(clean);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /예외 1/);
  const hidden = fixture({ 'apps/web/src/board.tsx': `/* eslint-disable */\n${HTML}\n` }, [{ directive: '/* eslint-disable */', reason, files: ['apps/web/src/board.tsx'] }]);
  const h = await run(hidden);
  assert.equal(h.code, 1, h.out);
  assert.match(h.out, /board\.tsx:2 .*peaket-web\/no-html-injection/);
  const unused = fixture({ 'apps/web/src/ok.ts': 'export const ok = 1;\n' }, [{ directive: '/* eslint-disable */', reason, files: ['apps/web/src/gone.tsx'] }]);
  const u = await run(unused);
  assert.equal(u.code, 1, u.out);
  assert.match(u.out, /쓰이지 않는 예외.*gone\.tsx/);
  // 까닭 없는 예외는 막는다
  const noReason = fixture({}, [{ directive: '/* eslint-disable */', reason: '', files: ['apps/web/src/board.tsx'] }]);
  assert.equal((await run(noReason)).code, 1);
});

test('저장소의 예외 목록은 형식이 맞고 적은 파일이 있다', () => {
  const j = JSON.parse(readFileSync(join(here, 'lint-disable-exceptions.json'), 'utf8'));
  assert.ok(Array.isArray(j.exceptions));
  for (const e of j.exceptions) {
    assert.ok(e.reason.trim().length > 0 && typeof e.directive === 'string' && e.files.length > 0);
    for (const f of e.files) assert.ok(existsSync(join(REPO, f)), f);
  }
  // 범위는 뿌리 package.json의 lint 경로와 같다
  const lint = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts.lint;
  assert.deepEqual(mod.lintPaths(lint), lint.split(/\s+/).filter((t) => t !== 'eslint' && !t.startsWith('-')));
});

const YAML = await import('yaml').catch(() => null);
test('ci.yml의 lint-guard 잡이 이 검사를 부르고 필수 검사(ci-summary)가 기다린다', { skip: !YAML && 'yaml이 설치되지 않음(pnpm install 전)' }, () => {
  const ci = YAML.parse(readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8'));
  const job = ci.jobs['lint-guard'];
  assert.ok(job.steps.some((s) => /^node tools\/ci\/check-lint-disables\.mjs\b/.test(s.run ?? '')));
  assert.ok(job.steps.some((s) => /pnpm install --frozen-lockfile/.test(s.run ?? '')));
  assert.ok(job.steps.every((s) => s['continue-on-error'] !== true));
  assert.match(job.if, /needs\.changes\.outputs\.js == 'true'/);
  assert.ok([ci.jobs['ci-summary'].needs].flat().includes('lint-guard'));
});

// ---------- 다시 보기 S2(2026-11-10) 재현 시험 ----------
// 2026-11-10 이름을 단 예외(디자인 캔버스 보드의 /* eslint-disable */ 54곳). 예외 목록은 이것의 부분집합이어야 한다(줄이 늘지 않는다)
const BOARD_PAGES = ['accounts', 'audit', 'bot-review', 'cancellation', 'commands', 'compliance', 'cs-approvals', 'cs-inbox', 'customers', 'dashboard', 'login', 'notices', 'partners', 'sale-review', 'scanner-devices', 'settlements', 'system'];
const FROZEN_EXCEPTIONS = new Set(
  [...BOARD_PAGES.map((p) => `apps/console-host/src/pages/${p}/ui/board-`), 'apps/forensics/src/screen/board-'].flatMap((base) => ['d', 'm', 't'].map((k) => `/* eslint-disable */|${base}${k}.tsx`)),
);
test('[ASVS v5.0.0-3.2.2] 이름을 단 예외 목록은 2026-11-10 목록(54곳)의 부분집합이다(새 파일·새 주석을 더하지 못한다)', () => {
  assert.equal(FROZEN_EXCEPTIONS.size, 54);
  const j = JSON.parse(readFileSync(join(here, 'lint-disable-exceptions.json'), 'utf8'));
  const lines = j.exceptions.flatMap((e) => e.files.map((f) => `${e.directive.replace(/\s+/g, ' ').trim()}|${f}`));
  assert.deepEqual(lines.filter((l) => !FROZEN_EXCEPTIONS.has(l)), [], '2026-11-10 목록에 없던 예외: 보안 규칙 예외는 규칙의 허용 목록(파일과 까닭)으로만 둔다');
  assert.equal(new Set(lines).size, lines.length, '겹치는 예외');
});
