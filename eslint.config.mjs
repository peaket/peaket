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

/**
 * 앱의 운영 코드는 목업 처리기·가짜 값 도구를 가져오지 않는다(ADR-0196·0199, FE-T21). 시험·이야기(Storybook) 파일은 뺀다.
 * 가짜 API(apps/web/scripts/mock-api.mjs)는 고정 자료를 따로 띄우는 개발 도구라 앱 코드가 아니다
 */
// proxy.ts·instrumentation.ts는 서버에서만 돌고 화면 린트(TS 해석기)를 받지 않는다. 운영 묶음의 MSW 글자는 FE-T21이 막는다
const APP_RUNTIME_FILES = ['apps/**/src/**/*.{ts,tsx,js,mjs}', 'apps/web/app/**/*.{ts,tsx}', 'apps/partner/app/**/*.{ts,tsx}'];
const MOCK_SOURCE = /^(?:msw(?:\/.*)?|@faker-js\/faker(?:\/.*)?|@peaket\/api-client\/mocks|.*\/scripts\/mock-api(?:\.mjs)?)$/;
const NO_MOCKS_IN_APPS = {
  files: APP_RUNTIME_FILES,
  ignores: ['**/*.test.*', '**/*.spec.*', '**/*.stories.*'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          { name: '@peaket/api-client/mocks', message: 'MSW 처리기는 시험·이야기만 가져온다(운영 묶음에 넣지 않는다, ADR-0196, FE-T21)' },
          { name: '@peaket/api-client', importNames: ['setOrvalClient'], message: 'api-client 클라이언트는 shared/api 한 곳에서만 꽂는다(ADR-0199 결정 3)' },
        ],
        patterns: [{ group: ['msw', 'msw/*', '@faker-js/faker', '@faker-js/faker/*', '**/scripts/mock-api', '**/scripts/mock-api.mjs'], message: '목업·가짜 값 도구는 운영 코드가 가져오지 않는다(ADR-0199 결정 2, FE-T21)' }],
      },
    ],
    'no-restricted-syntax': [
      'error',
      { selector: `ImportExpression[source.value=${MOCK_SOURCE}]`, message: '목업·가짜 값 도구는 동적 가져오기로도 가져오지 않는다(ADR-0199 결정 2, FE-T21)' },
    ],
  },
};
/** setOrvalClient를 꽂는 한 곳(ADR-0199 결정 3) */
const API_CLIENT_HOME = { files: ['apps/web/src/shared/api/index.ts'], rules: { 'no-restricted-imports': 'off' } };

// 계약 생성물(packages/contracts/src/gen)만 뺀다. 화면이 묶는 생성물(packages/ds/src/gen 토큰, BAS-040의 packages/api-client/src/gen orval 호출 함수)은
// 브라우저 지원 린트를 받는다(구간 1 끝 정리)
export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/dist-poc/**', '**/.next/**', '**/.next-*/**', '**/.turbo/**', 'packages/contracts/src/gen/**'] },
  ...serviceLayerConfigs(['services/*/src/modules', 'packages/platform/template/src/modules']),
  ...webCompatConfigs(WEB_FILES),
  NO_MOCKS_IN_APPS,
  API_CLIENT_HOME,
];
