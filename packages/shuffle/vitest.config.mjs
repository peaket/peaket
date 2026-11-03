// 단위 시험(Vitest). 바깥 의존성이 없는 순수 함수 패키지라 node 환경으로 돈다.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
