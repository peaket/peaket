// 좌석맵 시연 페이지 빌드(BUILD_ORDER HOT-120). 결과는 packages/seatmap/dist-demo(검사 tools/web-checks/seatmap-pkg가 띄운다)
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: { outDir: fileURLToPath(new URL('../dist-demo', import.meta.url)), emptyOutDir: true, target: 'es2022' },
  worker: { format: 'es' },
});
