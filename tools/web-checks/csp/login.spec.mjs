// 로그인 화면(SCR-004)의 로그인 시작 폼이 운영 빌드·막는 CSP 아래에서 실제로 보내지는지(BUILD_ORDER HOT-321, ADR-0202 결정 5, d5 §5.4 '진행 중').
// HOT-321 새 맥락 리뷰 높음: 누른 뒤 '진행 중'을 그리면서 폼을 문서에서 빼면 브라우저가 보내기를 취소했다(콘솔 'Form submission canceled').
// 단위 시험(loginView)은 이를 잡지 못해 브라우저로 본다.
// - 보내기: 앱 서버의 로그인 경로 요청을 가로채 작은 글자 화면으로 답한다(공급자로 가지 않게). POST가 한 번 나가 그 화면으로 옮겨 갔는지 본다.
// - 진행 중: 보내기를 창(window)에서 막아(React 처리 뒤) 화면에 머물게 하고 누른 버튼만 진행 중인지, 그때 폼이 문서에 붙어 있는지 본다.
//   이동을 붙잡아 두는 방법은 쓰지 않는다(Chromium은 이동이 걸린 동안 문서를 읽지 못한다).
import { test, expect } from '@playwright/test';
import { WEB_BASE, stubFanApi } from './pages.mjs';
import { isBidiFirefox } from '../lib/firefox.mjs';

test.beforeEach(({ page }) => stubFanApi(page));

/** 하이드레이션 뒤에 누른다(그 전에는 '진행 중' 표시 없이 보낸다) */
const hydrated = (page) =>
  page.waitForFunction(() => {
    const f = document.querySelector('form[action="/login/naver"]');
    return !!f && Object.keys(f).some((k) => k.startsWith('__react'));
  });

test('SCR-004 제공자 버튼을 누르면 POST /login/{provider}가 돌아갈 주소와 함께 실제로 나간다(form-action, 폼이 빠져 취소되지 않는다)', async ({ page, browserName }) => {
  const canceled = [];
  page.on('console', (m) => {
    if (/Form submission canceled/i.test(m.text())) canceled.push(m.text());
  });
  const posts = [];
  await page.route('**/login/naver', async (route) => {
    posts.push({ method: route.request().method(), body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: 'started' });
  });
  await page.goto(`${WEB_BASE}/login?next=%2Fevents%2Fx%3Fround%3D2`);
  await hydrated(page);
  await page.getByRole('button', { name: '네이버 로그인' }).click();
  await page.waitForURL(/\/login\/naver$/);
  expect(posts).toHaveLength(1);
  expect(posts[0].method).toBe('POST');
  if (isBidiFirefox(browserName)) {
    // BiDi Firefox는 보낸 요청의 본문을 주지 않는다(lib/firefox.mjs). 보낸 것과 이동만 보고 returnTo는 다른 엔진이 본다
    expect(posts[0].body).toBeNull();
    test.info().annotations.push({ type: 'BiDi 한계', description: '요청 본문(returnTo)은 보지 못했다' });
  } else expect(new URLSearchParams(posts[0].body ?? '').get('returnTo')).toBe('/events/x?round=2');
  expect(canceled).toEqual([]);
});

test('SCR-004 누른 버튼만 진행 중이고 나머지는 비활성이며, 진행 중에 다시 보내지 않는다', async ({ page }) => {
  await page.goto(`${WEB_BASE}/login`);
  await hydrated(page);
  // React의 보내기 처리(뿌리에서 듣는다)가 끝난 뒤 창에서 막는다. 그때 폼이 문서에 붙어 있어야 브라우저가 실제로 보낸다
  await page.evaluate(() => {
    window.__submits = [];
    window.addEventListener('submit', (e) => {
      window.__submits.push({ action: e.target.getAttribute('action'), connected: e.target.isConnected, prevented: e.defaultPrevented });
      e.preventDefault();
    });
  });
  await page.getByRole('button', { name: '네이버 로그인' }).click();
  await expect(page.getByRole('button', { name: '네이버 로그인' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: '카카오 로그인' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Google 계정으로 로그인' })).toBeDisabled();
  // Enter 연타처럼 같은 폼을 다시 보내면 화면이 막는다
  await page.evaluate(() => document.querySelector('form[action="/login/naver"]').requestSubmit());
  expect(await page.evaluate(() => window.__submits)).toEqual([
    { action: '/login/naver', connected: true, prevented: false },
    { action: '/login/naver', connected: true, prevented: true },
  ]);
});
