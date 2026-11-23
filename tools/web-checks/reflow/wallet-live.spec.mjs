// 실제 월렛 화면(목록·펼침)의 상태를 운영 빌드에서 본다(FIX-wallet-tickets, docs/features/offline-gate.md §11 O-T48 ②③④⑤⑥⑦⑨,
// docs/frontend.md §4.2.4 '월렛 목록 세부', docs/design/d5-screen-blueprint.md §5.13 상태 표, 계획 docs/review/plans/FIX-wallet-tickets.md §8.4).
// 시험 담당(fwal-test-2e9a)이 구현 전에 썼다(ADR-0372). 실행은 ci-web reflow 잡(이 설정의 ' 기본 폭: ' 프로젝트)이다.
// - 팬 API(https://api.peaket.example, 검사 빌드의 기본 출처)는 브라우저 문맥(context.route)에서 답한다. 화면 상태(빈 목록·오류·상태 섞인 목록·없는 표)를
//   만드는 덧붙인 시험이다. 같은 흐름의 실제 서버 연결 시험은 데모 S1(`node tools/local/demo.mjs play --scenarios S1`의 wallet-list·ticket-qr)이다
//   (정본 §8.6 4의 4 '가짜 API로 끝내지 않는다', 스킬 mock-policy 3절).
// - 기다림은 조건 단언(expect(locator)·expect.poll)뿐이고 고정 대기가 없다.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { FAN_API_ORIGIN, stubFanApi } from '../csp/pages.mjs';
import { APPS, HOST, portOf } from '../seed-css/apps.mjs';

const WEB = `http://${HOST}:${portOf(APPS.find((a) => a.name === 'web'), 'prod')}`;
const CORS = { 'access-control-allow-origin': WEB, 'access-control-allow-credentials': 'true', vary: 'Origin' };
const DAY = 24 * 3_600_000;
const LIVE = '0193f2c0-0000-7000-8000-0000000fe201';
const MISSING = '0193f2c0-0000-7000-8000-0000000fe202';

/** 목록 항목(정본 offline-gate §2 '무엇을 싣나'의 칸) */
function item(ticketId, status = 'ISSUED', eventId = LIVE) {
  const startsAt = new Date(Date.now() + 7 * DAY).toISOString();
  return { ticketId, eventId, status, transferLocked: false, eventStartsAt: startsAt, cancelDeadline: startsAt, receivedFromNickname: null };
}

function summary(eventId, title) {
  const starts = Date.now() + 7 * DAY;
  return {
    eventId,
    title,
    startsAt: new Date(starts).toISOString(),
    sellerName: '주식회사 피켓 시험',
    placeName: '시험 공연장',
    entryOpensAt: new Date(starts - 3_600_000).toISOString(),
    endsAt: new Date(starts + 3 * 3_600_000).toISOString(),
  };
}

const answer = (status, body) => ({
  status,
  headers: { ...CORS, 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', 'cache-control': 'private, no-store' },
  body: JSON.stringify(body),
});
const list = (items, nextCursor = null) => answer(200, { items, nextCursor });
const fail = (status) => answer(status, { type: 'about:blank', title: '오류', status });

/**
 * 팬 API 대역: 나머지 경로는 일시 장애(503, csp/pages.mjs stubFanApi)이고, 목록·회차 요약·토큰 갱신만 준 답을 낸다.
 * tickets는 차례대로 쓰고 마지막 답을 되풀이한다. 'abort'는 연결 끊김이다. 받은 요청 수를 센다
 */
async function fanApi(context, { tickets = [list([])], events = {}, refresh = fail(503) } = {}) {
  await stubFanApi(context);
  const calls = { tickets: 0, events: [], refresh: 0 };
  const api = new URL(FAN_API_ORIGIN).origin;
  const preflight = (route) => route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'accept, content-type' } });
  await context.route(
    (url) => url.origin === api && url.pathname === '/v1/tickets',
    (route) => {
      if (route.request().method() === 'OPTIONS') return preflight(route);
      const r = tickets[Math.min(calls.tickets, tickets.length - 1)];
      calls.tickets += 1;
      return r === 'abort' ? route.abort('internetdisconnected') : route.fulfill(r);
    },
  );
  await context.route(
    (url) => url.origin === api && url.pathname.startsWith('/v1/events/'),
    (route) => {
      if (route.request().method() === 'OPTIONS') return preflight(route);
      const id = new URL(route.request().url()).pathname.slice('/v1/events/'.length);
      calls.events.push(id);
      return route.fulfill(events[id] ?? answer(200, summary(id, `공연 ${id.slice(-3)}`)));
    },
  );
  await context.route(
    (url) => url.origin === api && url.pathname === '/v1/identity/access-tokens',
    (route) => {
      if (route.request().method() === 'OPTIONS') return preflight(route);
      calls.refresh += 1;
      return route.fulfill(refresh);
    },
  );
  return calls;
}

const registerButton = (page, ticketId) => page.getByRole('button', { name: new RegExp(`^입장 QR, 티켓 ${ticketId}, 15초마다 바뀝니다.*이 휴대폰을 입장용으로 등록$`) });

test('BAT-177 T6 ⑥ 기본 폭: 실제 월렛 /my/tickets 첫 HTML은 불러오는 중 글과 QR 뼈대 data URI를 싣는다(가짜 그림 티켓이 없다)', async ({ page }) => {
  const res = await page.request.get(`${WEB}/my/tickets`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('티켓을 불러오는 중입니다');
  expect(html).toMatch(/wallet-qr-skeleton/);
  expect(html).toMatch(/src="data:image\/png;base64,/);
  // 목업 티켓 ID(tkt-…)를 첫 HTML에 싣지 않는다(실제 화면은 저장소의 표로만 그린다)
  expect(html).not.toMatch(/tkt-lumen-/);
});

test('O-T48 ② 기본 폭: 표가 0장이면 "아직 티켓이 없습니다"와 ( 공연 둘러보기 › )다', async ({ page, context }) => {
  const calls = await fanApi(context, { tickets: [list([])] });
  await page.goto(`${WEB}/my/tickets`);
  await expect(page.getByText('아직 티켓이 없습니다')).toBeVisible();
  await expect(page.getByRole('link', { name: /공연 둘러보기/ })).toBeVisible();
  expect(calls.tickets).toBeGreaterThanOrEqual(1);
  await expect(page.getByRole('button', { name: /이 휴대폰을 입장용으로 등록/ })).toHaveCount(0);
});

test('O-T48 ③ 기본 폭: 저장된 표가 없고 목록이 503이면 "티켓을 불러오지 못했습니다"와 [ 다시 시도 ]이고 누르면 다시 부른다', async ({ page, context }) => {
  const id = randomUUID();
  const calls = await fanApi(context, { tickets: [fail(503), list([item(id)])] });
  await page.goto(`${WEB}/my/tickets`);
  await expect(page.getByText('티켓을 불러오지 못했습니다')).toBeVisible();
  const before = calls.tickets;
  await page.getByRole('button', { name: '다시 시도' }).click();
  await expect.poll(() => calls.tickets, { message: '[다시 시도]가 목록을 다시 부르지 않았다' }).toBeGreaterThan(before);
  await expect(registerButton(page, id)).toBeVisible();
});

test('O-T48 ④ 기본 폭: 저장된 표가 있는데 목록 요청이 끊기면 저장된 표와 마지막 동기화 시각이 든 오프라인 배너를 보인다', async ({ page, context }) => {
  const id = randomUUID();
  await fanApi(context, { tickets: [list([item(id)]), 'abort'] });
  await page.goto(`${WEB}/my/tickets`);
  await expect(registerButton(page, id)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: '오프라인입니다' })).toContainText('마지막 동기화');
  await expect(registerButton(page, id)).toBeVisible();
  await expect(page.getByText('티켓을 불러오지 못했습니다')).toHaveCount(0);
});

test('O-T48 ⑤ 기본 폭: 토큰을 갱신한 뒤에도 401이면 저장된 표를 그리지 않고 로그인 화면으로 간다', async ({ page, context }) => {
  const id = randomUUID();
  const unauthorized = answer(401, { type: 'about:blank', title: 'Unauthorized', status: 401 });
  const calls = await fanApi(context, { tickets: [list([item(id)]), unauthorized], refresh: answer(204, {}) });
  await page.goto(`${WEB}/my/tickets`);
  await expect(registerButton(page, id)).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/login(?:[/?#]|$)/);
  expect(calls.refresh).toBeGreaterThanOrEqual(1);
  await expect(registerButton(page, id)).toHaveCount(0);
});

test('O-T48 ⑥⑦ 기본 폭: 상태가 섞인 목록에서 ISSUED·ACTIVE 두 장만 입장용 등록 버튼이 있고 나머지는 배지·문장만이며 요약 실패 회차의 표도 보인다', async ({ page, context }) => {
  const t = Object.fromEntries(['ISSUED', 'ACTIVE', 'TRANSFER_PENDING', 'CANCEL_REQUESTED', 'REFUNDED', 'FLAGGED', 'VOIDED'].map((s) => [s, randomUUID()]));
  const orphan = randomUUID();
  const calls = await fanApi(context, {
    tickets: [list([...Object.entries(t).map(([s, id]) => item(id, s)), item(orphan, 'ISSUED', MISSING)])],
    events: { [LIVE]: answer(200, summary(LIVE, 'LUMEN 콘서트 2026 서울')), [MISSING]: fail(404) },
  });
  await page.goto(`${WEB}/my/tickets`);
  await expect(registerButton(page, t.ISSUED)).toBeVisible();
  await expect(registerButton(page, t.ACTIVE)).toBeVisible();
  await expect(registerButton(page, orphan)).toBeVisible();
  // QR 자리(등록 버튼)는 유효한 표 셋뿐이다
  await expect(page.getByRole('button', { name: /이 휴대폰을 입장용으로 등록/ })).toHaveCount(3);
  for (const s of ['TRANSFER_PENDING', 'CANCEL_REQUESTED', 'REFUNDED', 'FLAGGED', 'VOIDED']) await expect(registerButton(page, t[s]), s).toHaveCount(0);
  // 배지·문장은 정본 글 그대로
  for (const badge of ['양도 요청 중', '취소 접수됨', '환급됨', '확인 중', '무효']) await expect(page.getByText(badge, { exact: true }), badge).toBeVisible();
  for (const note of ['입장 기록 마감 뒤 환급됩니다', '현장에서 입장 기록을 확인하고 있습니다', '입금이 확인되지 않아 티켓이 무효가 되었습니다']) await expect(page.getByText(note), note).toBeVisible();
  // 요약 200 회차는 공연명, 404 회차의 표는 남고 공연명 자리에 안내 글
  await expect(page.getByText('LUMEN 콘서트 2026 서울')).not.toHaveCount(0);
  await expect(page.getByText('공연 정보를 불러오지 못했습니다')).toHaveCount(1);
  // 같은 회차는 한 번만 묻는다
  expect(calls.events.filter((e) => e === LIVE)).toHaveLength(1);
});

test('O-T48 ⑨ 기본 폭: 펼침 주소의 티켓 ID가 목록에 없으면 "티켓을 찾을 수 없습니다"와 ( 마이 티켓 › )다', async ({ page, context }) => {
  const mine = randomUUID();
  await fanApi(context, { tickets: [list([item(mine)])] });
  const res = await page.goto(`${WEB}/my/tickets/${randomUUID()}`);
  // 서버 셸은 티켓 ID로 아무것도 읽지 않으므로 없는 표도 404가 아니다(남의 표와 없는 표를 가르지 않는다)
  expect(res?.status()).toBe(200);
  await expect(page.getByText('티켓을 찾을 수 없습니다')).toBeVisible();
  await expect(page.getByRole('link', { name: /마이 티켓/ })).toBeVisible();
  await expect(registerButton(page, mine)).toHaveCount(0);
  // 대조: 목록에 있는 표의 펼침은 그 표를 그린다
  await page.goto(`${WEB}/my/tickets/${mine}`);
  await expect(registerButton(page, mine)).toBeVisible();
  await expect(page.getByText('티켓을 찾을 수 없습니다')).toHaveCount(0);
});
