// ops-svc 단위 시험. 실제 PostgreSQL·Kafka·gRPC는 heavy gate의 test-int가 본다.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});
