// 실측(PC) 측정(BUILD_ORDER PRF-085). pnpm sim [이름]. CI에서 돌지 않는다. Docker 엔진이 있어야 하고, 다른 측정·시험과 함께 돌리지 않는다.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@peaket\/platform$/, replacement: src('../../packages/platform/src/index.ts') }],
  },
  test: {
    environment: 'node',
    include: ['test-sim/**/*.sim.test.ts'],
    passWithNoTests: false,
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 300_000,
  },
});
