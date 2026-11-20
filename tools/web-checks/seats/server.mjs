// 5만 석 좌석 화면 시험 서버(S-T21·S-T31 ⑥, BAT-182). Docker 없이 도는 realtime-gw 대역이다(감독 결정 2026-11-20).
// - 5만 석 좌석맵 파일·전체/구역 스냅샷을 내고, 스냅샷 요청 시각·구역·입장 토큰 유무를 기록한다.
// - 좌석 스트림은 apps/web/scripts/mock-api/stream.mjs의 대역을 그대로 쓴다(같은 바이트·하위 프로토콜·4429/4403).
// - 검사 제어: GET /__seats/log, /__seats/reset, /__seats/delta?section=&count=&every=&seat=, /__seats/interval?ms=, /__seats/close?code=
// 서버 상한·프레임·Pub/Sub 자체는 realtime-gw 시험(BAT-052)이 본다. 이 서버는 화면의 구독·해제·닫힘 0을 보는 무대다.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createSeatStreamMock } from '../../../apps/web/scripts/mock-api/stream.mjs';
import { fileIndex, keyOfUrl } from '../lib/serve.mjs';
import { SECTIONS, SEATS_PER_SECTION, fullSnapshot, sectionSnapshot, layoutFile } from './layout.mjs';
import { prepare } from './setup.mjs';

const DIST = fileURLToPath(new URL('./dist/', import.meta.url));
const GEN = new URL('./gen/', import.meta.url);
const { values } = parseArgs({ options: { port: { type: 'string', default: '4130' }, host: { type: 'string', default: '127.0.0.1' } } });
const port = Number(values.port);
const host = values.host;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 설정한 폴더 안의 경로만(CodeQL js/path-injection) */
function within(root, p) {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, p);
  const rel = relative(rootAbs, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? abs : null;
}

prepare();
const layoutBody = await readFile(layoutFile(GEN));
const files = await fileIndex(DIST);
/** 구역 판(스냅샷 응답에 싣는다). 델타를 보낼 때마다 올린다 */
const versions = new Map(Array.from({ length: SECTIONS }, (_, s) => [s, 1]));
/** 스냅샷 요청 기록 { at(벽시계 ms), section(null이면 전체), admission } */
let snapshots = [];
let layoutRequests = 0;
/** 좌석 스트림 대역(같은 바이트·하위 프로토콜·닫힘 코드) */
const stream = createSeatStreamMock({ now: () => Date.now() });

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const json = (res, status, body) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
const int = (v, min, max) => (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : null);

/** /__seats/delta: 구독한 연결에 델타를 count번 every ms 간격으로 보낸다(화면 p99용) */
function startDeltas(params) {
  const section = int(params.get('section'), 0, SECTIONS - 1);
  const count = int(params.get('count'), 1, 500);
  const every = int(params.get('every'), 1, 1_000);
  let seat = int(params.get('seat'), 0, SEATS_PER_SECTION - 1);
  if (section === null || count === null || every === null || seat === null) return { ok: false, error: 'bad-delta' };
  let sent = 0;
  let frames = 0;
  const timer = setInterval(() => {
    const r = stream.control(new URLSearchParams({ op: 'delta', section: String(section), seat: String(seat), state: '1' }));
    if (r.ok) {
      versions.set(section, Math.max(versions.get(section) ?? 1, r.sectionVersion));
      sent += r.sent;
    }
    seat = (seat + 97) % SEATS_PER_SECTION;
    if (++frames >= count) clearInterval(timer);
  }, every);
  timer.unref?.();
  return { ok: true, section, count, every };
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
  try {
    if (req.method === 'GET' && u.pathname === '/__seats/log') {
      return json(res, 200, { now: Date.now(), layoutRequests, snapshots, stream: stream.log() });
    }
    if (req.method === 'GET' && u.pathname === '/__seats/reset') {
      stream.control(new URLSearchParams({ op: 'reset' }));
      snapshots = [];
      layoutRequests = 0;
      for (const s of versions.keys()) versions.set(s, 1);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && u.pathname === '/__seats/delta') return json(res, 200, startDeltas(u.searchParams));
    if (req.method === 'GET' && u.pathname === '/__seats/interval') {
      const ms = int(u.searchParams.get('ms'), 0, 65_535);
      if (ms === null) return json(res, 400, { ok: false, error: 'bad-ms' });
      return json(res, 200, stream.control(new URLSearchParams({ op: 'interval', ms: String(ms) })));
    }
    if (req.method === 'GET' && u.pathname === '/__seats/close') {
      const code = int(u.searchParams.get('code'), 1000, 4999);
      if (code === null) return json(res, 400, { ok: false, error: 'bad-code' });
      return json(res, 200, stream.control(new URLSearchParams({ op: 'close', code: String(code) })));
    }

    const layoutMatch = /^\/v1\/events\/[^/]+\/seatmap-layouts\/\d+\.json$/.exec(u.pathname);
    if (req.method === 'GET' && layoutMatch) {
      layoutRequests++;
      return send(res, 200, 'application/json; charset=utf-8', layoutBody);
    }
    const snapMatch = /^\/v1\/events\/[^/]+\/seatmap-snapshot$/.exec(u.pathname);
    if (req.method === 'GET' && snapMatch) {
      const raw = u.searchParams.get('section');
      const section = raw === null ? null : int(raw, 0, SECTIONS - 1);
      snapshots.push({ at: Date.now(), section, admission: Boolean(req.headers['x-admission-token']) });
      if (raw !== null && section === null) return json(res, 400, { type: 'about:blank', title: 'Bad Section', status: 400 });
      const body = section === null ? fullSnapshot(1, versions) : sectionSnapshot(1, section, versions.get(section) ?? 1);
      return send(res, 200, 'application/octet-stream', Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    }
    if (u.pathname.startsWith('/v1/')) return json(res, 404, { type: 'about:blank', title: 'Not Found', status: 404 });

    // 시험 페이지(빌드한 정적 파일). 폴더를 훑어 만든 지도의 열쇠로만 찾는다
    if (req.method === 'GET') {
      const key = keyOfUrl(u.pathname);
      if (!key) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
      const abs = files.get(key) ?? (key.endsWith('/') ? files.get(`${key}index.html`) : undefined);
      const inRoot = abs ? within(DIST, relative(DIST, abs)) : null;
      if (!inRoot) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return send(res, 200, TYPES[extname(inRoot)] ?? 'application/octet-stream', await readFile(inRoot));
    }
    return send(res, 404, 'text/plain; charset=utf-8', 'not found');
  } catch (e) {
    console.error(e);
    return send(res, 500, 'text/plain; charset=utf-8', 'internal error');
  }
});
// 좌석 스트림(WebSocket 업그레이드)만 받는다. 다른 업그레이드는 대역이 404로 거절한다
server.on('upgrade', (req, socket) => stream.handleUpgrade(req, socket));
server.listen(port, host, () => console.log(`seats check server http://${host}:${port}/ (5만 석)`));
