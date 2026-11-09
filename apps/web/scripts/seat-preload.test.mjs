// 좌석 화면 자산 목록(BUILD_ORDER HOT-352, ADR-0216 결정 3·5, docs/frontend.md §5.1): 대기실이 받는 모양과 규칙.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seatPreloadFrom, writeSeatPreload } from './seat-preload.mjs';
import { preloadAssets } from '../queue-room/src/live/preload.ts';

const ROUTE = '[project]/apps/web/app/(request)/booking/[eventId]/seats/page';

test('SCR-008 목록은 공통 런타임·좌석 경로의 JS와 CSS를 /_next/static/ 주소로 한 번씩 담는다', () => {
  const out = seatPreloadFrom({
    rootMainFiles: ['static/chunks/a.js', 'static/chunks/b.js'],
    entryJSFiles: { [ROUTE]: ['static/chunks/b.js', 'static/chunks/c.js'], other: ['static/chunks/x.js'] },
    entryCSSFiles: { [ROUTE]: [{ path: 'static/chunks/s.css', inlined: false }], other: [{ path: 'static/chunks/y.css', inlined: false }] },
  });
  assert.deepEqual(out, { v: 1, assets: ['/_next/static/chunks/a.js', '/_next/static/chunks/b.js', '/_next/static/chunks/c.js', '/_next/static/chunks/s.css'] });
  // 대기실의 검사가 모두 받는다
  assert.deepEqual(preloadAssets(out), out.assets);
});

test('SCR-008 HTML에 끼워 넣은 CSS와 js·css가 아닌 파일, static 밖 경로는 뺀다', () => {
  const out = seatPreloadFrom({
    rootMainFiles: ['static/chunks/a.js.map', '../secret.js', 'static/../x.js'],
    entryJSFiles: { [ROUTE]: ['static/media/f.woff2'] },
    entryCSSFiles: { [ROUTE]: [{ path: 'static/chunks/in.css', inlined: true }] },
  });
  assert.deepEqual(out, { v: 1, assets: [] });
});

test('SCR-008 좌석 경로를 매니페스트에서 찾지 못하면 빌드를 멈춘다(빈 목록을 조용히 내지 않는다)', () => {
  assert.throws(() => seatPreloadFrom({ rootMainFiles: [], entryJSFiles: {}, entryCSSFiles: {} }), /좌석 화면 경로/);
});

test('SCR-008 빌드 산출 폴더의 매니페스트에서 seat-preload.json을 쓴다', () => {
  const dist = mkdtempSync(join(tmpdir(), 'seat-preload-'));
  const dir = join(dist, 'server', 'app', '(request)', 'booking', '[eventId]', 'seats');
  mkdirSync(join(dir, 'page'), { recursive: true });
  writeFileSync(join(dir, 'page', 'build-manifest.json'), JSON.stringify({ rootMainFiles: ['static/chunks/a.js'] }));
  const manifest = { entryJSFiles: { [ROUTE]: ['static/chunks/c.js'] }, entryCSSFiles: { [ROUTE]: [{ path: 'static/chunks/s.css', inlined: false }] } };
  writeFileSync(join(dir, 'page_client-reference-manifest.js'), `globalThis.__RSC_MANIFEST = (globalThis.__RSC_MANIFEST || {});\nglobalThis.__RSC_MANIFEST["/(request)/booking/[eventId]/seats/page"] = ${JSON.stringify(manifest)};\n`);
  const r = writeSeatPreload({ distDir: dist });
  assert.equal(r.assets, 3);
  assert.deepEqual(JSON.parse(readFileSync(join(dist, 'seat-preload.json'), 'utf8')), { v: 1, assets: ['/_next/static/chunks/a.js', '/_next/static/chunks/c.js', '/_next/static/chunks/s.css'] });
});
