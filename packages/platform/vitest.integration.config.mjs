// 통합 시험(실제 PostgreSQL 컨테이너). 단위 시험(vitest.config.mjs)과 따로 돈다: pnpm test:integration.
// Docker 엔진이 없으면 실패한다(건너뛰지 않는다, openspec 변경 add-service-structure-and-request-checks 결정 9).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { testReport } from '../config/vitest/report.mjs';

export default defineConfig({
  // 서비스 뼈대(template/)는 실제 서비스처럼 @peaket/platform을 가져온다. 패키지 안에서는 원본으로 잇는다(빌드 없이 시험)
  resolve: { alias: [{ find: /^@peaket\/platform$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) }] },
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
