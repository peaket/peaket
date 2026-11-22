// iOS·홈 화면·데스크톱·인앱 안내와 영속 저장소 시험(BUILD_ORDER GAT-020, F-05-1, docs/features/offline-gate.md §11 O-T32·O-T50, ADR-0363 결정 10,
// docs/frontend.md §5.4 '입장용 휴대폰 등록'). 기기 판별은 주입한 신호(사용자 에이전트·표시 방식·터치 점)로 보고,
// '키를 만들기 전에 안내' 자리는 화면 부품(ui/DeviceQr.tsx)이 그 판별을 키 만들기보다 먼저 쓰는지 소스로 본다(실제 화면은 브라우저 확인 몫).
// 영속 저장소 결과(meta.persistGranted)는 navigator.storage.persist(브라우저 경계)만 바꿔 끼우고 IndexedDB는 fake-indexeddb다.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { enrollPlatformOf, needsEnrollGuide } from './platform.ts';
import { loadLastSyncedAt, loadPersistGranted, requestPersistentStorage, saveLastSyncedAt } from './store.ts';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1',
  ipadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  kakaoInApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 11.2.0',
  instagramInApp: 'Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0',
};

const DEVICE_QR = readFileSync(new URL('./ui/DeviceQr.tsx', import.meta.url), 'utf8');
const ENROLL_GUIDE = readFileSync(new URL('./ui/EnrollGuide.tsx', import.meta.url), 'utf8');
/** 주석을 뺀 소스 */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('O-T50 ① iOS Safari 탭은 키를 만들지 않고 등록 요청이 0건이다(먼저 홈 화면 안내를 보인다)', () => {
  assert.equal(enrollPlatformOf({ userAgent: UA.iphoneSafari, displayStandalone: false }), 'ios-tab');
  assert.equal(needsEnrollGuide('ios-tab'), true);
  // 화면: '등록'을 누르면 안내가 필요한 기기에서는 안내를 세우고 키 만들기(enroll)를 부르지 않은 채 끝난다
  const reg = code(DEVICE_QR).slice(code(DEVICE_QR).indexOf('const register = useCallback('));
  const body = reg.slice(0, reg.indexOf('}, [enroll, guide]'));
  const guideAt = body.indexOf('needsEnrollGuide(platform)');
  const enrollAt = body.indexOf('return enroll()');
  assert.ok(guideAt > 0 && enrollAt > guideAt, '안내 판별이 키 만들기보다 먼저가 아니다');
  assert.match(body.slice(guideAt, enrollAt), /setGuide\(platform\);\s*return;/);
  // 안내 문구(ADR-0363 결정 10, offline-gate O-T50 ①)
  assert.match(ENROLL_GUIDE, /홈 화면에 추가한 앱에서 등록하세요/);
  assert.match(ENROLL_GUIDE, /방법 보기/);
  assert.match(ENROLL_GUIDE, /그래도 이 브라우저에 등록/);
});

test('O-T50 ② iOS 홈 화면 앱(display-mode: standalone, 옛 navigator.standalone)은 안내 없이 등록한다', () => {
  for (const s of [
    { userAgent: UA.iphoneSafari, displayStandalone: true },
    { userAgent: UA.iphoneSafari, displayStandalone: false, navigatorStandalone: true },
    { userAgent: UA.ipadAsMac, displayStandalone: true, maxTouchPoints: 5 },
  ]) {
    assert.equal(enrollPlatformOf(s), 'ios-standalone', JSON.stringify(s));
    assert.equal(needsEnrollGuide(enrollPlatformOf(s)), false);
  }
  // 데스크톱 Safari 꼴 사용자 에이전트를 내는 iPadOS 탭(터치 점 > 1)도 iOS 탭이다
  assert.equal(enrollPlatformOf({ userAgent: UA.ipadAsMac, displayStandalone: false, maxTouchPoints: 5 }), 'ios-tab');
});

test('O-T50 ③ ( 그래도 이 브라우저에 등록 › )을 누르면 등록하고 persist()를 한 번 부른다', () => {
  // 화면: enroll은 영속 저장소 요청을 기다린 뒤 키를 만든다
  const c = code(DEVICE_QR);
  const enroll = c.slice(c.indexOf('const enroll = useCallback('), c.indexOf('const register = useCallback('));
  const persistAt = enroll.indexOf('await requestPersistentStorage()');
  const enrollAt = enroll.indexOf('enrollDeviceKey(ticketId');
  assert.ok(persistAt > 0 && enrollAt > persistAt, '등록 전에 persist()를 부르지 않는다');
  assert.equal([...enroll.matchAll(/requestPersistentStorage\(\)/g)].length, 1);
  // 안내의 '그래도 …' 버튼이 enroll 쪽으로 이어진다(안내를 닫고 다시 묻지 않는다)
  assert.match(c, /needsEnrollGuide\(platform\) && guide === null/);
});

test('O-T50 ④ 인앱 브라우저는 SCR-058(외부 브라우저 안내)로 보낸다', () => {
  for (const ua of [UA.kakaoInApp, UA.instagramInApp]) assert.equal(enrollPlatformOf({ userAgent: ua, displayStandalone: false }), 'in-app', ua);
  const reg = code(DEVICE_QR).slice(code(DEVICE_QR).indexOf('const register = useCallback('));
  const inApp = reg.slice(reg.indexOf("if (platform === 'in-app')"), reg.indexOf('needsEnrollGuide(platform)'));
  assert.match(inApp, /window\.location\.assign\(openInBrowserHref\(/);
  assert.match(inApp, /return;/);
});

test('O-T32 데스크톱으로 보이는 브라우저는 키를 만들지 않고 휴대폰 등록을 안내하고, 휴대폰은 안내 없이 등록한다', () => {
  for (const s of [
    { userAgent: UA.windowsChrome, displayStandalone: false },
    { userAgent: UA.macSafari, displayStandalone: false, maxTouchPoints: 0 },
  ]) {
    assert.equal(enrollPlatformOf(s), 'desktop', s.userAgent);
    assert.equal(needsEnrollGuide('desktop'), true);
  }
  assert.match(ENROLL_GUIDE, /입장 QR은 휴대폰에서 등록하세요/);
  assert.match(ENROLL_GUIDE, /그래도 이 기기에 등록/);
  assert.equal(enrollPlatformOf({ userAgent: UA.androidChrome, displayStandalone: false, coarsePointer: true }), 'mobile');
  assert.equal(needsEnrollGuide('mobile'), false);
});

test('O-T50 ⑤ 월렛을 열 때마다 persist()를 부르고 결과가 meta.persistGranted에 남으며 다른 meta 칸은 지우지 않는다', async () => {
  const answers = [true, false, true];
  let calls = 0;
  const realStorage = Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage');
  Object.defineProperty(globalThis.navigator, 'storage', { configurable: true, value: { persist: async () => answers[calls++] } });
  try {
    await saveLastSyncedAt(1_763_888_000_123);
    assert.equal(await requestPersistentStorage(), true);
    assert.equal(await loadPersistGranted(), true);
    assert.equal(await requestPersistentStorage(), false);
    assert.equal(await loadPersistGranted(), false);
    assert.equal(await requestPersistentStorage(), true);
    assert.equal(await loadPersistGranted(), true);
    assert.equal(calls, 3);
    assert.equal(await loadLastSyncedAt(), 1_763_888_000_123, '마지막 동기화 시각이 지워졌다');
    // 화면: 월렛(티켓 펼침)이 붙을 때마다 부른다
    const c = code(DEVICE_QR);
    const mount = c.slice(c.indexOf('useEffect(() => {\n    mounted.current = true;'), c.indexOf('}, [ticketId]);'));
    assert.match(mount, /void requestPersistentStorage\(\);/);
  } finally {
    if (realStorage) Object.defineProperty(globalThis.navigator, 'storage', realStorage);
    else delete globalThis.navigator.storage;
  }
});
