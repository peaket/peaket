// 단위 시험(DB 없이): 시험 기록 읽기, 결과 파일, 명령줄. 불변식 SQL은 통합 시험(vitest.integration.config.mjs)이 실제 PostgreSQL로 본다.
import { defineConfig } from 'vitest/config';
import { testReport } from '../../packages/config/vitest/report.mjs';

export default defineConfig({
  test: {
    // CI가 PEAKET_TEST_REPORT를 주면 JSON 보고서도 남긴다(ASVS 태그 리포트, BOT-162)
    ...testReport(),
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
