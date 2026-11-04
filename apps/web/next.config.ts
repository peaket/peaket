import path from 'node:path';
import type { NextConfig } from 'next';
import { seedLayeredAlias } from '@peaket/ds/seed-layered-alias';

// SEED CSS 층 PoC 빌드(FE-T36, tools/web-checks/seed-css/). 이때만 page.poc.tsx가 경로가 된다(운영 빌드에는 탐침 화면이 없다)
const seedCssPoc = process.env.PEAKET_POC === 'seed-css';

// 소비자 웹(docs/frontend.md §2.3·§2.5·§5.14.1, BUILD_ORDER HOT-290).
// - Cache Components를 켠다: (cached) 묶음은 빌드 때 정적 셸, (request) 묶음은 루트 레이아웃이 요청 nonce를 읽어 정적 셸 없이 그린다(FE-T35).
// - 해시 방식(SRI)을 켠다: 외부 스크립트에 integrity를 단다(배포 경로의 변조 확인). App Router 인라인 스크립트는 덮지 못한다(SRI PoC, csp/web.spec.mjs).
// - 화면 묶음별 보안 헤더는 proxy.ts가 단다.
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // 퍼블리싱 중 여러 사람이 같은 앱을 동시에 빌드할 때만 산출 폴더를 나눈다(기본은 .next)
  distDir: process.env.PEAKET_NEXT_DIST ?? '.next',
  transpilePackages: ['@peaket/ds'],
  // SEED recipe를 층 판(@layer seed-components)으로 돌린다. Turbopack은 내보내기 조건 seed-layered를 고르지 못해서다(d2 §1, FE-T36)
  turbopack: { root: path.join(import.meta.dirname, '../..'), resolveAlias: seedLayeredAlias(import.meta.dirname) },
  pageExtensions: seedCssPoc ? ['poc.tsx', 'tsx', 'ts', 'jsx', 'js'] : ['tsx', 'ts', 'jsx', 'js'],
  // 루트 레이아웃이 둘((cached)·(request))이라 맞는 경로가 없는 주소는 app/global-not-found.tsx가 받는다(Next.js 16 실험 기능)
  cacheComponents: true,
  // 링크는 경로마다 하나인 정적 셸(App Shell)만 미리 받는다(Cache Components 새 프로젝트 권장값, Next.js 'Adopting Partial Prefetching')
  partialPrefetching: true,
  experimental: { globalNotFound: true, sri: { algorithm: 'sha256' } },
  // next dev가 앱 폴더에 AGENTS.md를 만들지 않게 한다(저장소 규칙은 뿌리 CLAUDE.md·docs가 정한다)
  agentRules: false,
};

export default config;
