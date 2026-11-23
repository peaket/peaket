// evidence-collector 통합 시험(실제 PostgreSQL 18·Valkey 8.1 컨테이너를 수집 대상으로 둔다, 시험 D-T51 ①⑤⑥). Docker 엔진이 없으면 실패한다(건너뛰지 않는다).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { testReport } from '../../packages/config/vitest/report.mjs';

const src = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@peaket\/platform$/, replacement: src('../../packages/platform/src/index.ts') }],
  },
  test: {
    ...testReport(),
    environment: 'node',
    include: ['test-int/**/*.int.test.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
