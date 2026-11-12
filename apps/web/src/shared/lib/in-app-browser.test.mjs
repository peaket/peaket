// 인앱 브라우저 감지와 SCR-058 이동(d5 §5.32, NFR-019, docs/frontend.md §1.5·§5.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInAppBrowser, entryHref, isInAppBrowser, openInBrowserHref } from './in-app-browser.ts';

const UA = {
  kakao: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.2',
  instagram: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Instagram 350.0.0.0',
  facebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.0]',
  naver: 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 NAVER(inapp; search; 1000; 12.0.0)',
  line: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.0.0',
  band: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Band/14.0.0',
  tiktok: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 musical_ly_2026.1.0',
  x: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone',
  chrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
};

test('NFR-019 알려진 인앱 브라우저를 앱별로 알아본다', () => {
  assert.equal(detectInAppBrowser(UA.kakao), 'KAKAO');
  assert.equal(detectInAppBrowser(UA.instagram), 'INSTAGRAM');
  assert.equal(detectInAppBrowser(UA.facebook), 'FACEBOOK');
  assert.equal(detectInAppBrowser(UA.naver), 'NAVER');
  assert.equal(detectInAppBrowser(UA.line), 'LINE');
  assert.equal(detectInAppBrowser(UA.band), 'BAND');
  assert.equal(detectInAppBrowser(UA.tiktok), 'TIKTOK');
  assert.equal(detectInAppBrowser(UA.x), 'X');
});

test('NFR-019 일반 브라우저와 빈 User-Agent는 인앱으로 보지 않는다', () => {
  for (const ua of [UA.chrome, UA.safari, UA.firefox, '', undefined, null]) {
    assert.equal(detectInAppBrowser(ua), null, String(ua));
    assert.equal(isInAppBrowser(ua), false, String(ua));
  }
});

test('SCR-058 안내 주소는 같은 출처 경로만 next로 싣고 나머지는 첫 화면으로 보낸다', () => {
  assert.equal(openInBrowserHref('/queue/evt-1'), '/open-in-browser?next=%2Fqueue%2Fevt-1');
  assert.equal(openInBrowserHref('/my/tickets/tkt-1?tab=qr'), '/open-in-browser?next=%2Fmy%2Ftickets%2Ftkt-1%3Ftab%3Dqr');
  assert.equal(openInBrowserHref('//evil.example/queue'), '/');
  assert.equal(openInBrowserHref('https://evil.example/queue'), '/');
  assert.equal(openInBrowserHref('/\\evil'), '/');
  assert.equal(openInBrowserHref('/queue/%2F%2Fevil'), '/');
});

test('SCR-058 인앱 브라우저에서만 안내를 먼저 거치고 일반 브라우저는 그대로 간다', () => {
  assert.equal(entryHref('/queue/evt-1', UA.kakao), '/open-in-browser?next=%2Fqueue%2Fevt-1');
  assert.equal(entryHref('/my/tickets/tkt-1', UA.instagram), '/open-in-browser?next=%2Fmy%2Ftickets%2Ftkt-1');
  assert.equal(entryHref('/queue/evt-1', UA.chrome), '/queue/evt-1');
  assert.equal(entryHref('/queue/evt-1', undefined), '/queue/evt-1');
});

test('SCR-058 안전하지 않은 next는 인앱 브라우저에서도 첫 화면으로 보낸다', () => {
  assert.equal(entryHref('//evil.example/queue', UA.kakao), '/');
  assert.equal(entryHref('https://evil.example/queue', UA.kakao), '/');
});
