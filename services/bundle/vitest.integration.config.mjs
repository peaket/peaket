// 통합 시험(실제 Valkey 8.1·PostgreSQL 18 컨테이너). pnpm test:integration. 서비스 네 개의 시작 파일(dist/main.js)과 합본 시작 파일을
// 운영 시작 명령 그대로 자식 프로세스로 띄운다(시험 조립과 따로, docs/architecture.md §8.6 '자주 놓친 결함'). Docker 엔진이 없으면 실패한다(건너뛰지 않는다).
import { defineConfig } from 'vitest/config';
import { testReport } from '../../packages/config/vitest/report.mjs';

export default defineConfig({
  test: {
    // CI가 PEAKET_TEST_REPORT를 주면 JSON 보고서도 남긴다(ASVS 태그 리포트, BOT-162)
    ...testReport(),
    environment: 'node',
    include: ['test-int/**/*.int.test.ts'],
    passWithNoTests: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // 프로세스 시험이 같은 컨테이너를 나눠 쓴다(파일 하나씩)
    fileParallelism: false,
  },
});
