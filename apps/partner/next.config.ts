import path from 'node:path';
import type { NextConfig } from 'next';
import { seedLayeredAlias } from '@peaket/ds/seed-layered-alias';

// SEED CSS 층 PoC 빌드(FE-T36, tools/web-checks/seed-css/). 이때만 page.poc.tsx가 경로가 된다(운영 빌드에는 탐침 화면이 없다)
const seedCssPoc = process.env.PEAKET_POC === 'seed-css';

// 파트너 콘솔(docs/frontend.md §2.3). 요청마다 셸과 CSP nonce는 화면 보안 헤더 단계(HOT-450)에서 더한다(add-screen-publishing design.md 결정 9).
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // 퍼블리싱 중 여러 사람이 같은 앱을 동시에 빌드할 때만 산출 폴더를 나눈다(기본은 .next)
  distDir: process.env.PEAKET_NEXT_DIST ?? '.next',
  transpilePackages: ['@peaket/ds', '@peaket/api-client'],
  // SEED recipe를 층 판(@layer seed-components)으로 돌린다. Turbopack은 내보내기 조건 seed-layered를 고르지 못해서다(d2 §1, FE-T36)
  turbopack: { root: path.join(import.meta.dirname, '../..'), resolveAlias: seedLayeredAlias(import.meta.dirname) },
  pageExtensions: [...(seedCssPoc ? ['poc.tsx'] : []), 'tsx', 'ts', 'jsx', 'js'],
  // next dev가 앱 폴더에 AGENTS.md를 만들지 않게 한다(저장소 규칙은 뿌리 CLAUDE.md·docs가 정한다)
  agentRules: false,
  // '/'는 공연 관리(SCR-062), '/settings'는 설정 메뉴 첫 항목 내 계정(d5 §6.1)으로 보낸다
  async redirects() {
    return [
      { source: '/', destination: '/events', permanent: false },
      { source: '/settings', destination: '/settings/account', permanent: false },
    ];
  },
};

export default config;
