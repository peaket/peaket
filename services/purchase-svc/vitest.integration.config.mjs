// 통합 시험(실제 Valkey 8.1 컨테이너). pnpm test:integration. Docker 엔진이 없으면 실패한다(건너뛰지 않는다, packages/platform과 같음).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { testReport } from '../../packages/config/vitest/report.mjs';

const src = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@peaket\/platform\/stream-worker$/, replacement: src('../../packages/platform/src/stream-worker.ts') },
      { find: /^@peaket\/platform$/, replacement: src('../../packages/platform/src/index.ts') },
      // CI의 통합 시험 단계는 빌드를 하지 않는다. 바뀐 패키지만 빌드하는 실행에서는 dist가 없어 모든 파일이 읽히지 않았다
      { find: /^@peaket\/shuffle$/, replacement: src('../../packages/shuffle/src/index.ts') },
    ],
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
