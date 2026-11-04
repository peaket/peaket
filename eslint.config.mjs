// 뿌리 ESLint 설정(pnpm lint). 서비스 안 구조의 층 의존 방향 규칙(docs/architecture.md §3.1, 기술 검토 낮음-008)을 건다.
// 화면 코드에는 브라우저 지원 린트(eslint-plugin-compat과 MDN 자료를 직접 읽는 보조 규칙, docs/frontend.md §1.5)를 건다. 그 밖의 화면 공용 규칙(docs/frontend.md, asvs/delivery.md 3.2.2)은 그 규칙이 생기는 단계에서 더한다.
import { serviceLayerConfigs } from './packages/config/eslint/service-layers.mjs';
import { webCompatConfigs } from './packages/config/eslint/web-compat.mjs';

/** 화면 코드(앱과 화면용 패키지의 소스). 브라우저 지원 린트를 건다(docs/frontend.md §1.5, BAS-210) */
export const WEB_FILES = [
  'apps/**/src/**/*.{ts,tsx,js,mjs}',
  'apps/web/app/**/*.{ts,tsx}',
  'apps/partner/app/**/*.{ts,tsx}',
  'packages/{ds,api-client,telemetry,validation,console-contract,seatmap}/src/**/*.{ts,tsx}',
];

// 계약 생성물(packages/contracts/src/gen)만 뺀다. 화면이 묶는 생성물(packages/ds/src/gen 토큰, BAS-040의 packages/api-client/src/gen orval 호출 함수)은
// 브라우저 지원 린트를 받는다(구간 1 끝 정리)
export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/dist-poc/**', '**/.next/**', '**/.next-*/**', '**/.turbo/**', 'packages/contracts/src/gen/**'] },
  ...serviceLayerConfigs(['services/*/src/modules', 'packages/platform/template/src/modules']),
  ...webCompatConfigs(WEB_FILES),
];
