#!/usr/bin/env node
// K5 랩 판정(S-T15의 v0 쪽, docs/verification.md §3.10 K5, docs/frontend.md §5.8). 저장소 뿌리에서 돌린다.
//   node loadtest/k5/seatmap-lab.mjs [--reps 20] [--throttle 4] [--chrome <chrome.exe>] [--record --run-id <ID>] [--out <폴더>]
// - 먼저 kind와 v0를 올린다(node tools/local/cluster.mjs up && node tools/local/cluster.mjs v0). 입구를 127.0.0.1:8443으로 연다(포트 전달.
//   입구가 받는 쓰기 출처가 https://127.0.0.1:8443이라 포트를 바꾸지 않는다). 부하 실행과 함께 돌리지 않는다
// - 5만 석 회차를 열고 시험 계정 하나를 진입·입장시킨 뒤, 머리 없는 Chrome(이 PC의 Playwright Chromium)을 개발자 도구 규약(CDP)으로 움직인다.
//   회마다 새 브라우저 맥락에서: 중급 모바일 화면(412×915, 배율 2.625), CPU 4배 느리게 → 좌석맵 열기(그리기 끝 시각) → 계측 비우기 →
//   확대(휠 3번) → 이동(끌기) → 좌석 고르기 → [선택 좌석 잡기] → 값 읽기(INP·LCP·CLS·LoAF·긴 작업·GC 뒤 힙) → [놓기]
// - 산출물: .cache/peaket-loadtest/<날짜>-k5-<꼬리표>/(rows.json·lab.json·infra.txt). --record면 collect.py로 장부(bench 요약, 점검 INP p75·그리기 p75)
// - Chrome 창은 띄우지 않는다(--headless=new). 'chrome --version'은 창을 띄워 매달리므로 부르지 않고 판은 CDP Browser.getVersion으로 읽는다
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { cpus as osCpus, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KUBECONFIG, V0_NAMESPACE, V0_TOKEN_KEY_FILE, kubectl } from '../../tools/local/cluster.mjs';
import { ensureTool } from '../../tools/local/tools.mjs';
import { loadOrCreateV0TokenKey, signV0Token } from '../../tools/local/v0-token.mjs';
import { ACCESS_COOKIE, accountRef, pidOf, sidOf } from '../lib/users.mjs';
import { inAppPod, seedScript } from '../run.mjs';
import { summarizeLab } from './lab-summary.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'https://127.0.0.1:8443';
const PORT = 8443;
/** 5만 석(10구역 × 50열 × 100석) [가정, K5 '5만석 좌석맵'] */
const GRID = { sections: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K'], rows: 50, perRow: 100 };
const VIEWPORT = { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true };
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

function parse(argv) {
  const o = { reps: 20, throttle: 4, record: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const v = argv[i + 1];
    if (f === '--record') o.record = true;
    else if (f === '--reps' && /^\d+$/.test(v ?? '') && Number(v) >= 1 && Number(v) <= 100) (o.reps = Number(v), i++);
    else if (f === '--throttle' && /^\d+$/.test(v ?? '') && Number(v) >= 1 && Number(v) <= 20) (o.throttle = Number(v), i++);
    else if (f === '--chrome' && v && !v.startsWith('--')) (o.chrome = v, i++);
    else if (f === '--run-id' && /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,80}$/.test(v ?? '')) (o.runId = v, i++);
    else if (f === '--out' && v && !v.startsWith('--')) (o.out = v, i++);
    else throw new Error(`모르는 인자이거나 값이 틀렸다: ${f}`);
  }
  if (o.record !== (o.runId !== undefined)) throw new Error('--record와 --run-id는 함께 준다');
  return o;
}

/** 이 PC의 Playwright Chromium(가장 높은 판) */
function findChrome() {
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const d of dirs) {
    const exe = join(root, d, 'chrome-win64', 'chrome.exe');
    if (existsSync(exe)) return exe;
  }
  throw new Error('Chrome을 찾지 못했다(--chrome으로 준다)');
}

/** 입구 포트 전달(127.0.0.1:8443) */
async function forward() {
  const k = await ensureTool('kubectl');
  const pf = spawn(k, ['--kubeconfig', KUBECONFIG, '-n', V0_NAMESPACE, 'port-forward', '--address', '127.0.0.1', 'svc/v0-gateway', `${PORT}:8443`], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error('입구 포트 전달이 열리지 않았다(8443을 다른 프로그램이 쓰고 있나?)')), 30_000);
    pf.stdout.on('data', (d) => {
      if (/Forwarding from 127\.0\.0\.1:8443/.test(String(d))) (clearTimeout(t), ok());
    });
    pf.on('exit', () => no(new Error('입구 포트 전달이 끝났다')));
  });
  return pf;
}

/** 입구로 보내는 요청(자체 서명 인증서는 CA로 확인한다) */
function gw(method, path, { token, ca, body }) {
  return new Promise((ok, no) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { host: '127.0.0.1', port: PORT, servername: 'localhost', method, path, ca, headers: { cookie: `${ACCESS_COOKIE}=${token}`, origin: ORIGIN, ...(data ? { 'content-type': 'application/json' } : {}) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => ok({ status: res.statusCode, body: text }));
      },
    );
    req.on('error', no);
    req.setTimeout(30_000, () => req.destroy(new Error('입구 요청 시간 초과')));
    if (data) req.write(data);
    req.end();
  });
}

/** 개발자 도구 규약(CDP) 연결 하나: 명령과 사건 */
async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, no) => {
    ws.onopen = ok;
    ws.onerror = () => no(new Error('CDP 연결 실패'));
  });
  let id = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (p) msg.error ? p.no(new Error(`${p.method}: ${msg.error.message}`)) : p.ok(msg.result);
      return;
    }
    for (const w of [...waiters]) {
      if (w.method === msg.method && (w.sessionId === undefined || w.sessionId === msg.sessionId)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.ok(msg.params);
      }
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, no) => {
      const i = ++id;
      pending.set(i, { ok, no, method });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const once = (method, sessionId, timeoutMs = 60_000) =>
    new Promise((ok, no) => {
      const w = { method, sessionId, ok };
      waiters.push(w);
      setTimeout(() => {
        const at = waiters.indexOf(w);
        if (at >= 0) (waiters.splice(at, 1), no(new Error(`${method}을 ${timeoutMs}ms 안에 받지 못했다`)));
      }, timeoutMs).unref();
    });
  return { send, once, close: () => ws.close() };
}

/**
 * 가운데에서 가장 가까운 빈 좌석(R 등급 색 #dc2626 원) 화소의 화면 좌표(CSS px). 캔버스 가운데 240×240 칸만 읽는다(읽기 비용을 작게).
 * 5만 석을 가로로 늘어놓은 띠라, 끌기 뒤에는 가운데가 띠 밖일 수 있다(2026-11-03 리허설)
 */
const FIND_SEAT = `(() => {
  const c = document.getElementById('map');
  const g = c.getContext('2d');
  const r = c.getBoundingClientRect();
  const W = c.width, H = c.height, cx = W / 2, cy = H / 2, R = 120;
  const x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R));
  const w = Math.min(W - x0, 2 * R), h = Math.min(H - y0, 2 * R);
  const d = g.getImageData(x0, y0, w, h).data;
  let best = null, bd = Infinity;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (d[i + 3] >= 250 && d[i] > 180 && d[i + 1] < 80 && d[i + 2] < 80) {
      const dist = (x + x0 - cx) ** 2 + (y + y0 - cy) ** 2;
      if (dist < bd) { bd = dist; best = [x + x0, y + y0]; }
    }
  }
  return best ? JSON.stringify({ x: r.left + (best[0] * r.width) / W, y: r.top + (best[1] * r.height) / H }) : null;
})()`;

/** 화면이 시작될 때 넣는 계측: 긴 작업과 그리기 끝 시각(연결 표시가 '실시간 연결됨'이 된 때 = 좌석 목록을 그린 직후) */
const PRELUDE = `(() => {
  window.__labLongTasks = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__labLongTasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch {}
  const mark = () => { const c = document.getElementById('conn'); if (c && c.textContent === '실시간 연결됨' && window.__labDrawnAt === undefined) window.__labDrawnAt = performance.now(); };
  new MutationObserver(mark).observe(document, { subtree: true, childList: true, characterData: true });
})();`;

async function evaluate(c, sid, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error(`화면 안 계산 실패: ${r.exceptionDetails.text}`);
  return r.result.value;
}

async function waitFor(c, sid, expr, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await evaluate(c, sid, expr)) return;
    await sleep(200);
  }
  throw new Error(`${what}을 ${timeoutMs}ms 안에 보지 못했다`);
}

async function mouse(c, sid, type, x, y, extra = {}) {
  await c.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !extra.buttons ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1, ...extra }, sid);
}

async function clickAt(c, sid, x, y) {
  await mouse(c, sid, 'mousePressed', x, y, { buttons: 1 });
  await mouse(c, sid, 'mouseReleased', x, y, { buttons: 0 });
}

/** 회 하나 */
async function rep(c, i, { eventId, token, throttle }) {
  const { browserContextId } = await c.send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId: sid } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    for (const d of ['Page', 'Runtime', 'Network', 'HeapProfiler']) await c.send(`${d}.enable`, {}, sid);
    await c.send('Network.setCookie', { name: ACCESS_COOKIE, value: token, url: ORIGIN, secure: true, httpOnly: true, sameSite: 'Lax' }, sid);
    await c.send('Emulation.setDeviceMetricsOverride', VIEWPORT, sid);
    await c.send('Emulation.setCPUThrottlingRate', { rate: throttle }, sid);
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE }, sid);
    const loaded = c.once('Page.loadEventFired', sid, 120_000);
    await c.send('Page.navigate', { url: `${ORIGIN}/v0/seatmap/${eventId}` }, sid);
    await loaded;
    await waitFor(c, sid, 'window.__labDrawnAt !== undefined && window.__peaketVitals?.status !== "loading"', 120_000, '좌석맵 그리기 끝');
    const st = await evaluate(c, sid, 'window.__peaketVitals.status');
    if (st !== 'ready') throw new Error(`계측 상태가 ready가 아니다: ${st}`);
    // 적재 지표(LCP·CLS)는 비우기 전에 읽는다
    await sleep(1000);
    const load = await evaluate(c, sid, 'JSON.stringify({ drawnAt: window.__labDrawnAt, v: window.__peaketVitals })');
    const L = JSON.parse(load);
    await evaluate(c, sid, 'window.__peaketVitalsReset(); window.__labResetAt = performance.now(); true');

    const rect = JSON.parse(await evaluate(c, sid, 'JSON.stringify(document.getElementById("map").getBoundingClientRect())'));
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // 확대 3번(휠), 이동(끌기)
    for (let k = 0; k < 3; k++) {
      await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -120 }, sid);
      await sleep(400);
    }
    await mouse(c, sid, 'mousePressed', cx, cy, { buttons: 1 });
    for (let k = 1; k <= 5; k++) await mouse(c, sid, 'mouseMoved', cx - k * 12, cy - k * 8, { buttons: 1 });
    await mouse(c, sid, 'mouseReleased', cx - 60, cy - 40, { buttons: 0 });
    await sleep(400);
    // 좌석 고르기: 가운데에서 가장 가까운 빈 좌석 화소를 누른다
    const sel = () => evaluate(c, sid, 'document.getElementById("selection").textContent');
    const before = await sel();
    let picked = false;
    const spot = await evaluate(c, sid, FIND_SEAT);
    if (spot) {
      const p = JSON.parse(spot);
      await clickAt(c, sid, p.x, p.y);
      await sleep(300);
      picked = (await sel()) !== before;
    }
    // [선택 좌석 잡기]
    let held = false;
    if (picked) {
      const b = JSON.parse(await evaluate(c, sid, 'JSON.stringify(document.getElementById("hold").getBoundingClientRect())'));
      await clickAt(c, sid, b.left + b.width / 2, b.top + b.height / 2);
      try {
        await waitFor(c, sid, '!document.getElementById("release").hidden', 15_000, '홀드 응답');
        held = true;
      } catch {
        held = false;
      }
    }
    await sleep(1500);
    const after = JSON.parse(await evaluate(c, sid, 'JSON.stringify({ v: window.__peaketVitals, lt: window.__labLongTasks.filter((t) => t.start >= window.__labResetAt).length })'));
    await c.send('HeapProfiler.collectGarbage', {}, sid);
    const heap = await c.send('Runtime.getHeapUsage', {}, sid);
    // 놓기(다음 회가 같은 좌석·1인 한도에 걸리지 않게). 값을 읽은 뒤라 판정에 넣지 않는다
    if (held) {
      const r = JSON.parse(await evaluate(c, sid, 'JSON.stringify(document.getElementById("release").getBoundingClientRect())'));
      await clickAt(c, sid, r.left + r.width / 2, r.top + r.height / 2);
      await waitFor(c, sid, 'document.getElementById("release").hidden', 15_000, '놓기 응답').catch(() => {});
    }
    const v = after.v;
    return {
      rep: i,
      drawMs: Math.round(L.drawnAt * 10) / 10,
      inpMs: v.inp?.value ?? null,
      lcpMs: L.v.lcp?.value ?? null,
      cls: L.v.cls?.value ?? null,
      loafCount: v.loaf?.count ?? 0,
      loafMs: Math.round((v.loaf?.totalMs ?? 0) * 10) / 10,
      longTasks: after.lt,
      heapMb: Math.round((heap.usedSize / 2 ** 20) * 10) / 10,
      picked,
      held,
      inpTarget: v.inp?.attribution?.target ?? null,
      worstLoaf: v.loaf?.worst?.[0] ?? null,
    };
  } finally {
    await c.send('Target.closeTarget', { targetId }).catch(() => {});
    await c.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}

async function main() {
  const o = parse(process.argv.slice(2));
  const tag = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(0, 16);
  const outDir = resolve(o.out ?? join(REPO, '.cache', 'peaket-loadtest', `${today()}-k5-${tag}`));
  mkdirSync(outDir, { recursive: true });
  const chrome = o.chrome ?? findChrome();
  const eventId = randomUUID();
  log(`== 5만 석 회차 ${eventId} 열기`);
  const seeded = await inAppPod(seedScript({ eventId, admitPerSecond: 100000, saleEndsAtMs: Date.now() + 3 * 3600_000, grid: GRID, perPersonLimit: 4, prices: { R: 150000 } }), 600_000);
  log(`좌석 ${seeded.seats}석`);
  const { privateJwk } = loadOrCreateV0TokenKey(V0_TOKEN_KEY_FILE);
  const iat = Math.floor(Date.now() / 1000);
  const token = signV0Token(privateJwk, { sub: accountRef(tag, 0), sid: sidOf(tag, 0), pid: pidOf(tag, 0), scope: 'ticket:buy', exp: iat + 3 * 3600 }, { nowMs: Date.now() });
  const ca = Buffer.from((await kubectl(['-n', V0_NAMESPACE, 'get', 'secret', 'v0-gateway', '-o', 'jsonpath={.data.PEAKET_V0_TLS_CERT}'], { quiet: true })).trim(), 'base64');
  const pf = await forward();
  const prof = mkdtempSync(join(tmpdir(), 'k5-chrome-'));
  let browser;
  // Ctrl+C·kill 신호로 끝나도 Chrome·포트 전달을 끝내고 프로필(3시간짜리 액세스 토큰 쿠키가 든다)을 지운다(2026-11-03 새 맥락 리뷰)
  const stop = (code) => () => {
    try {
      if (browser) browser.kill();
      pf.kill();
      rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (e) {
      // 지우지 못해도(Windows에서 Chrome 하위 프로세스가 파일을 잡고 있을 때) 신호의 종료 코드로 끝내고, 남은 프로필 자리를 알린다
      console.error(`loadtest/k5/seatmap-lab.mjs: Chrome 프로필을 지우지 못했다(${prof}): ${e.message}`);
    } finally {
      process.exit(code);
    }
  };
  const handlers = [['SIGINT', 130], ['SIGTERM', 143], ['SIGBREAK', 149], ['SIGHUP', 129]].map(([sig, code]) => [sig, stop(code)]);
  for (const [sig, fn] of handlers) process.on(sig, fn);
  try {
    log('== 시험 계정 진입·입장');
    const e = await gw('POST', `/v1/queues/${eventId}/entries`, { token, ca });
    if (e.status !== 201) throw new Error(`진입 실패(HTTP ${e.status})`);
    let admitted = false;
    for (let k = 0; k < 20 && !admitted; k++) {
      const r = await gw('POST', `/v1/queues/${eventId}/admission`, { token, ca });
      admitted = r.status === 200 && JSON.parse(r.body || '{}').status === 'ADMITTED';
      if (!admitted) await sleep(500);
    }
    if (!admitted) throw new Error('입장하지 못했다');

    log(`== Chrome(머리 없음) ${chrome}`);
    browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--no-sandbox', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${prof}`, '--ignore-certificate-errors', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, 'about:blank'], { stdio: 'ignore' });
    const portFile = join(prof, 'DevToolsActivePort');
    const until = Date.now() + 30_000;
    while (!existsSync(portFile) && Date.now() < until) await sleep(200);
    if (!existsSync(portFile)) throw new Error('Chrome이 개발자 도구 포트를 열지 않았다');
    const [port, path] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    const c = await cdp(`ws://127.0.0.1:${port}${path}`);
    const version = await c.send('Browser.getVersion');
    const rows = [];
    for (let i = 1; i <= o.reps; i++) {
      const r = await rep(c, i, { eventId, token, throttle: o.throttle });
      rows.push(r);
      log(`회 ${i}: 그리기 ${r.drawMs}ms, INP ${r.inpMs ?? '-'}ms, LCP ${r.lcpMs ?? '-'}ms, CLS ${r.cls ?? '-'}, 긴 프레임 ${r.loafCount}(${r.loafMs}ms), 긴 작업 ${r.longTasks}, 힙 ${r.heapMb}MB${r.held ? '' : ' (홀드 못 함)'}`);
    }
    c.close();
    const summary = summarizeLab(rows.map(({ rep: n, drawMs, inpMs, lcpMs, cls, loafCount, loafMs, longTasks, heapMb }) => ({ rep: n, drawMs, inpMs, lcpMs, cls, loafCount, loafMs, longTasks, heapMb })));
    const lab = { eventId, seats: seeded.seats, reps: o.reps, throttle: o.throttle, viewport: VIEWPORT, chrome: version.product, summary, notHeld: rows.filter((r) => !r.held).length };
    writeFileSync(join(outDir, 'rows.json'), JSON.stringify(rows, null, 2));
    writeFileSync(join(outDir, 'lab.json'), JSON.stringify(lab, null, 2));
    const c0 = osCpus();
    const infra = [
      `측정 환경(${new Date().toISOString()})`,
      `PC: ${c0[0]?.model ?? '?'} 논리 프로세서 ${c0.length}개, 메모리 ${Math.round(totalmem() / 2 ** 30)} GiB`,
      `브라우저: ${version.product}(머리 없음, Playwright Chromium), CPU ${o.throttle}배 느리게(Emulation.setCPUThrottlingRate), 화면 ${VIEWPORT.width}×${VIEWPORT.height} 배율 ${VIEWPORT.deviceScaleFactor} 모바일`,
      `대상: v0 좌석맵(kind peaket, 입구 포트 전달 127.0.0.1:8443), 5만 석 회차`,
      `회마다 새 브라우저 맥락, 조작: 휠 확대 3번 → 끌기 → 좌석 고르기 → [선택 좌석 잡기](docs/verification.md §3.10 K5)`,
      '',
    ].join('\n');
    writeFileSync(join(outDir, 'infra.txt'), infra);
    log(`\n요약: ${JSON.stringify(summary)}`);
    if (o.record) {
      const s = summary;
      const n = rows.length;
      const over = (k, lim) => rows.filter((r) => typeof r[k] === 'number' && r[k] > lim).length;
      // 랩 p75 판정(K5): p75 ≤ 목표 ⇔ 목표를 넘은 회의 비율 ≤ 25%
      // INP 값이 없는 회는 시행에서 빼고, 값이 하나도 없으면 INP 점검을 만들지 않는다(없는 시행을 만들지 않는다, 2026-11-03 새 맥락 리뷰)
      const inpTrials = rows.filter((r) => typeof r.inpMs === 'number').length;
      const checks = { checks: [
        ...(inpTrials > 0 ? [{ name: 'inp_p75_200ms', allowed: 0.25, trials: inpTrials, violations: over('inpMs', 200), target: 'INP p75 ≤ 200ms(랩)' }] : []),
        { name: 'draw_p75_1000ms', allowed: 0.25, trials: n, violations: over('drawMs', 1000), target: '좌석맵 다 그리기 p75 < 1초' },
      ] };
      writeFileSync(join(outDir, 'checks.json'), JSON.stringify(checks, null, 2));
      writeFileSync(join(outDir, 'bench-summary.json'), JSON.stringify({ bench: { p99_ms: null, error_rate: null, requests: n, dropped: 0 }, lab }, null, 2));
      const notes = `K5 랩 판정(v0 메인 스레드 Canvas, ${n}회, CPU ${o.throttle}배): 그리기 p75 ${s.drawMs.p75}ms·최대 ${s.drawMs.max}ms, INP p75 ${s.inpMs.p75 ?? '-'}ms·최대 ${s.inpMs.max ?? '-'}ms(값 없음 ${s.inpMs.missing}회), LCP p75 ${s.lcpMs.p75 ?? '-'}ms, CLS p75 ${s.cls.p75 ?? '-'}, 50ms 넘은 긴 프레임 합 ${s.loafCount.sum}(회 최대 ${s.loafCount.max}), 조작 경로 긴 작업 합 ${s.longTasks.sum}(회 최대 ${s.longTasks.max}), GC 뒤 힙 중앙값 ${s.heapMb.median}MB, 홀드 못 한 회 ${lab.notHeld}`;
      execFileSync(PYTHON, ['-I', '-X', 'utf8', 'tools/perf-ledger/collect.py', '--run-id', o.runId, '--kpi', 'K5', '--version', 'v0', '--profile', 'local-lab', '--duration', '0', '--warmup', '0', '--scenario', 'loadtest/k5/seatmap-lab.mjs', '--closed-model', '--bench-summary', join(outDir, 'bench-summary.json'), '--infra-file', join(outDir, 'infra.txt'), '--extra', join(outDir, 'rows.json'), '--checks', join(outDir, 'checks.json'), '--notes', notes, '--verdict', 'baseline', '--generator', `Chrome ${version.product} 1개(이 PC, 머리 없음)`, '--raw-bucket', 's3://peaket-perf-raw', '--raw-outbox', join(REPO, '.cache', 'perf-raw-outbox')], { cwd: REPO, stdio: 'inherit' });
    }
    log(`산출물: ${outDir}`);
  } finally {
    if (browser) browser.kill();
    pf.kill();
    await sleep(500);
    rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    // 프로필을 지운 뒤에 신호 처리기를 뗀다(그 사이 Ctrl+C로 기본 동작이 끝내 토큰 쿠키가 든 프로필이 남지 않게, 2차 리뷰)
    for (const [sig, fn] of handlers) process.off(sig, fn);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(`loadtest/k5/seatmap-lab.mjs: ${e.message}`);
      process.exit(1);
    },
  );
}
