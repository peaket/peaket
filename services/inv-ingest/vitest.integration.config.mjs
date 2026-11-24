// 통합 시험(실제 Kafka·ClickHouse 컨테이너를 시험 안에서 띄운다). pnpm test:integration. Docker 엔진이 없으면 실패한다(건너뛰지 않는다).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { testReport } from '../../packages/config/vitest/report.mjs';

const src = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@peaket\/platform$/, replacement: src('../../packages/platform/src/index.ts') },
      { find: /^@peaket\/platform\/stream-worker$/, replacement: src('../../packages/platform/src/stream-worker.ts') },
    ],
  },
  test: {
    ...testReport(),
    environment: 'node',
    include: ['test-int/**/*.int.test.ts'],
    passWithNoTests: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
