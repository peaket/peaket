// 대기열 교차 출처 브라우저 시험 Q-T41 ①②④⑦(docs/features/queue-admission.md §3 '요청 형식'·'응답 헤더', §11 Q-T41, BUILD_ORDER HOT-400, 묶음 BAT-055 계획 §6의 'B' 층).
// kind의 gw-queue(대역 백엔드)에 실제 브라우저 셋(Chromium·Firefox·WebKit, tools/web-checks의 Playwright)으로 닿는다.
// - 페이지는 시험이 그 출처 주소로 바로 채워 준다(page.route). 그래서 페이지의 출처는 접속 정보의 www 출처(허용) 또는 목록 밖 출처다.
//   페이지를 연 뒤 가로채기를 끈다(page.unroute). 그 뒤의 fetch·사전 요청은 모두 실제 네트워크(CONNECT 프록시 → 게이트웨이)로 간다.
// - 브라우저의 HTTPS 요청은 시험 안의 CONNECT 프록시가 호스트 이름으로 게이트웨이 포트 전달(127.0.0.1)에 잇는다(로컬 이름을 OS에 등록하지 않는다).
// - 사전 요청(OPTIONS)이 나갔는지는 브라우저 밖에서 본다: gw-queue 접근 로그에 그 회차 경로의 OPTIONS 줄이 있는지(브라우저 개발 도구는 사전 요청을 늘 보이지 않는다).
// 접속 정보·대역 백엔드의 약속은 gateway-client.mjs 머리에 있다. ⑤(Origin 없이 Sec-Fetch-Site: cross-site)는 브라우저가 Origin을 빼게 할 수 없어 gateways.e2e.mjs가 본다.
// 실행(저장소 뿌리, Docker 차례 잠금을 잡고): node tools/local/cluster.mjs up && node tools/local/cluster.mjs gateways
//   && (cd tools/web-checks && pnpm install --frozen-lockfile && npx playwright install chromium firefox webkit) && node --test tools/local/e2e/queue-cors.e2e.mjs
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GATEWAY_OF_HOST, accessLog, loadContract, send, token } from './gateway-client.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const BROWSERS = ['chromium', 'firefox', 'webkit'];
const MAX_AGE = '7200';
let c;
let pw;
let proxy;
let proxyPort;

before(async () => {
  c = loadContract();
  // Playwright는 tools/web-checks 작업 공간의 것을 쓴다(뿌리 작업 공간에 넣지 않는다)
  const req = createRequire(join(REPO, 'tools', 'web-checks', 'package.json'));
  // CJS 꾸러미라 ESM으로 읽으면 chromium·firefox·webkit이 default 아래에 있다(2026-11-16 kind 실패 확인에서 드러남)
  const mod = await import(pathToFileURL(req.resolve('@playwright/test')).href);
  pw = mod.default ?? mod;
  // 호스트 이름 → 게이트웨이 포트 전달
  const portOf = new Map(Object.entries(c.hosts).map(([key, host]) => [host, c.ports[GATEWAY_OF_HOST[key]]]));
  proxy = http.createServer((_q, s) => s.writeHead(405).end());
  proxy.on('connect', (q, socket, head) => {
    const [host] = String(q.url).split(':');
    const port = portOf.get(host);
    if (!port) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const up = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = proxy.address().port;
});

after(() => proxy?.close());

/** 브라우저 하나와 그 출처의 빈 페이지 */
async function openPage(name, origin) {
  const type = pw[name];
  const browser = await type.launch({
    proxy: { server: `http://127.0.0.1:${proxyPort}` },
    // 로컬 이름(*.localhost 등)도 프록시를 거치게 한다
    ...(name === 'chromium' ? { args: ['--proxy-bypass-list=<-loopback>'] } : {}),
    ...(name === 'firefox' ? { firefoxUserPrefs: { 'network.proxy.allow_hijacking_localhost': true } } : {}),
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const sub = `acc-${RUN}-${name}-${randomBytes(2).toString('hex')}`;
  const at = token(c, 'fan', { sub, sid: `s-${sub}`, aud: 'fan', scope: 'ticket:buy', pid: `p-${sub}` });
  // 쿠키 이름과 꼴은 정본(identity §3) 그대로. 이 시험은 교차 출처 형식을 보므로 같은 사이트 판정에 기대지 않게 SameSite=None으로 싣는다
  // 대기열(queue)과 팬 API(api) 두 호스트에 싣는다(api 쪽은 웨이브 끝 리뷰 W7-COR-01·W7-WIR-04 시험이 쓴다)
  await context.addCookies([c.hosts.queue, c.hosts.api].map((domain) => ({ name: '__Secure-peaket_at', value: at, domain, path: '/', secure: true, httpOnly: true, sameSite: 'None' })));
  const page = await context.newPage();
  const url = `${origin}/__e2e__/queue-cors.html`;
  await page.route(url, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>e2e</title>' }));
  await page.goto(url);
  // 가로채기를 끈다. 가로채기가 켜져 있으면 Playwright(1.64)가 Chromium의 CORS 사전 요청을 네트워크로 보내지 않고 스스로 채운다
  // (playwright-core coreBundle.js isInterceptedOptionsPreflight, 요청 Origin을 그대로 허용). 그러면 게이트웨이의 CORS와 'OPTIONS가 나갔는가'를
  // 볼 수 없다. 끈 뒤에는 세 브라우저 모두 실제 네트워크로 사전 요청을 보낸다(계획 '시험 이의' 시험 담당 판단, 2026-11-16)
  await page.unroute(url);
  return { browser, page };
}

/** 페이지 안 fetch. 읽으면 { status, retryAfter, text }, 읽지 못하면 { error } */
const pageFetch = (page, url, init) =>
  page.evaluate(
    async ([u, i]) => {
      try {
        const r = await fetch(u, i);
        return { status: r.status, retryAfter: r.headers.get('retry-after'), text: await r.text() };
      } catch (e) {
        return { error: String(e) };
      }
    },
    [url, init],
  );

const queueUrl = (path) => `https://${c.hosts.queue}${path}`;
const apiUrl = (path) => `https://${c.hosts.api}${path}`;
const filesUrl = (path) => `https://${c.hosts['queue-files']}${path}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** gw-queue 접근 로그에서 그 회차 경로의 줄(메서드 값으로 고름) */
async function linesFor(event, { want = 1, timeoutMs = 20_000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const lines = (await accessLog(c, 'gw-queue')).filter((l) => Object.values(l).some((v) => typeof v === 'string' && v.includes(`/v1/queues/${event}/`)));
    if (lines.length >= want || Date.now() > until) return lines;
    await sleep(1000);
  }
}
const isMethod = (l, m) => Object.values(l).includes(m);

for (const name of BROWSERS) {
  test(`Q-T41 ① www 페이지의 text/plain 진입·입장 확정은 OPTIONS 없이 응답을 읽는다(${name})`, async () => {
    const event = `e2e-${RUN}-${name}-1`;
    const { browser, page } = await openPage(name, c.origins.www);
    try {
      for (const path of [`/v1/queues/${event}/entries`, `/v1/queues/${event}/admission`]) {
        const r = await pageFetch(page, queueUrl(path), { method: 'POST', credentials: 'include', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ requestId: `r-${RUN}`, deviceId: 'dev-e2e' }) });
        assert.equal(r.error, undefined, `${name} ${path}: 응답을 읽지 못했다 ${r.error}`);
        assert.ok(r.status < 400, `${name} ${path}: ${r.status}`);
        assert.equal(JSON.parse(r.text).method, 'POST');
      }
    } finally {
      await browser.close();
    }
    const lines = await linesFor(event, { want: 2 });
    assert.equal(lines.filter((l) => isMethod(l, 'POST')).length, 2, `${name}: 진입·입장 확정 줄`);
    assert.equal(lines.filter((l) => isMethod(l, 'OPTIONS')).length, 0, `${name}: 사전 요청이 나갔다(ADR-0065 되돌릴 조건)`);
  });

  test(`Q-T41 ② application/json 진입은 OPTIONS가 먼저 나가고 사전 요청 응답이 Access-Control-Max-Age: 7200이다(${name})`, async () => {
    const event = `e2e-${RUN}-${name}-2`;
    const { browser, page } = await openPage(name, c.origins.www);
    try {
      const r = await pageFetch(page, queueUrl(`/v1/queues/${event}/entries`), { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.error, undefined, `${name}: 허용 출처의 사전 요청 뒤 응답을 읽지 못했다 ${r.error}`);
    } finally {
      await browser.close();
    }
    const lines = await linesFor(event, { want: 2 });
    assert.ok(lines.some((l) => isMethod(l, 'OPTIONS')), `${name}: 사전 요청 줄이 없다`);
    // 사전 요청 응답 머리는 브라우저가 스크립트에 보여 주지 않으므로 같은 사전 요청을 직접 보내 본다
    const pre = await send(c, 'queue', { method: 'OPTIONS', path: `/v1/queues/${event}/entries`, headers: { 'x-peaket-origin-verify': c.originVerify, origin: c.origins.www, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    assert.equal(pre.headers['access-control-max-age'], MAX_AGE);
  });

  test(`Q-T41 ④ 허용 목록 밖 출처 페이지의 진입은 403이고 응답을 읽지 못한다(${name})`, async () => {
    const outside = [...Object.entries(c.origins).filter(([k]) => k !== 'www').map(([, v]) => v), 'https://evil.example'];
    for (const [i, origin] of outside.entries()) {
      const event = `e2e-${RUN}-${name}-4-${i}`;
      const { browser, page } = await openPage(name, origin);
      try {
        const r = await pageFetch(page, queueUrl(`/v1/queues/${event}/entries`), { method: 'POST', credentials: 'include', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: '{}' });
        assert.ok(r.error, `${name} ${origin}: 응답을 읽었다(${r.status})`);
      } finally {
        await browser.close();
      }
      const lines = await linesFor(event);
      assert.ok(lines.length > 0, `${name} ${origin}: 요청 줄이 없다`);
      assert.ok(lines.every((l) => Object.values(l).some((v) => String(v) === '403')), `${name} ${origin}: 403이 아니다 ${JSON.stringify(lines)}`);
    }
  });

  test(`Q-T41 ⑦ www에서 queue-files 파일과 Retry-After를 읽고 Access-Control-Allow-Credentials가 없다(${name})`, async () => {
    const event = `e2e-${RUN}-${name}-7`;
    const { browser, page } = await openPage(name, c.origins.www);
    try {
      const url = filesUrl(`/v1/queues/${event}/segment-states/0.json?e2e-status=503&e2e-header=retry-after:3`);
      const r = await pageFetch(page, url, { credentials: 'omit', cache: 'no-store' });
      assert.equal(r.error, undefined, `${name}: 파일을 읽지 못했다 ${r.error}`);
      assert.equal(r.status, 503);
      assert.equal(r.retryAfter, '3', `${name}: Retry-After를 스크립트가 읽지 못한다`);
      // 쿠키를 실은 요청은 Allow-Credentials가 없어 브라우저가 응답을 막는다
      const withCookies = await pageFetch(page, url, { credentials: 'include', cache: 'no-store' });
      assert.ok(withCookies.error, `${name}: credentials include 응답을 읽었다(Allow-Credentials가 있다)`);
    } finally {
      await browser.close();
    }
  });
}

// ===================== 웨이브 끝 리뷰 반영(계획 §15): 구매 경로의 사전 요청과 api의 Retry-After =====================

for (const name of BROWSERS) {
  test(`W7-COR-01 www 페이지에서 X-Admission-Token·X-Purchase-Seq·X-Purchase-Mac·Idempotency-Key를 단 POST /v1/events/{id}/holds와 X-Client-Ephemeral-Key를 단 GET …/seatmap-snapshot은 사전 요청 뒤 응답을 읽는다(${name})`, async () => {
    const event = `e2e-${RUN}-${name}-w7`;
    const { browser, page } = await openPage(name, c.origins.www);
    try {
      const hold = await pageFetch(page, apiUrl(`/v1/events/${event}/holds`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-admission-token': 'e2e-admission', 'x-purchase-seq': '1', 'x-purchase-mac': 'e2e-mac', 'idempotency-key': `idem-${RUN}-${name}` },
        body: '{}',
      });
      assert.equal(hold.error, undefined, `${name} 홀드: 사전 요청 뒤 응답을 읽지 못했다 ${hold.error}`);
      assert.ok(hold.status < 400, `${name} 홀드: ${hold.status}`);
      assert.equal(JSON.parse(hold.text).method, 'POST');
      const snap = await pageFetch(page, apiUrl(`/v1/events/${event}/seatmap-snapshot`), { credentials: 'include', headers: { 'x-admission-token': 'e2e-admission', 'x-client-ephemeral-key': 'e2e-key' } });
      assert.equal(snap.error, undefined, `${name} 스냅샷: 사전 요청 뒤 응답을 읽지 못했다 ${snap.error}`);
      assert.ok(snap.status < 400, `${name} 스냅샷: ${snap.status}`);
    } finally {
      await browser.close();
    }
  });

  test(`W7-WIR-04 www 페이지가 api의 429 응답의 Retry-After를 읽는다(${name})`, async () => {
    const event = `e2e-${RUN}-${name}-w7r`;
    const { browser, page } = await openPage(name, c.origins.www);
    try {
      const path = c.probes['gw-fan'].path.replaceAll('{event}', event);
      const r = await pageFetch(page, apiUrl(`${path}?e2e-status=429&e2e-header=retry-after:7`), { credentials: 'include', cache: 'no-store' });
      assert.equal(r.error, undefined, `${name}: 응답을 읽지 못했다 ${r.error}`);
      assert.equal(r.status, 429);
      assert.equal(r.retryAfter, '7', `${name}: Retry-After를 스크립트가 읽지 못한다`);
    } finally {
      await browser.close();
    }
  });
}
