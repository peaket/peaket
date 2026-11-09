// 대기실 T=0 세 엔진 검사(ADR-0217, BUILD_ORDER HOT-347): FE-T3(사전 요청 0)·FE-T15(AbortSignal.any 없는 페이지의 시간 초과·화면 떠남)·
// FE-T4(대기 폴링 간격·숨긴 탭 최소 간격·200의 Retry-After 무시·셔플 결과 고정 지연)의 브라우저 칸.
// 요청은 검사용 가짜 API의 검사 기록(GET /__mock/requests)으로 센다. page.route는 쓰지 않는다(Playwright가 가로챈 경로의 사전 요청에 스스로 답한다).
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { CHECK_MOCK_ORIGIN } from './origins.mjs';

const EVENT = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e04';
const KEY = `peaket.queue.${EVENT}`;
const QUEUE = `/v1/queues/${EVENT}/`;

const state = async (q) => {
  const r = await fetch(`${CHECK_MOCK_ORIGIN}/__mock/state?${q}`);
  expect(r.status).toBe(200);
};
const requests = async () => (await (await fetch(`${CHECK_MOCK_ORIGIN}/__mock/requests`)).json()).items;
/** 저장소 값을 처음 한 번만 둔다(다시 불러와도 덮지 않는다) */
const seed = (page, rec) =>
  page.addInitScript(([k, v]) => {
    // about:blank 같은 문서는 저장소를 쓸 수 없다(그 오류는 화면의 것이 아니다)
    if (location.protocol !== 'http:') return;
    if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({ ...v, savedAt: Date.now() }));
  }, [KEY, rec]);
const preverify = () => ({ preverifyToken: `pv-${Math.random().toString(36).slice(2)}`, preverifyIssuedAt: Date.now() });
const gaps = (times) => times.slice(1).map((t, i) => t - times[i]);
const fileGets = (log) => log.filter((x) => x.m === 'GET' && x.path.startsWith(`${QUEUE}segment-states/`)).map((x) => x.at);

test.beforeEach(async () => {
  await state('queueReset=1&logReset=1&queue=on-sale&queueEntry=normal&queueAdmit=normal&queueStateRetryAfter=&queueOpenIn=&queueShuffle=normal');
});

test('FE-T3 T=0 두 호출(진입·입장 확정)과 대기열 파일 GET에 CORS 사전 요청(OPTIONS)이 없다', async ({ page }) => {
  await state('queueAhead=2&queueRate=5');
  await seed(page, preverify());
  await page.goto(`/queue/${EVENT}`);
  // 입장 확정 ADMITTED면 좌석 화면(같은 출처 /booking/…)으로 페이지를 옮긴다
  await page.waitForURL(/\/booking\//, { timeout: 30_000 });
  const mine = (await requests()).filter((x) => x.path.startsWith(QUEUE));
  expect(mine.filter((x) => x.m === 'OPTIONS'), JSON.stringify(mine)).toEqual([]);
  expect(mine.some((x) => x.m === 'POST' && x.path.endsWith('/entries'))).toBe(true);
  expect(mine.some((x) => x.m === 'POST' && x.path.endsWith('/admission'))).toBe(true);
  expect(mine.some((x) => x.m === 'GET' && x.path.includes('/segment-states/'))).toBe(true);
  // 대조: 사용자 머리가 있는 쓰기는 이 기록에 사전 요청으로 남는다(세는 방법이 엔진마다 사전 요청을 본다)
  await page.goto('/_q/shell.ko.html').catch(() => undefined);
  await page.evaluate((u) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'include' }).catch(() => undefined), `${CHECK_MOCK_ORIGIN}${QUEUE}probe`);
  await expect.poll(async () => (await requests()).filter((x) => x.m === 'OPTIONS' && x.path === `${QUEUE}probe`).length).toBe(1);
});

/** controller.ts의 대기표 지문(FNV-1a)과 같다: 탭 방송 stored의 k */
const fp = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
};

test('FE-T15 AbortSignal.any가 없는 페이지: 진입이 5초에 TimeoutError로 끊기고, 화면 쪽 중단(다른 탭이 새 대기표를 저장)은 문서를 버리지 않고 곧바로 AbortError로 끊는다', async ({ page, browserName }) => {
  await state('queueEntry=hang');
  await page.addInitScript(() => {
    delete AbortSignal.any;
    // 화면 코드가 받은 fetch 거절의 이름을 남긴다(대체 경로가 화면 신호·타이머 신호의 이유를 넘기는지)
    const orig = window.fetch;
    window.__rejections = [];
    window.fetch = function (...a) {
      return orig.apply(this, a).catch((e) => {
        window.__rejections.push({ url: String(a[0]), name: e?.name ?? String(e) });
        throw e;
      });
    };
  });
  await seed(page, preverify());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/queue/${EVENT}`);
  expect(await page.evaluate(() => typeof AbortSignal.any)).toBe('undefined');
  const posts = async () => (await requests()).filter((x) => x.m === 'POST' && x.path === `${QUEUE}entries`);
  await expect.poll(async () => (await posts()).filter((x) => typeof x.abortedAt === 'number').length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  const first = (await posts())[0];
  const held = first.abortedAt - first.at;
  expect(held, '시간 초과 5초 [가정]').toBeGreaterThanOrEqual(4500);
  expect(held).toBeLessThan(8000);
  if (browserName === 'webkit') {
    // WebKit의 fetch는 신호의 이유를 넘기지 않고 늘 AbortError로 거절한다. 화면 코드(net.ts guarded)가 신호의 이유로 바꿔 던지는 것은 단위 시험이 본다
    test.info().annotations.push({ type: 'WebKit 한계', description: 'fetch 거절 이름은 늘 AbortError(시간 초과 이유를 넘기지 않음)' });
  } else expect(await page.evaluate(() => window.__rejections.map((r) => r.name))).toContain('TimeoutError');
  // 다시 보낸 진입이 걸려 있는 동안, 같은 브라우저의 다른 탭이 새 대기표를 저장하고 방송한다 → 이 탭은 진행 중 일을 끊고 저장소에서 다시 시작한다
  await expect.poll(async () => (await posts()).some((x) => x.abortedAt === undefined), { timeout: 15_000 }).toBe(true);
  const other = await page.context().newPage();
  await other.goto('/_q/nothing');
  const ticket = { queueTicket: 'qt-fe-t15', seq: 5, generation: 1, segment: 0 };
  const stoppedAt = Date.now();
  await other.evaluate(([k, t, e, key]) => {
    localStorage.setItem(k, JSON.stringify({ ticket: t, savedAt: Date.now() }));
    new BroadcastChannel(`peaket.queue.${e}`).postMessage({ t: 'stored', k: key });
  }, [KEY, ticket, EVENT, `t:${fp(ticket.queueTicket)}:${ticket.seq}`]);
  await expect.poll(async () => (await posts()).every((x) => typeof x.abortedAt === 'number'), { timeout: 5_000 }).toBe(true);
  const second = (await posts()).at(-1);
  expect(second.abortedAt - stoppedAt, '화면 신호로 곧바로 끊는다(5초 시간 초과가 아니다)').toBeLessThan(1500);
  await expect.poll(async () => page.evaluate(() => window.__rejections.filter((r) => r.name === 'AbortError').length)).toBeGreaterThanOrEqual(1);
  expect(page.url(), '문서를 버리지 않았다').toContain(`/queue/${EVENT}`);
  expect(errors).toEqual([]);
  await other.close();
});

test('FE-T4 대기 폴링 간격: 예상 60초 안은 0.5초 안팎, 300초 안은 5초 안팎이다', async ({ page }) => {
  test.setTimeout(120_000);
  await state('queueAhead=20&queueRate=1');
  await seed(page, preverify());
  await page.goto(`/queue/${EVENT}`);
  await expect.poll(async () => fileGets(await requests()).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(8);
  const near = gaps(fileGets(await requests()).slice(2));
  expect(Math.max(...near), JSON.stringify(near)).toBeLessThan(1500);
  expect(Math.min(...near), '0.5초 −20% 아래로 쉬지 않고 묻지 않는다').toBeGreaterThanOrEqual(350);

  await page.goto('about:blank');
  await state('queueReset=1&logReset=1&queueAhead=150&queueRate=1');
  const ctx = await page.context().browser().newContext();
  const p2 = await ctx.newPage();
  await seed(p2, preverify());
  await p2.goto(`/queue/${EVENT}`);
  await expect.poll(async () => fileGets(await requests()).length, { timeout: 45_000 }).toBeGreaterThanOrEqual(6);
  await ctx.close();
  // 처음 몇 번(진입 직후 바로 묻기, 페이지가 보이게 될 때 깨워 묻기)은 빼고 정상 상태인 마지막 세 간격을 본다
  const mid = gaps(fileGets(await requests())).slice(-3);
  for (const g of mid) {
    expect(g, JSON.stringify(mid)).toBeGreaterThanOrEqual(3800);
    expect(g, JSON.stringify(mid)).toBeLessThanOrEqual(6500);
  }
});

test('FE-T4 숨긴 탭은 가까워도 5초 이상(위로만 20%) 간격이고, 200 응답의 Retry-After는 쓰지 않는다', async ({ browser }) => {
  // 숨긴 탭: 실제 숨김을 만들 수 없어 visibilityState를 덮는다(실제 숨긴 탭의 타이머 제한은 재현하지 못한다)
  await state('queueAhead=30&queueRate=1');
  const ctx = await browser.newContext();
  const hidden = await ctx.newPage();
  await hidden.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { get: () => true });
  });
  await seed(hidden, preverify());
  await hidden.goto(`/queue/${EVENT}`);
  await expect.poll(async () => fileGets(await requests()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  const h = gaps(fileGets(await requests()).slice(1));
  for (const g of h) expect(g, JSON.stringify(h)).toBeGreaterThanOrEqual(4900);
  await ctx.close();

  // 보이는 탭 + 200 대기 상태 파일의 Retry-After 30초: 간격은 그대로 0.5초 안팎(쓰지 않는다)
  await state('queueReset=1&logReset=1&queueAhead=30&queueRate=1&queueStateRetryAfter=30');
  const ctx2 = await browser.newContext();
  const visible = await ctx2.newPage();
  await seed(visible, preverify());
  await visible.goto(`/queue/${EVENT}`);
  await expect.poll(async () => fileGets(await requests()).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(8);
  const v = gaps(fileGets(await requests()).slice(2));
  expect(Math.max(...v), JSON.stringify(v)).toBeLessThan(1500);
  expect(Math.min(...v)).toBeGreaterThanOrEqual(350);
  await ctx2.close();
});

/** 창 60초 안 5~15초 지연이 나오는 고정 토큰(결정적으로 고른다: 시험마다 같은 값) */
function fixedLobbyToken(spreadSec) {
  for (let n = 0; ; n++) {
    const token = `lt-fe-t4-${n}`;
    const h = createHash('sha256').update(token, 'utf8').digest('hex');
    const delay = Number.parseInt(h.slice(4, 12), 16) % (spreadSec * 1000);
    if (delay >= 5000 && delay <= 15_000) return { token, h, delay };
  }
}

test('FE-T4 셔플 결과 파일은 발표 시각 + 토큰 해시로 정한 고정 지연에 받는다(분산 창 60초, 같은 토큰이면 어느 탭이든 같은 시각)', async ({ browser }) => {
  test.setTimeout(90_000);
  const spreadSec = 60;
  const { token, h, delay } = fixedLobbyToken(spreadSec);
  await state('queueOpenIn=2');
  const resultAt = Date.now() + 3000;
  const rec = { lobby: { lobbyToken: token, seedHash: 'a'.repeat(64), shuffleResultAtMs: resultAt, shuffleSpreadSec: spreadSec } };
  // 문맥 둘(저장소가 따로)이 같은 토큰으로 기다린다
  const ctxs = [await browser.newContext(), await browser.newContext()];
  for (const c of ctxs) {
    const pg = await c.newPage();
    await seed(pg, rec);
    await pg.goto(`/queue/${EVENT}`);
  }
  const path = `${QUEUE}shuffle-results/${h.slice(0, 3)}.json`;
  const gets = async () => (await requests()).filter((x) => x.m === 'GET' && x.path === path);
  await expect.poll(async () => (await gets()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  const [a, b] = (await gets()).map((x) => x.at);
  // 같은 PC의 벽시계라(로비 경로는 서버 시각 표본을 받지 않아 보정이 0) 오차는 타이머 지연뿐이다
  for (const at of [a, b]) {
    expect(at - (resultAt + delay), `지연 ${delay}ms`).toBeGreaterThanOrEqual(-100);
    expect(at - (resultAt + delay)).toBeLessThanOrEqual(800);
  }
  expect(Math.abs(a - b), '같은 토큰이면 같은 시각').toBeLessThanOrEqual(800);
  for (const c of ctxs) await c.close();
});
