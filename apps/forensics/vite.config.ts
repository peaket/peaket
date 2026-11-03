// 포렌식 리플레이 1단계 데모(SCR-069, ADR-0080). 정적 파일로 빌드한다(docs/frontend.md §2.3).
import { defineConfig, defaultClientConditions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // SEED 부품 CSS의 층 판을 고른다(d2 §1 'CSS 층 순서')
  resolve: { conditions: ['seed-layered', ...defaultClientConditions] },
  server: { port: 3005, strictPort: true },
  preview: { port: 3005, strictPort: true },
});
