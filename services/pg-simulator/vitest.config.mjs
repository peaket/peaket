// 단위 시험 도구는 Vitest 하나다(docs/frontend.md §5.17). 시험 안에서 시뮬레이터를 루프백 무작위 포트로 띄운다.
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
