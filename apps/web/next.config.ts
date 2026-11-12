import path from 'node:path';
import type { NextConfig } from 'next';
import { seedLayeredAlias } from '@peaket/ds/seed-layered-alias';
import { deploymentIdOf } from './server/deployment-id.mjs';
import { hideSourceMaps } from './scripts/hide-source-maps.mjs';
import { writeSeatPreload } from './scripts/seat-preload.mjs';

// SEED CSS 층 PoC 빌드(FE-T36, tools/web-checks/seed-css/). 이때만 page.poc.tsx가 경로가 된다(운영 빌드에는 탐침 화면이 없다)
const seedCssPoc = process.env.PEAKET_POC === 'seed-css';

// 소비자 웹(docs/frontend.md §2.3·§2.5·§5.14.1, BUILD_ORDER HOT-290).
// - Cache Components를 켠다: (cached) 묶음은 빌드 때 정적 셸, (request) 묶음은 루트 레이아웃이 요청 nonce를 읽어 정적 셸 없이 그린다(FE-T35).
// - 해시 방식(SRI)을 켠다: 외부 스크립트에 integrity를 단다(배포 경로의 변조 확인). App Router 인라인 스크립트는 덮지 못한다(SRI PoC, csp/web.spec.mjs).
// - 화면 묶음별 보안 헤더는 proxy.ts가 단다.
// 데모 SIMULATOR 결제창은 빌드 값이 있을 때만 묶음에 든다(FE-T21, ADR-0253). 그 밖은 대역을 싣는다
const simulatorWindowModule = process.env.NEXT_PUBLIC_PEAKET_PG_SIMULATOR === '1' ? './src/_pages/checkout/windows/simulator.ts' : './src/_pages/checkout/windows/simulator-absent.ts';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // 퍼블리싱 중 여러 사람이 같은 앱을 동시에 빌드할 때만 산출 폴더를 나눈다(기본은 .next)
  distDir: process.env.PEAKET_NEXT_DIST ?? '.next',
  // 운영 이미지는 standalone 산출물만 담는다(docs/frontend.md §5.18, ASVS 13.4.1, HOT-390).
  // server/start.mjs는 `<distDir>/standalone/apps/web/server.js`가 있으면 그것을 안쪽 포트에 띄운다.
  output: 'standalone',
  // 출시 후보 커밋 SHA를 배포 식별자로 쓴다(화면·서버 배포 식별자가 다르면 새로고침, HOT-390).
  deploymentId: deploymentIdOf(),
  transpilePackages: ['@peaket/ds', '@peaket/api-client', '@peaket/seatmap'],
  // SEED recipe를 층 판(@layer seed-components)으로 돌린다. Turbopack은 내보내기 조건 seed-layered를 고르지 못해서다(d2 §1, FE-T36)
  turbopack: { root: path.join(import.meta.dirname, '../..'), resolveAlias: { ...seedLayeredAlias(import.meta.dirname), 'peaket-pg-simulator-window': simulatorWindowModule } },
  pageExtensions: seedCssPoc ? ['poc.tsx', 'tsx', 'ts', 'jsx', 'js'] : ['tsx', 'ts', 'jsx', 'js'],
  // 루트 레이아웃이 둘((cached)·(request))이라 맞는 경로가 없는 주소는 app/global-not-found.tsx가 받는다(Next.js 16 실험 기능)
  cacheComponents: true,
  // 링크는 경로마다 하나인 정적 셸(App Shell)만 미리 받는다(Cache Components 새 프로젝트 권장값, Next.js 'Adopting Partial Prefetching')
  partialPrefetching: true,
  experimental: { globalNotFound: true, sri: { algorithm: 'sha256' } },
  // 숨김 소스 맵(docs/frontend.md §5.18, HOT-291): 맵을 만들되, 컴파일 직후(정적 화면을 만들기 전) static/의 JS·CSS 끝 링크를 지우고
  // 지운 JS의 새 해시로 SRI 표를 고치며 맵을 static/ 밖(<distDir>/browser-source-maps/)으로 옮긴다. 맵은 올리지 않는다(오류 도구 단계에서 올린다)
  productionBrowserSourceMaps: true,
  compiler: {
    runAfterProductionCompile: async ({ distDir }) => {
      hideSourceMaps({ distDir });
      // 좌석 화면 자산 목록(대기실이 차례 전에 받는다, ADR-0216 결정 3). PoC 빌드에도 같은 경로가 있어 함께 만든다
      writeSeatPreload({ distDir });
    },
  },
  // next dev가 앱 폴더에 AGENTS.md를 만들지 않게 한다(저장소 규칙은 뿌리 CLAUDE.md·docs가 정한다)
  agentRules: false,
  // 이미지는 image-worker가 만든 파생본을 CDN에서 바로 받는다. /_next/image는 쓰지 않고, 폭 목록은 파생본 단계와 같다(ADR-0199 결정 4)
  images: { loader: 'custom', loaderFile: './src/shared/lib/image-loader.ts', deviceSizes: [320, 640, 960, 1280], imageSizes: [] },
  // 개발 서버에서만:
  // - 같은 출처 정적 파일(랭킹 파일)을 계약 모양 가짜 API(scripts/mock-api.mjs)로 넘긴다(ADR-0199 결정 2)
  // - 대기실 경로(`/queue/{id}`·`/shop/{id}/queue`)와 대기실 자산(`/_q/*`)을 대기실 개발 서버로 넘긴다. 운영의 CloudFront 경로 나눔처럼
  //   같은 출처가 되어 공연 상세가 쓴 사전 검증 토큰을 대기실이 읽는다(ADR-0211 결정 5). `/queue/{id}/verify`(추가 검증)는 이 앱의 화면이다
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];
    const mock = process.env.PEAKET_DEV_STATIC_ORIGIN;
    const queueRoom = process.env.PEAKET_DEV_QUEUE_ROOM_ORIGIN || 'http://localhost:3004';
    return [
      ...(mock ? [{ source: '/v1/home/rankings.json', destination: `${mock}/v1/home/rankings.json` }] : []),
      // 좌석맵 파일(www 출처 정적 파일, 대기실이 차례 전에 미리 받는다, ADR-0216)
      ...(mock ? [{ source: '/v1/events/:eventId/seatmap-layouts/:file', destination: `${mock}/v1/events/:eventId/seatmap-layouts/:file` }] : []),
      { source: '/queue/:eventId', destination: `${queueRoom}/queue/:eventId` },
      { source: '/shop/:productId/queue', destination: `${queueRoom}/shop/:productId/queue` },
      { source: '/_q/:path*', destination: `${queueRoom}/_q/:path*` },
    ];
  },
};

export default config;
