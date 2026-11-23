// 관제 콘솔 미리보기 서버(local·ci 전용, ADR-0360 결정 6·12). 운영 빌드(dist/, 원격 dist/remotes/ 포함)를 그대로 내고,
// 운영 배포 응답 헤더 정책과 같은 헤더(staticAppHeaders('console'): 묶음 C CSP를 막는 모드, Trusted Types는 보고 모드)를 붙인다.
// 화면 경로는 index.html로 돌린다(앱 안 라우터). PEAKET_OPS_PROXY_TARGET을 주면 /v1/ops/를 실제 ops-svc로, PEAKET_IDENTITY_PROXY_TARGET도 주면 /v1/ops/auth/*를 identity-svc로 넘긴다(scripts/ops-proxy.mjs).
// 캐시: 화면 HTML과 원격 목록(remotes.json)은 매번 확인(no-cache), 원격 진입 파일은 경로에 sha가 있어 해시 붙은 자산처럼 오래 캐시한다(ADR-0361 결정 3).
// 실행: pnpm --filter @peaket/console-host build && PEAKET_OPS_API_ORIGIN=http://localhost:4173 PEAKET_OPS_PROXY_TARGET=http://127.0.0.1:3000 \
//       pnpm --filter @peaket/console-host preview [포트, 기본 4173]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticAppHeaders } from '@peaket/config/headers/security-headers.mjs';
import { opsProxyMiddleware } from './ops-proxy.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 매번 확인하는 파일(산출물 폴더 기준 경로). 나머지는 이름이나 경로에 해시·sha가 있다 */
const NO_CACHE = new Set(['index.html', 'remotes.json']);

/**
 * 미리보기 서버를 만든다(시험이 포트 0으로 띄울 수 있다)
 * @param {{ env?: Record<string, string | undefined>, dist?: string }} [o]
 */
export function createPreviewServer(o = {}) {
  const env = o.env ?? process.env;
  const dist = o.dist ?? root;
  const opsApi = env.PEAKET_OPS_API_ORIGIN;
  const headers = staticAppHeaders('console', opsApi ? { origins: { opsApi } } : {});
  const proxy = opsProxyMiddleware(env);
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://preview.local');
    if (proxy && url.pathname.startsWith('/v1/ops/')) {
      proxy(req, res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let file = path.resolve(dist, rel);
    const inside = path.relative(path.resolve(dist), file);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      res.writeHead(400);
      res.end();
      return;
    }
    const isAsset = path.extname(file) !== '';
    if (!isAsset || !existsSync(file) || !statSync(file).isFile()) {
      // 파일이 아닌 화면 경로는 앱 셸로, 없는 자산은 404
      if (isAsset) {
        res.writeHead(404, headers);
        res.end();
        return;
      }
      file = path.join(dist, 'index.html');
    }
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    const cache = NO_CACHE.has(path.relative(dist, file).split(path.sep).join('/')) ? 'no-cache' : 'public, max-age=31536000, immutable';
    res.writeHead(200, { ...headers, 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
  createPreviewServer().listen(port, '127.0.0.1', () => console.log(`관제 콘솔 미리보기: http://localhost:${port}`));
}
