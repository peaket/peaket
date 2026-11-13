// 월렛 PWA 배선 시험(BAT-350, offline-gate §2·§4, docs/frontend.md §2.3·§5.4).
// 서비스 워커가 API를 캐시하지 않고, /my/tickets 셸·~offline을 미리 저장하며, 범위가 /my/tickets인지 소스에서 확인한다.
// 실제 캐시 동작은 브라우저 확인(docs/review/browser-check/BAT-350.md)이 본다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path) => readFileSync(join(appRoot, path), 'utf8');

test('서비스 워커는 API·자기 자신을 캐시하지 않고 /my/tickets 셸을 StaleWhileRevalidate로 둔다', () => {
  const sw = read('app/sw.ts');
  assert.match(sw, /url\.pathname\.startsWith\('\/v1\/'\)/);
  assert.match(sw, /url\.pathname\.startsWith\('\/serwist\/'\)/);
  assert.match(sw, /new NetworkOnly\(\)/);
  assert.match(sw, /url\.pathname\.startsWith\('\/my\/tickets'\)/);
  assert.match(sw, /new StaleWhileRevalidate\(\{ cacheName: 'wallet-pages'/);
  assert.match(sw, /precacheEntries: self\.__SW_MANIFEST/);
  assert.match(sw, /url: '\/~offline'/);
  assert.doesNotMatch(sw, /NetworkFirst/);
});

test('Serwist 경로는 /~offline과 /my/tickets을 미리 저장하고 Service-Worker-Allowed를 준다', () => {
  const route = read('app/serwist/[path]/route.ts');
  assert.match(route, /additionalPrecacheEntries/);
  assert.match(route, /url: '\/~offline'/);
  assert.match(route, /url: '\/my\/tickets'/);
  assert.match(route, /'use cache'/);
  assert.match(route, /Service-Worker-Allowed': '\/my\/tickets'/);
  assert.match(route, /useNativeEsbuild: true/);
});

test('오프라인 대체 화면이 있고 서비스 워커 범위는 /my/tickets이며 루트 문서에는 없다', () => {
  assert.ok(existsSync(join(appRoot, 'app/(cached)/~offline/page.tsx')));
  assert.match(read('app/(cached)/~offline/page.tsx'), /인터넷에 연결되어 있지 않습니다/);
  const root = read('src/_app/layouts/RootDocument.tsx');
  assert.doesNotMatch(root, /SerwistProvider|swUrl=/);
  const pwa = read('src/features/wallet-device-key/ui/OfflineBanner.tsx');
  assert.match(pwa, /import\('@serwist\/turbopack\/react'\)/);
  assert.match(pwa, /swUrl="\/serwist\/sw\.js"/);
  assert.match(pwa, /options=\{\{ scope: '\/my\/tickets' \}\}/);
  assert.match(pwa, /process\.env\.NODE_ENV === 'development'/);
  assert.match(read('src/widgets/ticket-wallet/ui/Wallet.tsx'), /<OfflineBannerLazy /);
});
