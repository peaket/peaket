// 단위 시험 도구는 Vitest 하나다(docs/frontend.md §5.17). 시험 안에서 시뮬레이터를 루프백 무작위 포트로 띄운다.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
