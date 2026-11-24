// inv-ingest 단위 시험. 실제 Kafka·ClickHouse는 test-int가 본다.
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
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});
