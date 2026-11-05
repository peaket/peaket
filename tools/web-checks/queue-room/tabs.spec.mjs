// 대기실 여러 탭 세 엔진 검사(FE-T6, ADR-0218, BUILD_ORDER HOT-348): 같은 브라우저 문맥(저장소·Web Locks·BroadcastChannel을 나눠 쓴다)의
// 탭 셋으로 리더 하나·리더 숨김 뒤 넘김·모든 탭 숨김·방송 끊김·숨긴 채 차례를 본다. 탭마다 fetch를 감싸 자기 요청을 센다.
// 숨김은 visibilityState를 덮어 흉내 낸다(실제 숨긴 탭의 타이머 제한은 재현하지 못한다, ADR-0217 결정 4).
// 복제한 탭에서 구매(일련번호 역전 0)는 구매 세션 서명 단계(HOT-360) 몫이다.
import { test, expect } from '@playwright/test';
import { CHECK_MOCK_ORIGIN } from './origins.mjs';

const EVENT = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e04';
const KEY = `peaket.queue.${EVENT}`;

const state = async (q) => expect((await fetch(`${CHECK_MOCK_ORIGIN}/__mock/state?${q}`)).status).toBe(200);

/** 탭 하나를 연다. hidden이면 처음부터 숨김. muted면 이 탭의 대기열 방송을 보내지 않는다(리더가 멈춰 방송이 끊긴 흉내) */
async function openTab(ctx, { hidden = false, muted = false } = {}) {
  const page = await ctx.newPage();
  await page.addInitScript(([h, m, event]) => {
    if (location.protocol !== 'http:') return;
    let hid = h;
    Object.defineProperty(document, 'visibilityState', { get: () => (hid ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { get: () => hid });
    window.__setHidden = (v) => {
      hid = v;
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    };
    // 이 탭이 보낸 대기 상태 파일 GET·입장 확정 POST의 시각
    window.__net = [];
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const url = String(input);
      if (url.includes('/segment-states/')) window.__net.push({ k: 'poll', at: Date.now() });
      if (url.endsWith('/admission')) window.__net.push({ k: 'admit', at: Date.now() });
      return orig.call(this, input, init);
    };
    // 리더 멈춤 흉내: 켜면 이 탭의 대기열 방송을 보내지 않는다(폴링은 이어 간다). 처음부터 켜거나 window.__mute()로 도중에 켠다
    let muted = m;
    window.__mute = () => (muted = true);
    const post = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (msg) {
      if (muted && this.name === `peaket.queue.${event}`) return undefined;
      return post.call(this, msg);
    };
  }, [hidden, muted, EVENT]);
  return page;
}
const net = (page) => page.evaluate(() => window.__net.slice());
const pollsSince = async (page, t) => (await net(page)).filter((x) => x.k === 'poll' && x.at >= t).length;
const ahead = (page) => page.locator('[data-q="ahead"]').getAttribute('data-v');
/** 폴링 리더 잠금(queue-poll:{회차})의 쥔 수·기다리는 수(같은 문맥의 모든 탭) */
const lockState = (page) =>
  page.evaluate(async (name) => {
    const q = await navigator.locks.query();
    return { held: q.held.filter((l) => l.name === name).length, pending: q.pending.filter((l) => l.name === name).length };
  }, `queue-poll:${EVENT}`);
/** 화면이 1초마다 바뀌므로(파일 생성 시각) 그리기 틈을 두고 탭들이 같은 값을 그릴 때까지 본다 */
const sameAhead = (tabs) => expect.poll(async () => new Set(await Promise.all(tabs.map(ahead))).size, { timeout: 3000 }).toBe(1);

/** 가짜 API에서 실제 대기표를 받아(앞 인원 ahead) 그 문맥의 저장소에 둔다. 그 문맥의 탭들이 같은 대기표를 쓴다 */
async function withTicket(ctx, ahead) {
  await state(`queueAhead=${ahead}`);
  const r = await fetch(`${CHECK_MOCK_ORIGIN}/v1/queues/${EVENT}/entries`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ preverifyToken: `pv-fe-t6-${Math.random().toString(36).slice(2)}` }) });
  expect(r.status).toBe(201);
  const b = await r.json();
  const p = await ctx.newPage();
  await p.goto('/_q/nothing');
  await p.evaluate(([k, t]) => localStorage.setItem(k, JSON.stringify({ ticket: t, savedAt: Date.now() })), [KEY, { queueTicket: b.queueTicket, seq: b.seq, generation: b.generation, segment: b.segment }]);
  await p.close();
}

test.beforeEach(async () => {
  await state('queueReset=1&logReset=1&queue=on-sale&queueEntry=normal&queueAdmit=normal&queueStateRetryAfter=&queueOpenIn=');
});

test('FE-T6 보이는 탭 셋: 폴링 리더는 하나이고, 나머지는 방송으로 같은 앞 인원을 그린다', async ({ browser }) => {
  await state('queueRate=1');
  const ctx = await browser.newContext();
  await withTicket(ctx, 40); // 앞 40명 ÷ 1 → 0.5초 간격
  const tabs = [];
  for (let i = 0; i < 3; i++) {
    const t = await openTab(ctx);
    await t.goto(`/queue/${EVENT}`);
    tabs.push(t);
  }
  await tabs[2].waitForTimeout(3000);
  const t0 = Date.now();
  await tabs[0].waitForTimeout(6000);
  const counts = await Promise.all(tabs.map((t) => pollsSince(t, t0)));
  expect(counts.filter((n) => n > 0).length, `탭별 폴링 ${counts}`).toBe(1);
  expect(Math.max(...counts), `${counts}`).toBeGreaterThanOrEqual(8);
  expect(await lockState(tabs[0]), '리더 하나가 쥐고 보이는 두 탭이 기다린다').toEqual({ held: 1, pending: 2 });
  await sameAhead(tabs);
  await ctx.close();
});

test('FE-T6 리더를 숨기면 1초 안팎에 보이는 탭이 리더가 되어 자기 간격으로 묻고, 숨긴 탭은 묻지 않는다', async ({ browser }) => {
  await state('queueRate=1');
  const ctx = await browser.newContext();
  await withTicket(ctx, 60);
  const a = await openTab(ctx);
  await a.goto(`/queue/${EVENT}`);
  await a.waitForTimeout(2000);
  const b = await openTab(ctx);
  await b.goto(`/queue/${EVENT}`);
  await b.waitForTimeout(3000);
  const before = Date.now();
  expect(await pollsSince(a, before - 2000), 'a가 리더').toBeGreaterThan(0);
  expect(await pollsSince(b, before - 2000), 'b는 리더가 아니다').toBe(0);
  expect(await lockState(a), '숨기기 전: a가 쥐고 b가 기다린다').toEqual({ held: 1, pending: 1 });
  const hiddenAt = Date.now();
  await a.evaluate(() => window.__setHidden(true));
  // 숨긴 a는 잠금을 놓고 다시 청하지 않으며, b가 받는다(방송이 오래됐다는 대체 규칙으로 묻는 것과 가린다)
  await expect.poll(() => lockState(b), { timeout: 2000 }).toEqual({ held: 1, pending: 0 });
  await expect.poll(async () => (await net(b)).find((x) => x.k === 'poll' && x.at >= hiddenAt)?.at ?? null, { timeout: 5000 }).not.toBeNull();
  const first = (await net(b)).find((x) => x.k === 'poll' && x.at >= hiddenAt).at;
  expect(first - hiddenAt, '넘김까지 1초 [가정](FE-T6)').toBeLessThan(1000);
  await b.waitForTimeout(4000);
  expect(await pollsSince(b, hiddenAt), '보이는 새 리더는 자기 간격(0.5초)으로').toBeGreaterThanOrEqual(5);
  // 숨겨지는 순간의 옛 리더는 받은 방송이 없어 한 번은 물을 수 있다. 그 뒤로는 새 리더의 방송이 자기 간격의 2배 안이라 묻지 않는다
  expect(await pollsSince(a, hiddenAt), '숨긴 탭은 많아야 한 번').toBeLessThanOrEqual(1);
  await ctx.close();
});

test('FE-T6 모든 탭이 숨겨지면 리더가 없고, 묻기는 숨긴 간격(5초)마다 대개 한 번이다', async ({ browser }) => {
  await state('queueRate=1');
  const ctx = await browser.newContext();
  await withTicket(ctx, 60);
  const tabs = [];
  for (let i = 0; i < 3; i++) {
    const t = await openTab(ctx, { hidden: true });
    await t.goto(`/queue/${EVENT}`);
    tabs.push(t);
  }
  await tabs[0].waitForTimeout(6000);
  const t0 = Date.now();
  await tabs[0].waitForTimeout(16_000);
  expect(await lockState(tabs[0]), '모두 숨기면 리더가 없다(아무도 청하지 않는다)').toEqual({ held: 0, pending: 0 });
  const counts = await Promise.all(tabs.map((t) => pollsSince(t, t0)));
  const total = counts.reduce((x, y) => x + y, 0);
  // 16초 ÷ 5~6초 → 탭 하나라면 3번 안팎. 셋이 모두 제 간격으로 물으면 9번 안팎이다
  expect(total, `탭별 ${counts}`).toBeGreaterThanOrEqual(2);
  expect(total, `탭별 ${counts}`).toBeLessThanOrEqual(5);
  await ctx.close();
});

test('FE-T6 리더가 멈춰 방송이 끊기면 보이는 탭이 자기 간격의 2배 뒤에 스스로 묻고, 다른 탭은 그 방송으로 같은 값을 그린다', async ({ browser }) => {
  await state('queueRate=1');
  const ctx = await browser.newContext();
  await withTicket(ctx, 60);
  const leader = await openTab(ctx);
  await leader.goto(`/queue/${EVENT}`);
  await leader.waitForTimeout(2000);
  const others = [];
  for (let i = 0; i < 2; i++) {
    const t = await openTab(ctx);
    await t.goto(`/queue/${EVENT}`);
    others.push(t);
  }
  await others[1].waitForTimeout(3000);
  const t0 = Date.now();
  await others[1].waitForTimeout(2000);
  for (const t of others) expect(await pollsSince(t, t0), '방송이 살아 있으면 리더만 묻는다').toBe(0);
  // 리더가 멈춘다(방송만 끊기고 리더 잠금은 그대로)
  const mutedAt = Date.now();
  await leader.evaluate(() => window.__mute());
  await expect.poll(async () => {
    const firsts = await Promise.all(others.map(async (t) => (await net(t)).find((x) => x.k === 'poll' && x.at >= mutedAt)?.at ?? null));
    return firsts.filter((x) => x !== null).sort()[0] ?? null;
  }, { timeout: 5000 }).not.toBeNull();
  const firsts = await Promise.all(others.map(async (t) => (await net(t)).find((x) => x.k === 'poll' && x.at >= mutedAt)?.at ?? Infinity));
  // 마지막 방송 뒤 자기 간격(0.5초 ±20%)의 2배 + 판단 주기 한 번 안
  expect(Math.min(...firsts) - mutedAt, '스스로 묻기까지').toBeLessThan(2000);
  await others[1].waitForTimeout(4000);
  const counts = await Promise.all(others.map((t) => pollsSince(t, mutedAt)));
  expect(counts.reduce((x, y) => x + y, 0), `리더 아닌 탭들의 묻기 ${counts}`).toBeGreaterThanOrEqual(4);
  await sameAhead(others);
  await ctx.close();
});

test('FE-T6 차례가 오면 입장 확정은 보이는 리더만 한 번 보낸다(보이는 다른 탭·숨긴 탭은 보내지 않는다)', async ({ browser }) => {
  await state('queueRate=5');
  const ctx = await browser.newContext();
  await withTicket(ctx, 15); // 약 3초 뒤 차례
  const leader = await openTab(ctx);
  await leader.goto(`/queue/${EVENT}`);
  await leader.waitForTimeout(1500);
  const visible = await openTab(ctx);
  await visible.goto(`/queue/${EVENT}`);
  const hidden = await openTab(ctx, { hidden: true });
  await hidden.goto(`/queue/${EVENT}`);
  await leader.waitForURL(/\/booking\//, { timeout: 30_000 });
  await visible.waitForTimeout(1500);
  const admits = async (t) => (t.url().includes('/booking/') ? -1 : (await net(t)).filter((x) => x.k === 'admit').length);
  expect(await admits(visible), '보이는 다른 탭은 보내지 않는다').toBe(0);
  expect(await admits(hidden), '숨긴 탭은 보내지 않는다').toBe(0);
  const log = (await (await fetch(`${CHECK_MOCK_ORIGIN}/__mock/requests`)).json()).items;
  expect(log.filter((x) => x.m === 'POST' && x.path.endsWith('/admission')).length, '입장 확정은 한 번').toBe(1);
  await ctx.close();
});

test('FE-T6 모든 탭이 숨긴 채 차례가 오면 아무도 보내지 않고 차례 도래 유예를 보이며, 한 탭이 보이게 되면 그 탭이 리더가 되어 바로 보낸다', async ({ browser }) => {
  await state('queueRate=5');
  const ctx = await browser.newContext();
  await withTicket(ctx, 10); // 약 2초 뒤 차례
  const tabs = [];
  for (let i = 0; i < 2; i++) {
    const t = await openTab(ctx, { hidden: true });
    await t.goto(`/queue/${EVENT}`);
    tabs.push(t);
  }
  await tabs[0].waitForTimeout(8000);
  const posts = async () => (await (await fetch(`${CHECK_MOCK_ORIGIN}/__mock/requests`)).json()).items.filter((x) => x.m === 'POST' && x.path.endsWith('/admission'));
  expect(await posts(), '보이는 탭이 없으면 숨긴 탭은 입장 확정을 보내지 않는다').toEqual([]);
  await expect(tabs[0].getByRole('heading', { name: '차례가 되었습니다' })).toBeVisible();
  const shownAt = Date.now();
  await tabs[1].evaluate(() => window.__setHidden(false));
  await expect.poll(async () => (await posts()).length, { timeout: 3000 }).toBe(1);
  expect((await posts())[0].at - shownAt, '보이게 된 탭이 1초 [가정] 안에 보낸다').toBeLessThan(1000);
  await tabs[1].waitForURL(/\/booking\//, { timeout: 10_000 });
  await ctx.close();
});

test('FE-T6 탭 방송은 대기표 지문으로 거른다: 다른 대기표의 입장 결과는 무시하고, 같은 대기표의 입장 결과면 이 탭을 끝낸다', async ({ browser }) => {
  await state('queueRate=1');
  const ctx = await browser.newContext();
  await withTicket(ctx, 60);
  const tab = await openTab(ctx);
  await tab.goto(`/queue/${EVENT}`);
  await expect(tab.locator('[data-q="ahead"]')).toBeVisible();
  const helper = await ctx.newPage();
  await helper.goto('/_q/nothing');
  const send = (msg) => helper.evaluate(([e, m]) => new BroadcastChannel(`peaket.queue.${e}`).postMessage(m), [EVENT, msg]);
  await send({ t: 'result', k: 't:deadbeef:1', state: 'admitted' });
  await tab.waitForTimeout(1500);
  await expect(tab.locator('[data-q="ahead"]'), '다른 대기표의 결과는 무시한다').toBeVisible();
  const rec = await tab.evaluate((k) => JSON.parse(localStorage.getItem(k)).ticket, KEY);
  const fpOf = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  };
  await send({ t: 'result', k: `t:${fpOf(rec.queueTicket)}:${rec.seq}`, state: 'admitted' });
  await expect(tab.getByText('이미 다른 기기나 탭의 대기표로 입장했습니다'), '같은 대기표면 이 탭은 중복 안내로 끝난다').toBeVisible({ timeout: 3000 });
  await ctx.close();
});
