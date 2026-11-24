// freeze-calendar 단위 시험. 실제 S3·ArgoCD·Karpenter 없이 계산·렌더·닫힘 실패만 본다.
import { defineConfig } from 'vitest/config';
import { testReport } from '../../packages/config/vitest/report.mjs';

export default defineConfig({
  test: {
    ...testReport(),
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});
