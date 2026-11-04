// 빌드한 정적 화면을 띄우는 작은 서버(FE-T36·FE-T40, BUILD_ORDER BAS-170). 의존성 없이 Node http만 쓴다.
//   node lib/serve.mjs --root <폴더> --port <번호> [--base /_q/] [--rewrite '<정규식>=<파일>']... [--spa <파일>]
// --base: 주소 앞부분을 떼고 폴더에서 찾는다(대기실 셸은 운영에서 /_q/ 아래에 있다).
// --rewrite: 주소(쿼리 뺀 경로)가 정규식에 맞으면 그 파일을 준다(운영의 CloudFront Function 흉내).
// --spa: 없는 경로는 이 파일을 준다(앱 안 경로 고르기가 있는 단일 페이지 앱).
// --preset queue-room: 대기실 경량 페이지 운영 배포 흉내(/_q/ 아래 자산, 대기실 경로 → 한국어 셸. apps/web/queue-room/vite.config.ts의 SHELL_PATHS와 같다).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
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

/** 미리 정한 배포 흉내 */
export const PRESETS = {
  'queue-room': { base: '/_q/', rewrites: [[/^\/(?:(?:en|ja|zh)\/)?queue\/[^/]+\/?$/, 'shell.ko.html'], [/^\/shop\/[^/]+\/queue\/?$/, 'shell.ko.html']] },
};

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
  const abs = resolve(root, `.${p}`);
  const rootAbs = resolve(root);
  return abs === rootAbs || abs.startsWith(rootAbs + sep) ? abs : null;
}

async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** @param {{ root: string, port: number, base?: string, rewrites?: [RegExp, string][], spa?: string }} opts */
export function serveStatic({ root, port, base = '/', rewrites = [], spa }) {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const rewrite = rewrites.find(([re]) => re.test(path));
    let file = rewrite ? resolve(root, rewrite[1]) : fileFor(root, path, base);
    if (file && !(await isFile(file)) && spa) file = resolve(root, spa);
    if (!file || !(await isFile(file))) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('없음');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      port: { type: 'string' },
      base: { type: 'string', default: '/' },
      rewrite: { type: 'string', multiple: true, default: [] },
      spa: { type: 'string' },
      preset: { type: 'string' },
    },
  });
  const preset = values.preset ? PRESETS[values.preset] : {};
  if (!preset) {
    console.error(`모르는 --preset: ${values.preset} (${Object.keys(PRESETS).join(', ')})`);
    process.exit(2);
  }
  if (!values.root || !values.port) {
    console.error('쓰는 법: node lib/serve.mjs --root <폴더> --port <번호> [--base /_q/] [--rewrite <정규식>=<파일>] [--spa <파일>]');
    process.exit(2);
  }
  const rewrites = values.rewrite.map((r) => {
    const at = r.lastIndexOf('=');
    return [new RegExp(r.slice(0, at)), r.slice(at + 1)];
  });
  await serveStatic({
    root: values.root,
    port: Number(values.port),
    base: preset.base ?? values.base,
    rewrites: [...(preset.rewrites ?? []), ...rewrites],
    spa: values.spa,
  });
  console.log(`정적 서버: http://127.0.0.1:${values.port}/ → ${values.root}`);
}
