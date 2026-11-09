// SEED CSS 층 검사(FE-T36)가 보는 앱 다섯과 경로(docs/frontend.md §5.17 FE-T36, §5.8 성능 예산 표).
// 경로마다 §5.8 표의 경로 묶음 이름(row)을 적고, 예산 숫자는 정본 표에서 읽는다(lib/canon.mjs).
// 탐침(probe)은 PoC 빌드(PEAKET_POC=seed-css)에만 있는 화면이다(packages/ds/src/poc/SeedLayerProbe.tsx).
import { randomBytes } from 'node:crypto';

export const APPS = [
  {
    name: 'web',
    pkg: '@peaket/web',
    dir: 'apps/web',
    kind: 'next',
    port: 4101,
    probe: '/poc/seed-css',
    pages: [
      { path: '/', row: '홈·공연 상세·굿즈(ISR)' },
      // 공연 상세는 가짜 API 고정 자료의 회차(HOT-311). 서버가 가짜 API를 부른다(MOCK_API)
      { path: '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01', row: '홈·공연 상세·굿즈(ISR)' },
      { path: '/booking/evt-lumen-1025/seats', row: '좌석 화면' },
      { path: '/booking/evt-lumen-1025/checkout', row: '결제 화면' },
      { path: '/my/tickets', row: '월렛' },
      { path: '/search', row: '그 밖 소비자 화면' },
      { path: '/login', row: '그 밖 소비자 화면' },
    ],
  },
  {
    name: 'partner',
    pkg: '@peaket/partner',
    dir: 'apps/partner',
    kind: 'next',
    port: 4102,
    probe: '/poc/seed-css',
    pages: [{ path: '/events', row: '파트너 콘솔' }],
  },
  {
    name: 'console',
    pkg: '@peaket/console-host',
    dir: 'apps/console-host',
    kind: 'webpack',
    port: 4103,
    probe: '/poc-seed-css.html',
    pages: [{ path: '/', row: '관제 콘솔' }],
  },
  {
    name: 'scanner',
    pkg: '@peaket/scanner',
    dir: 'apps/scanner',
    kind: 'vite',
    port: 4104,
    probe: '/poc-seed-css.html',
    pages: [{ path: '/', row: '스캐너' }],
  },
  {
    name: 'forensics',
    pkg: '@peaket/forensics',
    dir: 'apps/forensics',
    kind: 'vite',
    port: 4105,
    probe: '/poc-seed-css.html',
    pages: [{ path: '/', row: '포렌식 리플레이(1단계 데모, 2단계 페이지)' }],
  },
];

/**
 * 빌드 둘. 경로 검사(①②③·크기)는 운영 빌드(prod: PEAKET_POC 없이, 운영과 같은 산출 폴더)로 하고, 탐침은 PoC 빌드(poc)로 한다.
 * PoC 빌드를 경로 검사에 쓰면 진입점이 둘이 되어 Vite가 전역 CSS를 공유 덩어리로 빼므로 운영 빌드의 CSS 차례를 가린다(리뷰 2026-11-04).
 * Vite·webpack 앱의 PoC 빌드는 탐침 진입점 하나만 묶는다(운영 빌드처럼 진입점 하나일 때의 CSS 차례를 본다).
 */
export const BUILDS = {
  prod: { nextDist: '.next', dist: 'dist', portOffset: 0 },
  poc: { nextDist: '.next-poc', dist: 'dist-poc', portOffset: 10 },
};

/** 그 빌드의 서버 포트(운영 빌드 4101~4105, PoC 빌드 4111~4115) */
export const portOf = (app, build) => app.port + BUILDS[build].portOffset;

/**
 * 계약 모양 가짜 API(apps/web/scripts/mock-api.mjs, ADR-0199 결정 2). 소비자 웹 검사 서버가 서버 쪽으로 부른다(홈 피드·공연 상세, HOT-311).
 * 소비자 웹 서버보다 먼저 띄운다(공연 상세가 처음 그릴 때 부른다). 브라우저 쪽 개인 값은 빌드에 팬 API 주소가 없어 비로그인으로 그린다
 */
export const MOCK_API = { name: 'mock-api', port: 4010, command: 'node ../../apps/web/scripts/mock-api.mjs 4010', path: '/v1/home' };
export const MOCK_API_ORIGIN = `http://127.0.0.1:${MOCK_API.port}`;

/** Playwright webServer 항목 하나(가짜 API) */
export const mockApiServer = () => ({ command: MOCK_API.command, url: `${MOCK_API_ORIGIN}${MOCK_API.path}`, reuseExistingServer: !process.env.CI, timeout: 30_000, stdout: 'ignore', stderr: 'pipe' });

/** 검사용 서버의 서버 액션 암호화 키(32바이트, 띄울 때마다 새로) */
const CHECK_KEY = randomBytes(32).toString('base64');

/** 앱 하나의 그 빌드를 띄우는 명령(검사 패키지 폴더 기준). Next는 next start, 나머지는 lib/serve.mjs */
export function serverCommand(app, build) {
  const b = BUILDS[build];
  if (!b) throw new Error(`모르는 빌드: ${build}`);
  const port = portOf(app, build);
  // next start는 서버 액션 암호화 키가 있어야 뜬다(packages/config/next/server-actions-key.mjs). 검사용 서버는 띄울 때마다 새 키를 쓴다
  // 소비자 웹은 운영처럼 캐시 화면 응답 때 해시 서버(apps/web/server/start.mjs)를 앞에 두고 Next.js를 안쪽 포트(+1000)에 띄운다(ADR-0193)
  if (app.kind === 'next') {
    const env = { PEAKET_NEXT_DIST: b.nextDist, NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: CHECK_KEY };
    // 소비자 웹은 가짜 API를 서버 쪽 원본으로 부르고, 가짜 API의 이미지 주소를 CSP img-src에 넣는다. 브라우저의 팬 API는 빌드에 넣은 운영 기본 출처라
    // connect-src(api)는 바꾸지 않는다(검사 브라우저의 개인 값 요청은 닿지 않아 비로그인으로 그린다)
    if (app.name === 'web') return { command: `node ../../${app.dir}/server/start.mjs --port ${port} --inner-port ${port + 1000}`, env: { ...env, PEAKET_API_ORIGIN: MOCK_API_ORIGIN, PEAKET_CSP_ORIGINS: JSON.stringify({ img: MOCK_API_ORIGIN }) } };
    return { command: `pnpm --dir ../../${app.dir} exec next start -p ${port}`, env };
  }
  // 없는 경로에 줄 대체 파일: 운영 빌드는 index.html, Vite·webpack PoC 빌드(dist-poc)는 탐침 페이지 하나만 있으므로 탐침 페이지다
  const spa = build === 'poc' ? app.probe.replace(/^\//, '') : 'index.html';
  return { command: `node lib/serve.mjs --root ../../${app.dir}/${b.dist} --port ${port} --spa ${spa}`, env: {} };
}

/** 서버가 떴는지 볼 주소: 운영 빌드는 첫 경로, PoC 빌드는 탐침 */
export const readyPath = (app, build) => (build === 'poc' ? app.probe : app.pages[0].path);

/** 태그 하나에서 속성 값(따옴표 있는 꼴과, 줄인 HTML의 따옴표 없는 꼴) */
function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** HTML에서 스타일시트 링크(문서에 나오는 차례)를 뽑는다 */
export function stylesheetHrefs(html) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!(attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet')) continue;
    const href = attr(tag, 'href');
    if (href) out.push(href.replaceAll('&amp;', '&'));
  }
  return out;
}

/**
 * HTML에서 첫 화면이 받는 스크립트 주소(문서에 나오는 차례, 겹친 것은 한 번): `<script src>`, `<link rel=modulepreload>`,
 * `<link rel=preload as=script>`. 첫 JS 예산(docs/frontend.md §5.8 '첫 JS')을 잴 때 쓴다
 */
export function scriptSrcs(html) {
  const out = new Set();
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    // nomodule은 옛 브라우저용 보충 스크립트(Next.js polyfillFiles)라 요즘 브라우저가 받지 않는다(첫 JS에 넣지 않는다)
    if (/\snomodule(?=[\s=>/])/i.test(m[0])) continue;
    const src = attr(m[0], 'src');
    if (src) out.add(src.replaceAll('&amp;', '&'));
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], 'rel') ?? '').toLowerCase().split(/\s+/);
    const as = (attr(m[0], 'as') ?? '').toLowerCase();
    const href = attr(m[0], 'href');
    if (href && (rel.includes('modulepreload') || (rel.includes('preload') && as === 'script'))) out.add(href.replaceAll('&amp;', '&'));
  }
  return [...out];
}

/** 검사가 서버에 닿는 주소의 호스트. 컨테이너 안의 브라우저가 이 PC의 서버를 볼 때는 host.docker.internal(lib/docker.mjs) */
export const HOST = process.env.PEAKET_WEB_CHECKS_HOST ?? '127.0.0.1';
/** 서버를 검사 밖에서 이미 띄웠으면(external) Playwright가 띄우지 않는다 */
export const EXTERNAL_SERVERS = process.env.PEAKET_WEB_CHECKS_SERVERS === 'external';
