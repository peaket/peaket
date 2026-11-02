// 단위 시험(DB 없이): 시험 기록 읽기, 결과 파일, 명령줄. 불변식 SQL은 통합 시험(vitest.integration.config.mjs)이 실제 PostgreSQL로 본다.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
