// ops-svc 단위 시험. 실제 PostgreSQL·Kafka·gRPC는 heavy gate의 test-int가 본다.
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
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});
