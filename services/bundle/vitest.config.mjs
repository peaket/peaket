// 단위 시험(Vitest): 합본 설정·환경 파일·켜고 닫는 차례·관리 포트를 서비스 대역으로 본다. 실제 서비스를 띄우는 시험은 test-int다.
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
