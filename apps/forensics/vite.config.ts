// 포렌식 리플레이 1단계 데모(SCR-069, ADR-0080). 정적 파일로 빌드한다(docs/frontend.md §2.3).
import { defineConfig, defaultClientConditions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// SEED CSS 층 PoC 빌드(FE-T36, tools/web-checks/seed-css/)는 탐침 화면(poc-seed-css.html) 하나만 묶는다(운영 빌드처럼 진입점 하나)
const seedCssPoc = process.env.PEAKET_POC === 'seed-css';
const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // SEED 부품 CSS의 층 판을 고른다(d2 §1 'CSS 층 순서')
  resolve: { conditions: ['seed-layered', ...defaultClientConditions] },
  server: { port: 3005, strictPort: true },
  preview: { port: 3005, strictPort: true },
  // 링크 없는 숨김 소스 맵(docs/frontend.md §5.18, FE-T21, BAS-220)
  build: seedCssPoc
    ? { sourcemap: 'hidden', rolldownOptions: { input: { 'poc-seed-css': page('./poc-seed-css.html') } } }
    : { sourcemap: 'hidden' },
});
