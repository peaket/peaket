// unit·contract tests (Vitest). 공용 패키지는 소스로 읽는다(빌드 없이 시험, packages/platform과 같은 방식).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { testReport } from '../../packages/config/vitest/report.mjs';

const src = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@peaket\/platform$/, replacement: src('../../packages/platform/src/index.ts') }],
  },
  test: {
    ...testReport(),
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
