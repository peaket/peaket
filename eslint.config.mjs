// 뿌리 ESLint 설정(pnpm lint). 서비스 안 구조의 층 의존 방향 규칙(docs/architecture.md §3.1, 기술 검토 낮음-008)을 건다.
// 화면 코드에는 브라우저 지원 린트(eslint-plugin-compat과 MDN 자료를 직접 읽는 보조 규칙, docs/frontend.md §1.5)와 화면 보안 규칙
// (HTML 넣기·창 메시지 수신기 금지, asvs/delivery.md 3.2.2·3.5.5)을 건다. 서비스 코드에는 서비스 보안 규칙(공용 외부 호출 클라이언트 밖의
// fetch·node:http(s)·undici 금지, 응답 스키마 없는 새 라우트 처리기 금지, asvs/delivery.md 15.3.2·15.3.1, V-T31 ③)을 건다(BUILD_ORDER BAS-010 ①, ADR-0259).
// 화면·서비스 코드와 공용 서버 패키지(packages/platform/src)에는 프로토타입 오염 꼴 금지(asvs/delivery.md 15.3.6)를, 서비스 코드와 공용 서버 패키지에는
// sql.raw() 허용 목록(ADR-0037, architecture §8.3)을 건다. 처음에 Semgrep에 맡겼던 몫이다(BUILD_ORDER BAS-011 ②, ADR-0263 결정 6).
// 프로토타입 오염 꼴 금지는 이 설정이 보는 모든 파일(시험·이야기·스크립트·설정 파일 포함)에 켜 둔다(맨 끝에 두어 앞 설정이 끄지 못한다,
// devops §4.4 '리뷰 뒤 더한 규칙' ⑥, ADR-0263 결정 13).
import { serviceLayerConfigs } from './packages/config/eslint/service-layers.mjs';
import { serviceSecurityConfigs, serviceSecurityPlugin } from './packages/config/eslint/service-security.mjs';
import { webCompatConfigs, tsParser } from './packages/config/eslint/web-compat.mjs';
import { webSecurityConfigs, webSecurityPlugin } from './packages/config/eslint/web-security.mjs';

/** 화면 코드(앱과 화면용 패키지의 소스). 브라우저 지원 린트를 건다(docs/frontend.md §1.5, BAS-210) */
export const WEB_FILES = [
  'apps/**/src/**/*.{ts,tsx,js,mjs}',
  'apps/web/app/**/*.{ts,tsx}',
  'apps/partner/app/**/*.{ts,tsx}',
  'packages/{ds,api-client,telemetry,validation,console-contract,seatmap}/src/**/*.{ts,tsx}',
];

/** 서비스 코드(서비스와 서비스 뼈대의 소스). 서비스 보안 규칙을 건다(시험 폴더 test/·test-int/는 소스 밖이다) */
const SERVICE_SOURCES = ['services/*/src', 'packages/platform/template/src'];
/** 서비스(와 화면)가 함께 쓰는 공용 패키지 소스. sql.raw·프로토타입 오염 규칙만 건다(공용 외부 호출 클라이언트 자신은 fetch를 쓴다) */
const SHARED_SERVER_SOURCES = ['packages/platform/src', 'packages/shuffle/src', 'packages/search-normalize/src'];

/**
 * 프로토타입 오염 규칙을 이 설정이 보는 모든 파일에 켠다. 이미 보는 파일 묶음(화면 코드 글롭, 기본으로 보는 JS)만 가리켜 새 파일을 린트에 들이지 않는다.
 * 앱·화면 패키지는 peaket-web/, 서비스·공용 패키지는 peaket-service/ 이름이다(줄 안 주석 끄기 검사가 두 이름을 본다)
 */
const PROTOTYPE_EVERYWHERE = [
  { files: [...WEB_FILES, 'apps/**/*.{js,mjs,cjs}'], plugins: { 'peaket-web': webSecurityPlugin }, rules: { 'peaket-web/no-prototype-mutation': 'error' } },
  {
    files: ['services/**/*.{js,mjs,cjs}', 'packages/**/*.{js,mjs,cjs}', ...SERVICE_SOURCES.map((r) => `${r}/**/*.ts`), ...SHARED_SERVER_SOURCES.map((r) => `${r}/**/*.ts`)],
    ignores: ['apps/**'],
    plugins: { 'peaket-service': serviceSecurityPlugin },
    rules: { 'peaket-service/no-prototype-mutation': 'error' },
  },
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

/** 앱 코드의 동적 코드 실행 금지: eval·new Function·문자열 타이머(setTimeout('…'))(asvs/seat-hold.md 1.3.2, ADR-0264, BUILD_ORDER HOT-220) */
// no-implied-eval은 전역으로 선언된 타이머만 본다. 그래서 타이머 이름을 전역으로 둔다(값은 바꾸지 않는다)
export const NO_DYNAMIC_CODE = {
  // 앱 운영 코드에 더해 화면용 패키지와 서비스 소스까지 넓힌다(asvs/seat-hold.md 1.3.2, ADR-0264 결정 2, 리뷰 S3).
  // 시험 폴더(test/·test-int/)와 이야기는 넣지 않는다
  files: [...APP_RUNTIME_FILES, 'packages/*/src/**/*.{ts,tsx,js,mjs}', 'services/*/src/**/*.{ts,tsx,js,mjs}'],
  languageOptions: { globals: { setTimeout: 'readonly', setInterval: 'readonly', execScript: 'readonly', window: 'readonly', self: 'readonly', globalThis: 'readonly' } },
  rules: { 'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error' },
};

/**
 * 파트너 콘솔은 Konva(위험 구성 요소, asvs/frontend.md 15.1.4)를 CMP-051 폴더(apps/partner/src/widgets/seatmap-canvas)에서만 가져온다(ADR-0264 결정 2).
 * 같은 규칙 이름의 설정은 뒤 것이 앞 것을 통째로 덮으므로 목업 금지(NO_MOCKS_IN_APPS)의 목록을 함께 싣는다. 그 폴더는 목업 금지만 받는다
 */
export const KONVA_HOME = 'apps/partner/src/widgets/seatmap-canvas/**';
const KONVA_MESSAGE = 'Konva는 CMP-051 폴더(apps/partner/src/widgets/seatmap-canvas)에서만 가져온다(ADR-0264 결정 2, asvs/frontend.md 15.1.4)';
const [MOCK_IMPORTS] = NO_MOCKS_IN_APPS.rules['no-restricted-imports'].slice(1);
const [MOCK_SYNTAX] = NO_MOCKS_IN_APPS.rules['no-restricted-syntax'].slice(1);
/** Konva 모듈 이름(작은·큰따옴표, require, 식 없는 템플릿 글자) */
const KONVA_SOURCE = String.raw`/^konva(?:\/.*)?$/`;
export const PARTNER_KONVA_OUTSIDE = {
  // apps/partner/msw 뿌리 파일(proxy.ts·next.config.ts)과 .jsx·.cjs·.mts·.cts까지 덮는다(리뷰 S1). 운영 코드가 아닌 scripts 폴더는 뺀다
  files: ['apps/partner/src/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}', 'apps/partner/app/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}', 'apps/partner/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}'],
  ignores: [KONVA_HOME, '**/*.test.*', '**/*.spec.*', '**/*.stories.*', '**/scripts/**'],
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' } },
  rules: {
    'no-restricted-imports': ['error', { paths: MOCK_IMPORTS.paths, patterns: [...MOCK_IMPORTS.patterns, { group: ['konva', 'konva/*'], message: KONVA_MESSAGE }] }],
    'no-restricted-syntax': [
      'error',
      MOCK_SYNTAX,
      { selector: `ImportExpression[source.value=${KONVA_SOURCE}]`, message: KONVA_MESSAGE },
      { selector: `ImportExpression[source.type='TemplateLiteral'][source.quasis.0.value.cooked=${KONVA_SOURCE}]`, message: KONVA_MESSAGE },
      { selector: `CallExpression[callee.name='require'][arguments.0.value=${KONVA_SOURCE}]`, message: KONVA_MESSAGE },
      { selector: `CallExpression[callee.name='require'][arguments.0.type='TemplateLiteral'][arguments.0.quasis.0.value.cooked=${KONVA_SOURCE}]`, message: KONVA_MESSAGE },
    ],
  },
};

// 계약 생성물(packages/contracts/src/gen)만 뺀다. 화면이 묶는 생성물(packages/ds/src/gen 토큰, BAS-040의 packages/api-client/src/gen orval 호출 함수)은
// 브라우저 지원 린트를 받는다(구간 1 끝 정리)
export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/dist-poc/**', '**/.next/**', '**/.next-*/**', '**/.turbo/**', 'packages/contracts/src/gen/**'] },
  ...serviceLayerConfigs(['services/*/src/modules', 'packages/platform/template/src/modules']),
  ...serviceSecurityConfigs(SERVICE_SOURCES, { sharedRoots: SHARED_SERVER_SOURCES, root: import.meta.dirname }),
  ...webCompatConfigs(WEB_FILES),
  // 창 메시지 수신기 금지(처음의 NO_WINDOW_MESSAGE)는 화면 보안 규칙으로 옮겼고, 범위를 앱 코드에서 화면 코드 전체로 넓혔다
  ...webSecurityConfigs(WEB_FILES),
  NO_MOCKS_IN_APPS,
  API_CLIENT_HOME,
  ...PROTOTYPE_EVERYWHERE,
  PARTNER_KONVA_OUTSIDE,
  NO_DYNAMIC_CODE,
];
