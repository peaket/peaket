// 대기실 경량 페이지 빌드(docs/frontend.md §2.3·§5.1). 프레임워크 없이 Vite 8(rolldown)로 셸 HTML과 JS·CSS 한 벌을 만든다.
// 로케일 셸 넷(shell.{ko,en,ja,zh}.html)은 다국어 단계에서 더한다. 지금은 한국어 셸 하나다.
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/** 운영에서 CloudFront Function이 셸로 바꿔 읽는 경로(§2.5·§5.1). 회차·상품 ID는 페이지 스크립트가 주소에서 읽는다 */
const SHELL_PATHS = [/^\/(?:(?:en|ja|zh)\/)?queue\/[^/]+\/?$/, /^\/shop\/[^/]+\/queue\/?$/];

/** 개발 서버에서 CloudFront Function을 흉내 낸다: 대기실 경로 → 셸 HTML, `/preview` → 화면 목록(개발에서만), `/logout` → 웹 앱 서버 흉내 */
function cloudFrontShellRewrite(): Plugin {
  return {
    name: 'peaket-queue-room-shell-rewrite',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '/';
        const q = url.indexOf('?');
        const path = q < 0 ? url : url.slice(0, q);
        const search = q < 0 ? '' : url.slice(q);
        if (path === '/') {
          res.statusCode = 302;
          res.setHeader('Location', '/preview');
          res.end();
          return;
        }
        // 로그아웃 흉내(ADR-0208 결정 7): 운영에서는 같은 출처 웹 앱 서버가 받는다. 같은 출처 POST만 303으로 홈(웹 개발 서버)에 보낸다
        if (path === '/logout') {
          const sameOrigin = req.method === 'POST' && (req.headers.origin === `http://${req.headers.host}` || req.headers['sec-fetch-site'] === 'same-origin');
          res.statusCode = sameOrigin ? 303 : 403;
          res.setHeader('Cache-Control', 'no-store');
          if (sameOrigin) res.setHeader('Location', 'http://localhost:3000/');
          res.end();
          return;
        }
        if (SHELL_PATHS.some((re) => re.test(path))) req.url = `/_q/shell.ko.html${search}`;
        else if (path === '/preview' || path === '/preview/') req.url = `/_q/preview.html${search}`;
        next();
      });
    },
  };
}

export default defineConfig(() => ({
  // 셸과 자산은 `/_q/` 아래에 있다(§2.5 `/_q/assets/*`, §5.1 `/_q/shell.{locale}.html`). 개발 서버도 같게 두어 소비자 웹 개발 서버가
  // 대기실 경로·`/_q/*`를 넘겨 같은 출처로 흉내 낸다(ADR-0211 결정 5). 변경 반영(HMR)은 대기실 포트로 바로 잇는다
  base: '/_q/',
  appType: 'mpa',
  server: {
    port: 3004,
    strictPort: true,
    hmr: { host: 'localhost', clientPort: 3004 },
    // 좌석맵 파일(www 출처 정적 파일)은 개발에서 계약 모양 가짜 API가 낸다(대기실이 차례 전에 미리 받는다, ADR-0216)
    proxy: { '^/v1/events/[^/]+/seatmap-layouts/': { target: process.env.PEAKET_DEV_STATIC_ORIGIN || 'http://127.0.0.1:4010', changeOrigin: true } },
  },
  preview: { port: 3004, strictPort: true },
  plugins: [cloudFrontShellRewrite()],
  // 대기실 CSS는 Tailwind를 쓰지 않는다. 비워 두지 않으면 Vite가 폴더 위쪽의 apps/web/postcss.config.mjs를 찾아 읽어, 웹 앱 의존성 없이 설치하는 CI에서 빌드가 실패한다
  css: { postcss: { plugins: [] } },
  build: {
    target: 'es2022',
    // 링크 없는 숨김 소스 맵: .map은 만들되 JS에 sourceMappingURL을 넣지 않고 올리지 않는다(docs/frontend.md §5.18, FE-T21, BAS-220)
    sourcemap: 'hidden',
    // `/preview`(preview.html)는 빌드 입력에 넣지 않는다: 운영 빌드에는 화면 목록이 없다(design.md 결정 7)
    rolldownOptions: {
      input: { 'shell.ko': fileURLToPath(new URL('./shell.ko.html', import.meta.url)) },
      output: {
        entryFileNames: 'assets/queue-room.[hash].js',
        chunkFileNames: 'assets/queue-room-[name].[hash].js',
        assetFileNames: 'assets/queue-room.[hash][extname]',
      },
    },
  },
}));
