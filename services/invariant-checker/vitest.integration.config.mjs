// 통합 시험(실제 PostgreSQL 18 컨테이너). pnpm test:integration. Docker 엔진이 없으면 실패한다(건너뛰지 않는다, packages/platform과 같음).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-int/**/*.int.test.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
