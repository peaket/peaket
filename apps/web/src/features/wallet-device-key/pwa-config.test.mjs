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

// BAT-170 웨이브 7(T7·T8, docs/frontend.md §5.4 '갱신' ①⑤): 경로·no-store·메시지 규칙은 sw-rules.ts에 두고 sw.ts가 그것을 쓴다.
// 규칙 자체는 sw-rules.test.mjs가, 실제 브라우저 동작은 tools/web-checks/reflow/wallet-sw.spec.mjs가 본다.
test('서비스 워커는 API·자기 자신을 캐시하지 않고 /my/tickets 셸을 StaleWhileRevalidate로 둔다', () => {
  const sw = read('app/sw.ts');
  assert.match(sw, /from '@\/features\/wallet-device-key\/sw-rules'|from '\.\.\/src\/features\/wallet-device-key\/sw-rules(?:\.ts)?'/);
  assert.match(sw, /isNetworkOnlyPath\(url\.pathname\)/);
  assert.match(sw, /new NetworkOnly\(\)/);
  assert.match(sw, /isWalletDocumentPath\(url\.pathname\)/);
  assert.doesNotMatch(sw, /url\.pathname\.startsWith\('\/my\/tickets'\)/);
  assert.match(sw, /new StaleWhileRevalidate\(\{ cacheName: 'wallet-pages', plugins: \[[^\]]*\brejectNoStore\b/);
  assert.match(sw, /precacheEntries: self\.__SW_MANIFEST/);
  assert.match(sw, /url: '\/~offline'/);
  assert.doesNotMatch(sw, /NetworkFirst/);
});

test('HOT-390 월렛 워커는 스스로 활성화하지 않고 SKIP_WAITING 메시지를 받았을 때만 skipWaiting을 부른다', () => {
  const sw = read('app/sw.ts');
  assert.doesNotMatch(sw, /skipWaiting:\s*true/);
  assert.doesNotMatch(sw, /clientsClaim:\s*true/);
  assert.match(sw, /addEventListener\(\s*'message'/);
  assert.match(sw, /isSkipWaitingMessage\(/);
  assert.match(sw, /skipWaiting\(\)/);
});

test('HOT-390 회전 QR 부품은 화면에 붙어 있는 동안 QR 잠금을 쥔다(update-hold의 holdQrLock)', () => {
  const qr = read('src/features/wallet-device-key/ui/DeviceQr.tsx');
  assert.match(qr, /holdQrLock\(/);
  assert.match(qr, /useEffect\(/);
  const index = read('src/features/wallet-device-key/index.ts');
  assert.match(index, /from '\.\/update-hold'/);
});

// BAT-171 시험 이의 7(시험 담당 l2-bat171-test): 워커 묶기를 빌드 때(scripts/service-worker.mjs)로 옮겼다(이의 6, standalone 서버가 요청 때 다시 묶다 실패).
// 미리 저장 목록은 그 모듈이 내놓는 값을 바깥 경계로 보고(판 값은 상수와 다른 두 자리 값으로), 경로 처리기는 다시 묶지 않는지 소스로 본다
test('HOT-390 Serwist 워커는 빌드 때 /~offline과 /my/tickets을 그 배포 판으로 미리 저장하게 묶는다', async () => {
  const { serwistOptions, swRevision } = await import('../../../scripts/service-worker.mjs');
  const o = serwistOptions({ PEAKET_DEPLOYMENT_ID: 'deploy-10', GITHUB_SHA: 'sha-9' });
  assert.equal(o.swSrc, 'app/sw.ts');
  assert.equal(o.useNativeEsbuild, true);
  assert.deepEqual(o.additionalPrecacheEntries, [
    { url: '/~offline', revision: 'deploy-10' },
    { url: '/my/tickets', revision: 'deploy-10' },
  ]);
  // 판: 배포 ID > 커밋 > 개발 값
  assert.equal(swRevision({ PEAKET_DEPLOYMENT_ID: 'deploy-10', GITHUB_SHA: 'sha-9' }), 'deploy-10');
  assert.equal(swRevision({ GITHUB_SHA: 'sha-9' }), 'sha-9');
  assert.equal(swRevision({}), 'wallet-dev');
});

test('HOT-390 묶은 워커 글 끝의 소스 맵 링크 줄을 지운다(숨김 소스 맵, docs/frontend.md §5.18)', async () => {
  const { stripSourceMapLink } = await import('../../../scripts/service-worker.mjs');
  assert.equal(stripSourceMapLink('self.a=1;\n//# sourceMappingURL=sw.js.map\n'), 'self.a=1;\n');
  assert.equal(stripSourceMapLink('self.a=1;\n//# sourceMappingURL=sw.js.map'), 'self.a=1;\n');
  // 끝 줄이 아닌 같은 글은 건드리지 않는다
  assert.equal(stripSourceMapLink('// sourceMappingURL 설명\nself.a=1;'), '// sourceMappingURL 설명\nself.a=1;\n');
});

test('HOT-390 Serwist 경로는 빌드 때 묶은 파일만 읽고 요청 때 다시 묶지 않으며 Service-Worker-Allowed를 준다', () => {
  const route = read('app/serwist/[path]/route.ts');
  // 요청 때 app/sw.ts를 다시 묶는 길이 없다(standalone 폴더에는 원본이 없다, BAT-171 시험 이의 6)
  const code = route.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /@serwist\/turbopack|createSerwistRoute|esbuild/, '경로 처리기가 요청 때 워커를 묶는다');
  assert.match(route, /from '(?:\.\.\/)+scripts\/service-worker\.mjs'/, '경로 처리기가 빌드 때 쓴 워커 폴더·파일 이름을 같은 모듈에서 읽지 않는다');
  assert.match(route, /\bSW_DIR\b/);
  assert.match(route, /'use cache'/);
  assert.match(route, /Service-Worker-Allowed': '\/my\/tickets'/);
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
