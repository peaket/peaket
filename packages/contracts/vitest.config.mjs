// 단위 시험 도구는 Vitest 하나다(docs/frontend.md §5.17). 계약 패키지는 브라우저 API를 쓰지 않아 node 환경으로 돈다.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
