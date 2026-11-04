// 정적 자산 올리기 목록·소스 맵 링크·SBOM 시험(docs/frontend.md §5.18·§5.14.5, FE-T21, BUILD_ORDER BAS-220)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_EXTENSIONS, bundledPackages, cycloneDx, planUpload } from './assets.mjs';
import { repoRoot } from '../lib/canon.mjs';

const md = readFileSync(join(repoRoot, 'docs/frontend.md'), 'utf8');

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-static-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

test('[ASVS v5.0.0-13.4.7] 허용 확장자 목록이 정본 §5.18과 같다', () => {
  const line = md.split(/\r?\n/).find((l) => l.startsWith('- **정적 업로드 허용 확장자**'));
  const canon = [...line.split('.')[0].matchAll(/`([a-z0-9]+)`/g)].map((m) => m[1]);
  assert.deepEqual(ALLOWED_EXTENSIONS, canon);
});

test('[ASVS v5.0.0-13.4.7] [ASVS v5.0.0-13.4.1] 허용 확장자만 올리고 .map·.env·.git·그 밖 확장자는 까닭과 함께 뺀다', () => {
  const dir = fixture({
    'index.html': '<script src="/a.js"></script>',
    'assets/a.js': 'console.log(1)',
    'assets/a.js.map': '{"version":3,"sources":[]}',
    'assets/f.woff2': 'x',
    '.env': 'SECRET=1',
    '.git/config': '[core]',
    'notes.txt': 'x',
  });
  try {
    const plan = planUpload(dir);
    assert.deepEqual(plan.upload.map((f) => f.path), ['assets/a.js', 'assets/f.woff2', 'index.html']);
    assert.deepEqual(plan.excluded.map((f) => f.path).sort(), ['.env', '.git/config', 'assets/a.js.map', 'notes.txt']);
    assert.match(plan.excluded.find((f) => f.path === 'assets/a.js.map').reason, /소스 맵/);
    assert.deepEqual(plan.errors, []);
    assert.match(plan.upload[0].sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FE-T21 올릴 JS·CSS에 소스 맵 링크가 있으면 오류다', () => {
  const dir = fixture({ 'a.js': 'x()\n//# sourceMappingURL=a.js.map', 'b.css': 'a{}\n/*# sourceMappingURL=b.css.map */', 'c.js': 'ok()' });
  try {
    const plan = planUpload(dir);
    assert.equal(plan.errors.length, 2);
    assert.match(plan.errors[0], /a\.js: 소스 맵 링크/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('[ASVS v5.0.0-15.1.2] 숨김 소스 맵의 원본 경로에서 묶음에 든 패키지(pnpm 저장 경로·작업 공간 패키지)를 읽어 CycloneDX로 낸다', () => {
  const map = {
    version: 3,
    sources: [
      '../../../node_modules/.pnpm/react-dom@19.3.1_react@19.3.1/node_modules/react-dom/cjs/react-dom.production.js',
      '../../../node_modules/.pnpm/@seed-design+css@3.1.0/node_modules/@seed-design/css/base.css',
      'D:/repo/node_modules/.pnpm/react@19.3.1/node_modules/react/index.js',
      '../../../packages/telemetry/src/lite.ts',
      '../src/main.ts',
    ],
  };
  const dir = fixture({ 'assets/a.js.map': JSON.stringify(map) });
  try {
    const pkgs = bundledPackages(dir, repoRoot);
    assert.deepEqual(pkgs.map((p) => `${p.name}@${p.version}`), ['@peaket/telemetry@0.0.0', '@seed-design/css@3.1.0', 'react@19.3.1', 'react-dom@19.3.1']);
    const bom = cycloneDx({ app: 'console', packages: pkgs, external: ['https://cdn.portone.io'], upload: [] });
    assert.equal(bom.bomFormat, 'CycloneDX');
    assert.equal(bom.specVersion, '1.6');
    assert.equal(bom.components.find((c) => c.name === 'react-dom').purl, 'pkg:npm/react-dom@19.3.1');
    assert.equal(bom.components.find((c) => c.name === '@seed-design/css').purl, 'pkg:npm/%40seed-design/css@3.1.0');
    assert.equal(bom.components.find((c) => c.name === '@peaket/telemetry').purl, undefined);
    assert.deepEqual(bom.metadata.properties.find((p) => p.name === 'peaket:external-script'), { name: 'peaket:external-script', value: 'https://cdn.portone.io' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
