// 단위 시험 도구는 Vitest 하나다(docs/frontend.md §5.17). 정책은 브라우저 표준 API(fetch·AbortSignal·Response)만 써서 node 환경으로 돈다.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'], passWithNoTests: false },
});
