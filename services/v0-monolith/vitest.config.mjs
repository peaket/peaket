// 단위 시험(Vitest). 공용 패키지·결제 모듈·시뮬레이터는 원본으로 잇는다(빌드 없이 시험, packages/platform과 같은 방식).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@peaket\/platform$/, replacement: src('../../packages/platform/src/index.ts') },
      { find: /^@peaket\/payment-svc\/payment$/, replacement: src('../payment-svc/src/modules/payment/index.ts') },
      { find: /^@peaket\/pg-simulator$/, replacement: src('../pg-simulator/src/index.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
