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
  // 운영 이미지는 standalone 산출물만 담는다(docs/frontend.md §5.18 'Next.js 앱 서버 실행', ADR-0079 결정 27, 검증 VF-11).
  // 로컬·검사의 `next start`는 경고를 내고 그대로 돈다(정적 자산은 <distDir>/static에서 읽는다)
  output: 'standalone',
  transpilePackages: ['@peaket/ds', '@peaket/api-client', '@peaket/seatmap', '@peaket/validation'],
  // 앱 서버 텔레메트리(instrumentation.ts, BUILD_ORDER HOT-400)는 묶지 않고 Node가 그대로 읽는다(OTel SDK가 모듈 읽기를 가로채 계측한다)
  serverExternalPackages: ['@peaket/platform'],
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
