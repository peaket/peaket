// 단위 시험(Vitest). 바깥 의존성이 없는 순수 함수 패키지라 node 환경으로 돈다.
import { defineConfig } from 'vitest/config';
import { testReport } from '../config/vitest/report.mjs';

export default defineConfig({
  test: {
    // CI가 PEAKET_TEST_REPORT를 주면 JSON 보고서도 남긴다(ASVS 태그 리포트, BOT-162)
    ...testReport(),
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
