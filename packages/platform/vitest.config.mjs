// 단위 시험 도구는 Vitest 하나다(docs/frontend.md §5.17). 서버 공용 패키지라 node 환경으로 돈다.
// NestJS의 생성자 주입은 데코레이터 메타데이터가 필요하다. Vitest(oxc)는 tsconfig의 emitDecoratorMetadata를 읽는다(2026-11-01 확인).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
