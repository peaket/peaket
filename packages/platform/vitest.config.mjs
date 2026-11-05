// 단위 시험 도구는 Vitest 하나다(docs/frontend.md §5.17). 서버 공용 패키지라 node 환경으로 돈다.
// NestJS의 생성자 주입은 데코레이터 메타데이터가 필요하다. Vitest(oxc)는 tsconfig의 emitDecoratorMetadata를 읽는다(2026-11-01 확인).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { testReport } from '../config/vitest/report.mjs';

export default defineConfig({
  // 서비스 뼈대(template/)는 실제 서비스처럼 @peaket/platform을 가져온다. 패키지 안에서는 원본으로 잇는다(빌드 없이 시험)
  resolve: { alias: [{ find: /^@peaket\/platform$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) }] },
  test: {
    // CI가 PEAKET_TEST_REPORT를 주면 JSON 보고서도 남긴다(ASVS 태그 리포트, BOT-162)
    ...testReport(),
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
