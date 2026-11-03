// 단위 시험 도구는 Vitest 하나다(docs/frontend.md §5.17). 계약 패키지는 브라우저 API를 쓰지 않아 node 환경으로 돈다.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
    // 큰 계약 문서(OpenAPI·AsyncAPI)를 통째로 읽는 시험이 있다. CI의 node 잡은 모든 패키지를 한꺼번에 돌려, 혼자 0.4초인 시험이
    // 5.5초 걸려 기본 제한 5초를 넘었다(2026-11-03 첫 원격 CI). 경합을 견디게 30초로 둔다
    testTimeout: 30_000,
  },
});
