// BAS-200 브랜드 자산 검사: 워드마크 심벌과 같은 도형의 파비콘·PWA 아이콘·설치 파일이 있는지 본다(d1 §3, wbs 0.6.3).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../../../', import.meta.url);
const at = (p) => new URL(p, root);
const text = (p) => readFileSync(at(p), 'utf8');

test('BAS-200 심벌 도형은 워드마크 CSS와 같은 티켓 절취선·봉우리다', () => {
  const symbol = text('packages/ds/src/assets/brand/peaket-symbol.svg');
  const kit = text('packages/ds/src/styles/kit.css');
  const shape = 'M3 15h7.5L16 5.5l5.5 9.5H29v3.5a2.5 2.5 0 0 0 0 5V27H3v-3.5a2.5 2.5 0 0 0 0-5z';
  assert.ok(symbol.includes(shape));
  assert.ok(kit.includes(encodeURIComponent(shape).replaceAll('%20', ' ')) || kit.includes(shape));
  assert.ok(symbol.includes('#4338CA'), '기본 심벌은 인디고');
  assert.ok(text('packages/ds/src/assets/brand/peaket-symbol-neg.svg').includes('fill="#fff"'), '반전 심벌이 있다');
});

test('BAS-200 파비콘·애플 터치 아이콘·PWA 아이콘이 있다', () => {
  for (const p of ['apps/web/app/icon.svg', 'apps/web/app/apple-icon.png', 'apps/web/public/favicon.ico', 'apps/web/public/icons/icon-192.png', 'apps/web/public/icons/icon-512.png', 'apps/web/public/icons/maskable-512.png']) {
    assert.ok(existsSync(at(p)), p);
  }
  // PNG 서명(89 50 4E 47)
  for (const p of ['apps/web/app/apple-icon.png', 'apps/web/public/icons/icon-192.png', 'apps/web/public/icons/icon-512.png', 'apps/web/public/icons/maskable-512.png']) {
    const b = readFileSync(at(p));
    assert.deepEqual([...b.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], p);
  }
  // ICO 서명(00 00 01 00)
  assert.deepEqual([...readFileSync(at('apps/web/public/favicon.ico')).subarray(0, 4)], [0, 0, 1, 0]);
});

test('BAS-200 소비자 웹 설치 파일은 이름·시작 주소·192/512·마스커블 아이콘을 갖춘다', () => {
  const m = JSON.parse(text('apps/web/public/manifest.webmanifest'));
  assert.equal(m.name, 'PEAKET(피켓)');
  assert.equal(m.short_name, 'PEAKET');
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#4338CA');
  assert.deepEqual(m.icons.map((i) => [i.src, i.sizes, i.purpose]), [
    ['/icons/icon-192.png', '192x192', 'any'],
    ['/icons/icon-512.png', '512x512', 'any'],
    ['/icons/maskable-512.png', '512x512', 'maskable'],
  ]);
  const layout = text('apps/web/src/_app/layouts/RootDocument.tsx');
  assert.ok(layout.includes("manifest: '/manifest.webmanifest'"));
  assert.ok(layout.includes("themeColor: '#4338CA'"));
});

test('BAS-200 스캐너 PWA도 같은 심벌의 아이콘과 설치 파일을 싣는다', () => {
  for (const p of ['apps/scanner/public/icon.svg', 'apps/scanner/public/icon-192.png', 'apps/scanner/public/icon-512.png', 'apps/scanner/public/manifest.webmanifest']) {
    assert.ok(existsSync(at(p)), p);
  }
  const m = JSON.parse(text('apps/scanner/public/manifest.webmanifest'));
  assert.equal(m.short_name, 'PEAKET 스캐너');
  assert.deepEqual(m.icons.map((i) => i.sizes), ['192x192', '512x512']);
  const html = text('apps/scanner/index.html');
  for (const needle of ['rel="manifest" href="/manifest.webmanifest"', 'href="/icon.svg"', 'href="/icon-192.png"', 'name="theme-color" content="#4338CA"']) assert.ok(html.includes(needle), needle);
});
