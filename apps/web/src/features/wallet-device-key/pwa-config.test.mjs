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
/** 주석을 뺀 소스(설명 글의 이름에 속지 않게) */
const swCode = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

// BAT-170 웨이브 7(T7·T8, docs/frontend.md §5.4 '갱신' ①⑤): 경로·no-store·메시지 규칙은 sw-rules.ts에 두고 sw.ts가 그것을 쓴다.
// 규칙 자체는 sw-rules.test.mjs가, 실제 브라우저 동작은 tools/web-checks/reflow/wallet-sw.spec.mjs가 본다.
test('서비스 워커는 API·자기 자신을 캐시하지 않고 /my/tickets 셸을 StaleWhileRevalidate로 둔다', () => {
  const sw = read('app/sw.ts');
  assert.match(sw, /from '@\/features\/wallet-device-key\/sw-rules'|from '\.\.\/src\/features\/wallet-device-key\/sw-rules(?:\.ts)?'/);
  assert.match(sw, /isNetworkOnlyPath\(url\.pathname\)/);
  assert.match(sw, /new NetworkOnly\(\)/);
  assert.match(sw, /isWalletDocumentPath\(url\.pathname\)/);
  assert.doesNotMatch(sw, /url\.pathname\.startsWith\('\/my\/tickets'\)/);
  // 런타임 캐시 이름은 판을 붙인 `wallet-shell-{판}`(docs/frontend.md §5.4 런타임 캐시 판·§3.12, ADR-0336 결정 5). 판 없는 옛 이름 글자는 쓰지 않는다(BAT-350 고침)
  assert.match(sw, /new StaleWhileRevalidate\(\{ cacheName: WALLET_CACHE, plugins: \[[^\]]*\brejectNoStore\b/);
  assert.match(sw, /const WALLET_CACHE = walletCacheName\(/);
  assert.doesNotMatch(swCode(sw), /'wallet-pages'|'wallet-assets'/);
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

// ADR-0363 결정 5·6(F-05-1 시험 이의): 워커 주소는 /my/tickets/sw.js이고 처리기는 src/_app/workers/wallet-worker-route.ts다. 옛 경로 /serwist/*는 없앴다
test('HOT-390 FE-T14 월렛 워커 경로 /my/tickets/sw.js는 빌드 때 묶은 파일만 읽고 요청 때 다시 묶지 않으며 Service-Worker-Allowed: /my/tickets·no-cache를 준다 [ASVS v5.0.0-3.5.4]', () => {
  assert.equal(existsSync(join(appRoot, 'app/serwist')), false, '옛 워커 경로 /serwist/*가 남았다');
  assert.match(read('app/my/tickets/sw.js/route.ts'), /export \{ GET \} from '@\/_app\/workers\/wallet-worker-route'/);
  const route = read('src/_app/workers/wallet-worker-route.ts');
  // 요청 때 app/sw.ts를 다시 묶는 길이 없다(standalone 폴더에는 원본이 없다, BAT-171 시험 이의 6)
  const code = route.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /@serwist\/turbopack|createSerwistRoute|esbuild/, '경로 처리기가 요청 때 워커를 묶는다');
  assert.match(route, /from '(?:\.\.\/)+scripts\/service-worker\.mjs'/, '경로 처리기가 빌드 때 쓴 워커 폴더·파일 이름을 같은 모듈에서 읽지 않는다');
  assert.match(route, /\bSW_DIR\b/);
  assert.match(route, /'use cache'/);
  assert.match(route, /Service-Worker-Allowed': '\/my\/tickets'/);
  assert.match(route, /'Cache-Control': 'no-cache'/);
});

test('오프라인 대체 화면이 있고 서비스 워커 범위는 /my/tickets이며 루트 문서에는 없다', () => {
  assert.ok(existsSync(join(appRoot, 'app/(cached)/~offline/page.tsx')));
  assert.match(read('app/(cached)/~offline/page.tsx'), /인터넷에 연결되어 있지 않습니다/);
  const root = read('src/_app/layouts/RootDocument.tsx');
  assert.doesNotMatch(root, /SerwistProvider|swUrl=/);
  const pwa = read('src/features/wallet-device-key/ui/OfflineBanner.tsx');
  assert.match(pwa, /import\('@serwist\/turbopack\/react'\)/);
  // 등록 주소·범위는 sw-rules의 값(ADR-0363 결정 5). 값 자체는 sw-rules.test.mjs가 정본 글과 견준다
  assert.match(pwa, /swUrl=\{WALLET_SW_URL\}/);
  assert.match(pwa, /options=\{\{ scope: WALLET_SW_SCOPE \}\}/);
  assert.match(pwa, /process\.env\.NODE_ENV === 'development'/);
  assert.match(read('src/widgets/ticket-wallet/ui/Wallet.tsx'), /<OfflineBannerLazy /);
});

// ---------- 런타임 캐시 판(BAT-350, O-T46, docs/frontend.md §5.4 '갱신'의 런타임 캐시 판, ADR-0336 결정 5) ----------
// 빌드 설정(scripts/service-worker.mjs)이 내놓는 값을 바깥 경계로 보고, 워커 소스가 그 값을 실제로 쓰는지(부르는 쪽)는 소스로 본다.
// 판 이름 `__WALLET_CACHE_VERSION__`은 BAT-350 계획 §6(구현 담당이 정한 것)의 이름이다. 실제 워커 묶음의 동작은 web/reflow(월렛 워커 세 엔진)가 본다.

test('O-T46 ① 런타임 캐시는 판을 붙인 이름 하나이고 미리 저장 판과 같다', async () => {
  const { serwistOptions } = await import('../../../scripts/service-worker.mjs');
  const { walletCacheName } = await import('./sw-rules.ts');
  // 판 9와 10으로 빌드한 두 워커: 런타임 캐시 판 = 같은 빌드의 미리 저장 판
  for (const v of ['9', '10']) {
    const o = serwistOptions({ PEAKET_DEPLOYMENT_ID: v, GITHUB_SHA: 'sha-other' });
    assert.deepEqual([...new Set(o.additionalPrecacheEntries.map((e) => e.revision))], [v], `판 ${v}: 미리 저장 판`);
    assert.deepEqual(Object.keys(o.esbuildOptions.define), ['__WALLET_CACHE_VERSION__'], `판 ${v}: 워커에 넣는 값은 판 하나`);
    const built = JSON.parse(o.esbuildOptions.define.__WALLET_CACHE_VERSION__);
    assert.equal(built, v);
    assert.equal(walletCacheName(built), `wallet-shell-${v}`);
  }
  // 배포 식별자가 없으면 커밋, 그것도 없으면 개발 값(wallet-dev). 어느 때든 두 판은 같은 값이다
  for (const [env, v] of [
    [{ GITHUB_SHA: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c' }, '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c'],
    [{}, 'wallet-dev'],
  ]) {
    const o = serwistOptions(env);
    assert.deepEqual([...new Set(o.additionalPrecacheEntries.map((e) => e.revision))], [v]);
    assert.equal(JSON.parse(o.esbuildOptions.define.__WALLET_CACHE_VERSION__), v);
  }

  // 워커 소스: 문서 규칙과 자산 규칙이 같은 이름 하나를 쓰고, 그 이름은 빌드 때 넣은 판으로 만든다
  const code = swCode(read('app/sw.ts'));
  const names = [...code.matchAll(/cacheName:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.deepEqual(names, ['WALLET_CACHE', 'WALLET_CACHE'], '런타임 규칙 둘이 이름 하나를 함께 쓴다');
  const versionVar = /const WALLET_CACHE = walletCacheName\(([A-Za-z_$][\w$]*)\)/.exec(code)?.[1];
  assert.ok(versionVar, '런타임 캐시 이름을 walletCacheName(판)으로 만든다');
  assert.match(code, new RegExp(`const ${versionVar} = __WALLET_CACHE_VERSION__;`));
  assert.match(code, /declare const __WALLET_CACHE_VERSION__: string;/);
  // 활성화 때 옛 판 캐시를 정리한 뒤(같은 판으로) clients.claim()을 부른다
  const activate = code.slice(code.indexOf("addEventListener('activate'"));
  assert.ok(activate.length > 0 && code.includes("addEventListener('activate'"), 'activate 처리기가 있다');
  const rotateAt = activate.indexOf('rotateWalletCaches(');
  const claimAt = activate.indexOf('self.clients.claim()');
  assert.ok(rotateAt > 0, 'activate에서 rotateWalletCaches를 부른다');
  assert.ok(claimAt > rotateAt, 'clients.claim()은 정리 뒤다');
  assert.match(activate.slice(rotateAt, claimAt), new RegExp(`version: ${versionVar}\\b`));
});

test('O-T46 ④ 판 값이 꼴을 벗어나면 워커 빌드 설정이 던진다', async () => {
  const { serwistOptions, swRevision, writeServiceWorker } = await import('../../../scripts/service-worker.mjs');
  // §5.18 빌드 칸 꼴 [A-Za-z0-9_-]{1,64}
  assert.equal(swRevision({ PEAKET_DEPLOYMENT_ID: 'a'.repeat(64) }), 'a'.repeat(64));
  assert.equal(swRevision({ PEAKET_DEPLOYMENT_ID: 'Deploy_10-x' }), 'Deploy_10-x');
  for (const bad of ['a'.repeat(65), 'a/b', ' ', 'v1.2', 'é', 'deploy 10']) {
    assert.throws(() => swRevision({ PEAKET_DEPLOYMENT_ID: bad }), Error, `배포 식별자 ${JSON.stringify(bad)}`);
    assert.throws(() => serwistOptions({ PEAKET_DEPLOYMENT_ID: bad }), Error, `배포 식별자 ${JSON.stringify(bad)}`);
    assert.throws(() => swRevision({ GITHUB_SHA: bad }), Error, `커밋 ${JSON.stringify(bad)}`);
  }
  // 빌드 단계(next.config.ts의 runAfterProductionCompile → writeServiceWorker)가 실제로 멈추고 워커 파일을 쓰지 않는다
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const distDir = mkdtempSync(join(tmpdir(), 'bat350-sw-'));
  // 다른 까닭(모듈 불러오기 실패 등)으로 던진 것을 통과로 세지 않게, 판 확인이 던지는 바로 그 오류인지 본다
  const expected = (() => {
    try {
      serwistOptions({ PEAKET_DEPLOYMENT_ID: 'a/b' });
    } catch (e) {
      return e.message;
    }
    return undefined;
  })();
  assert.equal(typeof expected, 'string');
  const saved = process.env.PEAKET_DEPLOYMENT_ID;
  process.env.PEAKET_DEPLOYMENT_ID = 'a/b';
  try {
    await assert.rejects(writeServiceWorker({ distDir }), (e) => e instanceof Error && e.message === expected);
    assert.equal(existsSync(join(distDir, 'serwist', 'sw.js')), false);
  } finally {
    if (saved === undefined) delete process.env.PEAKET_DEPLOYMENT_ID;
    else process.env.PEAKET_DEPLOYMENT_ID = saved;
    rmSync(distDir, { recursive: true, force: true });
  }
});
