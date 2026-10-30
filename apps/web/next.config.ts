import path from 'node:path';
import type { NextConfig } from 'next';

// 소비자 웹(docs/frontend.md §2.3). Cache Components와 CSP nonce는 PoC FE-T35(HOT-290)에서 켠다(add-screen-publishing design.md 결정 6).
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // 퍼블리싱 중 여러 사람이 같은 앱을 동시에 빌드할 때만 산출 폴더를 나눈다(기본은 .next)
  distDir: process.env.PEAKET_NEXT_DIST ?? '.next',
  transpilePackages: ['@peaket/ds'],
  turbopack: { root: path.join(import.meta.dirname, '../..') },
  // 루트 레이아웃이 둘((cached)·(request))이라 맞는 경로가 없는 주소는 app/global-not-found.tsx가 받는다(Next.js 16 실험 기능)
  experimental: { globalNotFound: true },
  // next dev가 앱 폴더에 AGENTS.md를 만들지 않게 한다(저장소 규칙은 뿌리 CLAUDE.md·docs가 정한다)
  agentRules: false,
};

export default config;
