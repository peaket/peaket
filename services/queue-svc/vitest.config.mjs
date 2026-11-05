// 단위 시험(Vitest). 공용 패키지는 원본으로 잇는다(빌드 없이 시험, packages/platform과 같은 방식).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { testReport } from '../../packages/config/vitest/report.mjs';

const src = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Kafka 소비자 시작(src/consumers/start.ts)과 통합 시험이 쓰는 하위 내보내기
      { find: /^@peaket\/platform\/stream-worker$/, replacement: src('../../packages/platform/src/stream-worker.ts') },
      { find: /^@peaket\/platform$/, replacement: src('../../packages/platform/src/index.ts') },
    ],
  },
  test: {
    // CI가 PEAKET_TEST_REPORT를 주면 JSON 보고서도 남긴다(ASVS 태그 리포트, BOT-162)
    ...testReport(),
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
