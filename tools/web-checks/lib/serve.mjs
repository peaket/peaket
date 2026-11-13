// 빌드한 정적 화면을 띄우는 작은 서버(FE-T36·FE-T40, BUILD_ORDER BAS-170). 의존성 없이 Node http만 쓴다.
//   node lib/serve.mjs --root <폴더> --port <번호> [--host 127.0.0.1] [--base /_q/] [--rewrite '<정규식>=<파일>']... [--spa <파일>]
// --base: 주소 앞부분을 떼고 폴더에서 찾는다(대기실 셸은 운영에서 /_q/ 아래에 있다).
// --rewrite: 주소(쿼리 뺀 경로)가 정규식에 맞으면 그 파일을 준다(운영의 CloudFront Function 흉내).
// --spa: 없는 경로는 이 파일을 준다(앱 안 경로 고르기가 있는 단일 페이지 앱).
// --preset queue-room: 대기실 경량 페이지 운영 배포 흉내(/_q/ 아래 자산, 대기실 경로 → 한국어 셸. apps/web/queue-room/vite.config.ts의 SHELL_PATHS와 같다).
// --host: 붙을 주소(기본 127.0.0.1, 환경 변수 PEAKET_SERVE_HOST로 바꿀 수 있고 --host가 이긴다). 리눅스 Docker Engine에서
//   컨테이너 안 브라우저(host.docker.internal = 다리 주소)가 이 서버를 보려면 0.0.0.0에 붙인다(Docker Desktop은 127.0.0.1로도 닿는다).
// --cache-control: Cache-Control 머리글(기본 no-store). 좌석맵 PoC는 HTTP 캐시 길을 재려고 캐시하게 둔다.
// 미리 압축한 <파일>.br이 있고 요청의 Accept-Encoding이 br을 받으면 그것을 Content-Encoding: br로 준다(CDN의 brotli 전송 흉내).
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { extname, isAbsolute, posix, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** 붙을 주소의 기본값(이 PC 안에서만 닿는다) */
export const DEFAULT_HOST = '127.0.0.1';

/** 미리 정한 배포 흉내 */
export const PRESETS = {
  // 로케일별 셸을 먼저 고른다(뒤의 한국어 규칙이 `/en/queue/...`까지 삼키지 않게)
  'queue-room': {
    base: '/_q/',
    rewrites: [
      [/^\/en\/queue\/[^/]+\/?$/, 'shell.en.html'],
      [/^\/ja\/queue\/[^/]+\/?$/, 'shell.ja.html'],
      [/^\/zh\/queue\/[^/]+\/?$/, 'shell.zh.html'],
      [/^\/queue\/[^/]+\/?$/, 'shell.ko.html'],
      [/^\/shop\/[^/]+\/queue\/?$/, 'shell.ko.html'],
    ],
  },
};

/** 폴더 안의 경로만 돌려준다(상대 경로가 ..로 시작하거나 절대 경로면 null). CodeQL js/path-injection */
function within(root, p) {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, p);
  const rel = relative(rootAbs, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? abs : null;
}

/** 주소 경로를 폴더 안의 파일 경로로. 폴더 밖으로 나가면 null */
export function fileFor(root, urlPath, base = '/') {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (base !== '/' && p.startsWith(base)) p = `/${p.slice(base.length)}`;
  if (p.endsWith('/')) p += 'index.html';
  return within(root, `.${p}`);
}

/**
 * 서버가 뜰 때 root 아래 파일을 한 번 훑어 `/상대경로 → 절대경로` 지도로 만든다.
 * 요청 경로는 이 지도의 **열쇠**로만 쓰고, 파일을 읽는 값은 훑은 값이라 사용자 입력이 경로 식에 닿지 않는다(CodeQL js/path-injection).
 */
export async function fileIndex(root) {
  const rootAbs = resolve(root);
  const files = new Map();
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = resolve(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) files.set(`/${relative(rootAbs, abs).split('\\').join('/')}`, abs);
    }
  };
  await walk(rootAbs);
  return files;
}

/** 설정한 파일 이름(rewrite·spa)을 지도 열쇠로 바꾼다. 값은 코드·프리셋에서만 온다 */
export function keyOfFile(p) {
  const key = posix.normalize(`/${p}`);
  return key === '/..' || key.startsWith('/../') ? null : key;
}

/** 요청 경로를 지도 열쇠로 바꾼다. 열쇠가 없으면 null(파일 시스템 경로로 쓰지 않는다) */
export function keyOfUrl(urlPath, base = '/') {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (base !== '/' && p.startsWith(base)) p = `/${p.slice(base.length)}`;
  if (p.endsWith('/')) p += 'index.html';
  return keyOfFile(p);
}

/** 요청의 Accept-Encoding이 br을 받는가(q=0은 받지 않는다는 뜻이다) */
export function acceptsBrotli(header) {
  return String(header ?? '')
    .split(',')
    .some((part) => {
      const [name, ...params] = part.trim().toLowerCase().split(';');
      if (name.trim() !== 'br') return false;
      const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(p)).find(Boolean);
      return !q || Number(q[1]) > 0;
    });
}

/** @param {{ root: string, port: number, host?: string, base?: string, rewrites?: [RegExp, string][], spa?: string, cacheControl?: string }} opts */
export async function serveStatic({ root, port, host = DEFAULT_HOST, base = '/', rewrites = [], spa, cacheControl = 'no-store' }) {
  const files = await fileIndex(root);
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const rewrite = rewrites.find(([re]) => re.test(path));
    let key = rewrite ? keyOfFile(rewrite[1]) : keyOfUrl(path, base);
    let file = key ? files.get(key) : undefined;
    if (!file && spa) {
      key = keyOfFile(spa);
      file = key ? files.get(key) : undefined;
    }
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('없음');
      return;
    }
    const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': cacheControl };
    // 미리 압축한 짝(<파일>.br)이 있으면 그것을 준다. 형식은 원래 파일의 것이고, 캐시가 섞지 않게 Vary를 단다
    let send = file;
    const br = key ? files.get(`${key}.br`) : undefined;
    if (br) {
      headers.vary = 'accept-encoding';
      if (acceptsBrotli(req.headers['accept-encoding'])) {
        send = br;
        headers['content-encoding'] = 'br';
      }
    }
    const body = await readFile(send);
    res.writeHead(200, headers);
    res.end(body);
  });
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}


const USAGE = '쓰는 법: node lib/serve.mjs --root <폴더> --port <번호> [--host 127.0.0.1] [--base /_q/] [--rewrite <정규식>=<파일>] [--spa <파일>] [--preset queue-room] [--cache-control no-store]';

/**
 * 명령줄 인자 → serveStatic 옵션. 붙을 주소는 --host, 없으면 환경 변수 PEAKET_SERVE_HOST, 없으면 127.0.0.1이다.
 * 틀린 인자는 Error(쓰는 법)로 던진다.
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 */
export function parseServeArgs(args, env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      base: { type: 'string', default: '/' },
      rewrite: { type: 'string', multiple: true, default: [] },
      spa: { type: 'string' },
      preset: { type: 'string' },
      'cache-control': { type: 'string', default: 'no-store' },
    },
  });
  const preset = values.preset ? PRESETS[values.preset] : {};
  if (!preset) throw new Error(`모르는 --preset: ${values.preset} (${Object.keys(PRESETS).join(', ')})`);
  if (!values.root || !values.port) throw new Error(USAGE);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port는 0~65535의 정수여야 한다(받은 값 ${values.port})`);
  const rewrites = values.rewrite.map((r) => {
    const at = r.lastIndexOf('=');
    return [new RegExp(r.slice(0, at)), r.slice(at + 1)];
  });
  return {
    root: values.root,
    port,
    host: values.host || env.PEAKET_SERVE_HOST || DEFAULT_HOST,
    base: preset.base ?? values.base,
    rewrites: [...(preset.rewrites ?? []), ...rewrites],
    spa: values.spa,
    cacheControl: values['cache-control'],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseServeArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  await serveStatic(opts);
  console.log(`정적 서버: http://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${opts.port}/ → ${opts.root}`);
}
