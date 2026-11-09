// 좌석 WebSocket 하위 프로토콜 인증 PoC(BUILD_ORDER HOT-100, wbs 2.6.4, docs/frontend.md §4.4.1, ADR-0240, FE-T11). 세 엔진의 실제 브라우저로 본다.
// 브라우저 쪽만 본다: 토큰이 Sec-WebSocket-Protocol로 그대로 나가는지, 서버가 고른 값만 보이는지, 핸드셰이크 거절과 4401이 어떻게 보이는지.
// 게이트웨이(Envoy Gateway)가 이 값을 읽어 검증하는지는 HOT-090에서 잰다.
import { expect, test } from '@playwright/test';

// 실제 입장 토큰보다 긴 JWT 모양(RFC 6455 토큰 문자 범위 안)
const b64 = (n) => 'a'.repeat(n);
const TOKEN = `${b64(40)}.${b64(1100)}.${b64(86)}`;

/** 소켓을 열고 첫 사건까지 본다 */
const dial = (page, mode, protocols) =>
  page.evaluate(
    ([m, p]) =>
      new Promise((resolve) => {
        const out = { opened: false, protocol: null, code: null, firstFrame: null };
        const ws = new WebSocket(`ws://${location.host}/ws/seats?mode=${m}`, p);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          out.opened = true;
          out.protocol = ws.protocol;
          // Firefox·WebKit은 서버가 고르지 않아도 연결을 연다. 닫아야 시험이 끝난다
          if (m === 'none') ws.close(1000);
        };
        ws.onmessage = (e) => {
          out.firstFrame = e.data instanceof ArrayBuffer ? e.data.byteLength : typeof e.data;
          if (m === 'ok') ws.close(1000);
        };
        ws.onclose = (e) => {
          out.code = e.code;
          resolve(out);
        };
      }),
    [mode, protocols],
  );

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('FE-T11 하위 프로토콜로 낸 토큰이 그대로 서버에 닿고, 서버가 고른 좌석 프로토콜만 보인다', async ({ page, request }) => {
  const r = await dial(page, 'ok', ['peaket.seats.v1', `peaket.auth.${TOKEN}`]);
  expect(r.opened).toBe(true);
  expect(r.protocol).toBe('peaket.seats.v1');
  expect(r.firstFrame).toBe(18);
  const log = await (await request.get('/ws-log')).json();
  expect(log.protocols.split(/,\s*/)).toEqual(['peaket.seats.v1', `peaket.auth.${TOKEN}`]);
});

test('FE-T11 서버가 하위 프로토콜을 고르지 않으면 브라우저가 알려 주는 protocol이 비어 있거나 연결이 실패한다', async ({ page }) => {
  const r = await dial(page, 'none', ['peaket.seats.v1', `peaket.auth.${TOKEN}`]);
  // Chromium은 연결을 실패시키고 Firefox·WebKit은 protocol이 빈 채로 연다. 어느 쪽이든 connection.ts는 live로 보지 않는다
  expect(r.opened ? r.protocol : '').toBe('');
});

test('ADR-0240 핸드셰이크에서 401로 거절하면 브라우저는 열리지 않고 닫힘 코드는 1006뿐이다', async ({ page }) => {
  const r = await dial(page, 'reject', ['peaket.seats.v1', `peaket.auth.${TOKEN}`]);
  expect(r.opened).toBe(false);
  expect(r.code).toBe(1006);
});

test('FE-T11 연결 뒤 서버가 4401로 닫으면 브라우저가 그 코드를 받는다', async ({ page }) => {
  const r = await dial(page, 'close4401', ['peaket.seats.v1', `peaket.auth.${TOKEN}`]);
  expect(r.opened).toBe(true);
  expect(r.code).toBe(4401);
});
