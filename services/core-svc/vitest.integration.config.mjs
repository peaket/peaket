// 통합 시험(실제 PostgreSQL 18 컨테이너). pnpm test:integration. Docker 엔진이 없으면 실패한다(건너뛰지 않는다, packages/platform과 같음).
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
    include: ['test-int/**/*.int.test.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
