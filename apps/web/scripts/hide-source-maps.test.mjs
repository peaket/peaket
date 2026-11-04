// 숨김 소스 맵 시험(docs/frontend.md §5.18, BUILD_ORDER HOT-291). 실행: pnpm --filter @peaket/web test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hideSourceMaps } from './hide-source-maps.mjs';

const sri = (s) => `sha256-${createHash('sha256').update(s).digest('base64')}`;

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-maps-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

test('[ASVS v5.0.0-13.4.7] JS·CSS 끝 링크를 지우고 맵을 static 밖으로 옮기며, 지운 JS의 새 해시로 전체·화면별 SRI 표를 고친다', () => {
  const js = 'console.log(1)\n//# sourceMappingURL=a.js.map';
  const kept = 'console.log(2)\n';
  const css = 'a{}\n/*# sourceMappingURL=b.css.map */';
  const manifest = JSON.stringify({ 'static/chunks/a.js': sri(js), 'static/chunks/k.js': sri(kept), 'static/chunks/b.css': sri(css) });
  const dir = fixture({
    'static/chunks/a.js': js,
    'static/chunks/a.js.map': '{"version":3}',
    'static/chunks/k.js': kept,
    'static/chunks/b.css': css,
    'static/chunks/b.css.map': '{"version":3}',
    'server/subresource-integrity-manifest.json': manifest,
    'server/subresource-integrity-manifest.js': `self.__SUBRESOURCE_INTEGRITY_MANIFEST=${JSON.stringify(manifest)}`,
    'server/app/(cached)/page/subresource-integrity-manifest.json': manifest,
  });
  try {
    const r = hideSourceMaps({ distDir: dir });
    assert.deepEqual(r, { stripped: 2, maps: 2, manifests: 3 });
    const a = readFileSync(join(dir, 'static/chunks/a.js'), 'utf8');
    assert.equal(a, 'console.log(1)\n');
    assert.doesNotMatch(readFileSync(join(dir, 'static/chunks/b.css'), 'utf8'), /sourceMappingURL/);
    assert.equal(existsSync(join(dir, 'static/chunks/a.js.map')), false);
    assert.equal(existsSync(join(dir, 'browser-source-maps/chunks/a.js.map')), true);
    for (const m of ['server/subresource-integrity-manifest.json', 'server/app/(cached)/page/subresource-integrity-manifest.json']) {
      const j = JSON.parse(readFileSync(join(dir, m), 'utf8'));
      assert.equal(j['static/chunks/a.js'], sri(a), m);
      assert.equal(j['static/chunks/k.js'], sri(kept), '링크 없던 파일은 그대로');
      assert.equal(j['static/chunks/b.css'], sri(readFileSync(join(dir, 'static/chunks/b.css'))), 'CSS 항목도 지운 뒤 파일의 해시');
    }
    assert.ok(readFileSync(join(dir, 'server/subresource-integrity-manifest.js'), 'utf8').includes(sri(a)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('링크가 없으면 아무것도 고치지 않는다(맵을 켜지 않은 빌드)', () => {
  const dir = fixture({ 'static/chunks/a.js': 'x()\n', 'server/subresource-integrity-manifest.json': '{}' });
  try {
    assert.deepEqual(hideSourceMaps({ distDir: dir }), { stripped: 0, maps: 0, manifests: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
