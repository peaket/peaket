// 포렌식 리플레이(SCR-069, ADR-0080). 정적 파일로 빌드한다(docs/frontend.md §2.3·§5.19).
// F-04-16: PEAKET_FORENSICS_MODE=operating이면 운영 빌드(operating.html, /forensics/), 없으면 시험·시연 빌드다.
import { defineConfig, defaultClientConditions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { forensicsBase, forensicsDevHeaders, forensicsInput, forensicsMode, forensicsPreviewHeaders } from './src/lib/build.ts';

// SEED CSS 층 PoC 빌드(FE-T36, tools/web-checks/seed-css/)는 탐침 화면(poc-seed-css.html) 하나만 묶는다(운영 빌드처럼 진입점 하나)
const seedCssPoc = process.env.PEAKET_POC === 'seed-css';
const mode = forensicsMode(process.env);
const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: seedCssPoc ? '/' : forensicsBase(mode),
  // SEED 부품 CSS의 층 판을 고른다(d2 §1 'CSS 층 순서')
  resolve: { conditions: ['seed-layered', ...defaultClientConditions] },
  server: { port: 3005, strictPort: true, headers: forensicsDevHeaders(mode) },
  preview: { port: 3005, strictPort: true, headers: forensicsPreviewHeaders(mode) },
  // 링크 없는 숨김 소스 맵(docs/frontend.md §5.18, FE-T21, BAS-220)
  build: seedCssPoc
    ? { sourcemap: 'hidden', rolldownOptions: { input: { 'poc-seed-css': page('./poc-seed-css.html') } } }
    : { sourcemap: 'hidden', rolldownOptions: { input: forensicsInput(mode) } },
});
