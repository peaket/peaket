// 같은 출처 검사 틀(ADR-0217 결정 1, BUILD_ORDER HOT-347): 운영 www 배포처럼 한 출처에서 대기실과 소비자 웹을 함께 낸다.
// - 대기실 셸 경로(/queue/{id}, /shop/{id}/queue)와 /_q/* → 대기실 검사 빌드(dist-check, 팬·대기열 API가 가짜 API인 빌드). 셸 HTML에는 A′ 묶음 헤더
// - 좌석맵 파일(/v1/events/{id}/seatmap-layouts/*) → 정적 원본(검사에서는 가짜 API, 운영은 www 출처의 S3)
// - 그 밖 → 소비자 웹 앱 서버(운영 빌드 4101, 없으면 502)
// 쓰는 법: node lib/same-origin.mjs [--port 4130] [--queue-room <폴더>] [--web http://127.0.0.1:4101] [--static http://127.0.0.1:4011]
import { createServer, request } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_HOST, PRESETS, fileFor } from './serve.mjs';
import { staticAppHeaders } from '../../../packages/config/headers/security-headers.mjs';
import { CHECK_MOCK_ORIGIN } from '../queue-room/origins.mjs';

export const SAME_ORIGIN_PORT = 4130;
const SEAT_PRELOAD_PATH = '/_q/seat-preload.json';
const SEAT_PRELOAD_FILE = fileURLToPath(new URL('../../../apps/web/.next/seat-preload.json', import.meta.url));
export const QUEUE_ROOM_CHECK_DIR = fileURLToPath(new URL('../../../apps/web/queue-room/dist-check/', import.meta.url));
/** 검사 빌드가 부르는 가짜 API(대기열·대기열 파일·팬 API 한 곳, queue-room/build.mjs) */
export const MOCK_ORIGIN = CHECK_MOCK_ORIGIN;

const QR = PRESETS['queue-room'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

/** 주소 경로가 어디로 가는가 */
export function routeFor(path) {
  if (path.startsWith(QR.base) || QR.rewrites.some(([re]) => re.test(path))) return 'queue-room';
  if (/^\/v1\/events\/[^/]+\/seatmap-layouts\/[^/]+$/.test(path)) return 'static';
  return 'web';
}

async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

function proxy(req, res, target) {
  const up = request(new URL(req.url ?? '/', target), { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  // 손님이 끊으면 원본 쪽 요청도 끊는다(걸린 채 남지 않게)
  res.on('close', () => {
    if (!res.writableEnded) up.destroy();
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('원본에 닿지 않음');
  });
  req.pipe(up);
}

/**
 * @param {{ port?: number, host?: string, queueRoomRoot?: string, web?: string, staticOrigin?: string, origins?: Record<string, string> }} o
 *   origins: A′ CSP의 출처(검사 빌드가 부르는 가짜 API와, 아직 값이 없는 본인확인기관 자리)
 */
export function startSameOrigin({ port = SAME_ORIGIN_PORT, host = DEFAULT_HOST, queueRoomRoot = QUEUE_ROOM_CHECK_DIR, web = 'http://127.0.0.1:4101', staticOrigin = MOCK_ORIGIN, origins } = {}) {
  const o = origins ?? { queue: MOCK_ORIGIN, queueFiles: MOCK_ORIGIN, api: MOCK_ORIGIN, identity: 'http://127.0.0.1:4020' };
  const shellHeaders = staticAppHeaders('queue-room', { origins: o });
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const route = routeFor(path);
    if (route === 'web') return proxy(req, res, web);
    if (route === 'static') return proxy(req, res, staticOrigin);
    const rewrite = QR.rewrites.find(([re]) => re.test(path));
    // 좌석 화면 자산 목록은 웹 빌드가 만든다(운영에서는 배포가 /_q/로 올린다, HOT-352). 웹을 빌드하지 않은 검사에서는 없고 대기실은 건너뛴다
    const file = path === SEAT_PRELOAD_PATH ? SEAT_PRELOAD_FILE : rewrite ? resolve(queueRoomRoot, rewrite[1]) : fileFor(queueRoomRoot, path, QR.base);
    if (!file || !(await isFile(file))) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('없음');
      return;
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...(type.startsWith('text/html') ? shellHeaders : {}) });
    res.end(await readFile(file));
  });
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { port: { type: 'string' }, 'queue-room': { type: 'string' }, web: { type: 'string' }, static: { type: 'string' } } });
  const s = await startSameOrigin({
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values['queue-room'] ? { queueRoomRoot: resolve(values['queue-room']) } : {}),
    ...(values.web ? { web: values.web } : {}),
    ...(values.static ? { staticOrigin: values.static } : {}),
  });
  const a = s.address();
  console.log(`같은 출처 검사 틀: http://${a.address}:${a.port}`);
}
