// 실측(PC) 측정(BUILD_ORDER PRF-085). pnpm sim [이름]. CI에서 돌지 않는다. Docker 엔진이 있어야 하고, 다른 측정·시험과 함께 돌리지 않는다.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { testReport } from '../../packages/config/vitest/report.mjs';

const src = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@peaket\/platform$/, replacement: src('../../packages/platform/src/index.ts') }],
  },
  test: {
    // CI가 PEAKET_TEST_REPORT를 주면 JSON 보고서도 남긴다(ASVS 태그 리포트, BOT-162)
    ...testReport(),
    environment: 'node',
    include: ['test-sim/**/*.sim.test.ts'],
    passWithNoTests: false,
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 300_000,
  },
});
