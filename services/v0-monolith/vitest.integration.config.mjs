// 통합 시험(실제 Valkey 컨테이너). pnpm test:integration. Docker 엔진이 없으면 실패한다(건너뛰지 않는다, packages/platform과 같음).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: { alias: [{ find: /^@peaket\/platform$/, replacement: src('../../packages/platform/src/index.ts') }] },
  test: {
    environment: 'node',
    include: ['test-int/**/*.int.test.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
