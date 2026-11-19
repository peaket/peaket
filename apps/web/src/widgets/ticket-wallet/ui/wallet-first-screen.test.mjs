// BAT-177: 월렛 첫 화면이 QR 뼈대를 첫 HTML에 인라인하고, QR·오프라인(서비스 워커) 덩어리를 load 뒤로 미루는지
// 소스로 본다(docs/frontend.md §5.8, 계획 docs/review/plans/BAT-177.md 4·5의 T6).
// 화면을 띄우지 않고 서버 컴포넌트·클라이언트 컴포넌트의 경계와 정적 그림 참조를 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', '..', '..');
const webRoot = join(srcRoot, '..');
const read = (path) => readFileSync(path, 'utf8');

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** 앱 소스 파일(시험 파일은 뺀다). 기준 트리처럼 새 파일이 없어도 시험을 돌릴 수 있게 안에서 읽는다 */
const sourceFiles = () => [...walk(srcRoot)].filter((f) => /\.(?:tsx?|mjs|js)$/.test(f) && !/\.test\.(?:mjs|js|tsx?)$/.test(f));

test('BAT-177 T6 ① 월렛 첫 HTML은 QR 뼈대 data URI를 인라인하고 PNG preload·공개 경로 요청을 두지 않는다', () => {
  const myTickets = read(join(srcRoot, '_pages/my-tickets/ui/MyTicketsPage.tsx'));
  const wallet = read(join(here, 'Wallet.tsx'));
  // 첫 HTML을 그리는 서버 컴포넌트에 data URI 그림이 있다(클라이언트 조각이 아니다)
  assert.doesNotMatch(wallet, /^\s*['"]use client['"]/m, 'Wallet.tsx는 서버 컴포넌트다');
  assert.match(wallet, /<img\s+src=\{WALLET_QR_SKELETON\}/, 'fallback 그림이 첫 HTML data URI를 쓴다');
  assert.match(wallet, /className="[^"]*\bwallet-qr-skeleton\b[^"]*"/, '산출물에서 알아볼 수 있게 클래스를 단다');
  assert.match(wallet, /width=\{312\}/);
  assert.match(wallet, /height=\{156\}/);
  // 미리 받을 그림 요청이 없다
  assert.doesNotMatch(myTickets, /rel="preload"/, '그림 preload를 두지 않는다');
  assert.equal(existsSync(join(webRoot, 'public/wallet-qr-skeleton.png')), false, '인라인 뒤 public 정적 그림을 지운다');
  for (const file of sourceFiles()) {
    assert.ok(!read(file).includes('wallet-qr-skeleton.png'), `${relative(srcRoot, file)}가 public 그림 경로를 가리킨다`);
  }
});

test('BAT-177 T6 ② QR 뼈대 data URI는 PNG 서명으로 풀리고 2,000자 미만이다', () => {
  const skeletonPath = join(here, 'qr-skeleton.ts');
  assert.ok(existsSync(skeletonPath), 'qr-skeleton.ts가 첫 HTML용 data URI를 내놓는다');
  const qrSkeleton = read(skeletonPath);
  assert.doesNotMatch(qrSkeleton, /^\s*['"]use client['"]/m, 'data URI는 서버 컴포넌트만 가져간다');
  const prefix = 'data:image/png;base64,';
  const match = /'(data:image\/png;base64,[A-Za-z0-9+/=]+)'/.exec(qrSkeleton);
  assert.ok(match, 'WALLET_QR_SKELETON이 data URI다');
  const uri = match[1];
  assert.ok(uri.length < 2000, `data URI가 ${uri.length}자다`);
  const bytes = Buffer.from(uri.slice(prefix.length), 'base64');
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 서명(89 50 4E 47 0D 0A 1A 0A)');
  // 'use client' 파일은 data URI를 가져가지 않는다(첫 JS에 1.2KB를 더하지 않는다)
  for (const file of sourceFiles()) {
    const text = read(file);
    if (!/^\s*['"]use client['"]/m.test(text)) continue;
    assert.ok(!/from ['"][^'"]*qr-skeleton['"]/.test(text), `${relative(srcRoot, file)}가 첫 JS에 data URI를 싣는다`);
  }
});

test('BAT-177 T6 ③ QR·오프라인 덩어리는 load 뒤에 한 번 받고 고정 300ms·1,500ms 타이머가 없다', () => {
  const wallet = read(join(here, 'Wallet.tsx'));
  const walletClient = read(join(here, 'WalletClient.tsx'));
  assert.match(walletClient, /import \{ afterLoad \} from '@\/shared\/lib\/after-load'/);
  assert.match(walletClient, /afterLoad\(\(\) => \{[\s\S]*?void load\(\)/, 'import()는 afterLoad 콜백 안에서 시작한다');
  assert.match(walletClient, /const loadDeviceQr = \(\) => import\('@\/features\/wallet-device-key\/ui\/DeviceQr'\)/);
  assert.match(walletClient, /const loadOfflineBanner = \(\) => import\('@\/features\/wallet-device-key\/ui\/OfflineBanner'\)/);
  assert.match(walletClient, /DeviceQrLazy[\s\S]*?useLazyComponent\(loadDeviceQr\)/);
  assert.match(walletClient, /OfflineBannerLazy[\s\S]*?useLazyComponent\(loadOfflineBanner\)/);
  assert.doesNotMatch(walletClient, /setTimeout/, '고정 타이머로 받지 않는다');
  assert.doesNotMatch(walletClient, /\b(?:300|1500)\b|1,500/, '300ms·1,500ms 값을 남기지 않는다');
  assert.doesNotMatch(walletClient, /delayMs/, '지연 시간 인자를 두지 않는다');
  // 오프라인 배너(서비스 워커 등록)는 Wallet의 게으른 조각으로 그려진다
  assert.match(wallet, /<OfflineBannerLazy/, '서비스 워커 등록 조각도 load 뒤로 밀린다');
});

test('BAT-177 T6 ④ QR 뼈대 PNG의 IHDR 폭·높이는 312×156이다', () => {
  const qrSkeleton = read(join(here, 'qr-skeleton.ts'));
  const match = /'(data:image\/png;base64,[A-Za-z0-9+/=]+)'/.exec(qrSkeleton);
  assert.ok(match, 'WALLET_QR_SKELETON이 data URI다');
  const bytes = Buffer.from(match[1].slice('data:image/png;base64,'.length), 'base64');
  // PNG: 서명 8바이트 → IHDR 길이(4) → 'IHDR'(4) → 폭(4) → 높이(4)
  assert.equal(bytes.subarray(12, 16).toString('latin1'), 'IHDR', 'IHDR 청크가 있다');
  assert.equal(bytes.readUInt32BE(16), 312, 'IHDR 폭이 312다');
  assert.equal(bytes.readUInt32BE(20), 156, 'IHDR 높이가 156이다');
});

test('BAT-177 T6 ⑤ QR·오프라인 조각은 정적 import하지 않고 load 전에는 fallback만 그린다', () => {
  const walletClient = read(join(here, 'WalletClient.tsx'));
  // DeviceQr·OfflineBanner는 import type만 허용한다(값을 정적으로 가져오면 첫 JS에 든다)
  const staticImports = [...walletClient.matchAll(/^import\s+(.+?)\s+from\s+'([^']+)';$/gm)].filter(([, , path]) =>
    /\/(?:DeviceQr|OfflineBanner)$/.test(path),
  );
  assert.equal(staticImports.length, 2, '두 조각은 정적 import가 타입 둘뿐이다');
  for (const [, clause, path] of staticImports) assert.match(clause, /^type\b/, `${path}는 type import만 한다`);
  assert.doesNotMatch(walletClient, /<DeviceQr[\s>]/, 'DeviceQr를 직접 그리지 않는다');
  assert.doesNotMatch(walletClient, /<OfflineBanner[\s>]/, 'OfflineBanner를 직접 그리지 않는다');
  // 받기 전에는 fallback(QR)과 자리(오프라인 배너)만 그린다
  assert.match(walletClient, /useState<ComponentType<P> \| null>\(null\)/, '처음에는 조각이 없다');
  assert.match(walletClient, /export function DeviceQrLazy[\s\S]*?if \(!Component\) return <>\{fallback\}<\/>;/, 'QR은 load 전에 fallback만 그린다');
  assert.match(
    walletClient,
    /export function OfflineBannerLazy[\s\S]*?if \(!Component\) return <div style=\{\{ height: 40 \}\} aria-hidden="true" \/>;/,
    '오프라인 배너는 load 전에 자리만 잡는다',
  );
  // 동적 import를 부르는 곳은 afterLoad 콜백 하나뿐이다(T6 ③과 겹쳐 확인)
  assert.equal(walletClient.match(/void load\(\)/g)?.length, 1);
});
