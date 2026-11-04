// 화면 코드의 브라우저 지원 린트(docs/frontend.md §1.5, NFR-019, 추천 적용 2026-10-28, 기술 검토 중간-095, BUILD_ORDER BAS-210).
// eslint-plugin-compat(lintAllEsApis 켬)과, 그 판 자료가 모르는 새 기능(예: AbortSignal.any, Promise.withResolvers)을 MDN 자료로 직접 보는
// 보조 규칙 peaket-compat/bcd(./bcd-rule.mjs) 둘로 목표 브라우저 밖의 웹 API와 ES 내장 기능을 막는다.
// `if (AbortSignal.any)`처럼 기능을 먼저 확인하고 쓰는 코드는 보고하지 않는다. 전역 대체(polyfill)가 있는 기능만 polyfills에 적는다.
// 린트가 쓰는 판 자료가 늦을 수 있어 정본은 §1.5 표다.
import compat from 'eslint-plugin-compat';
import tsParser from '@typescript-eslint/parser';
import { bcdPlugin } from './bcd-rule.mjs';

/**
 * 목표 브라우저(browserslist 질의, NFR-019: 주요 브라우저의 최신 2개 판과 iOS·iPadOS Safari 16.4 이상).
 * 앱 빌드의 변환 대상은 바꾸지 않으려고 뿌리 .browserslistrc 대신 이 린트에만 준다(빌드는 각 프레임워크의 기본 대상을 쓴다)
 */
export const BROWSERS = [
  'last 2 Chrome versions',
  'last 2 Edge versions',
  'last 2 Firefox versions',
  'last 2 Safari versions',
  'last 2 Samsung versions',
  'iOS >= 16.4',
];

/**
 * 전역으로 채워 넣는 대체(polyfill)가 있는 기능. 지금은 없다. §1.5 표의 대체 함수(예: anySignal)는 기능을 먼저 확인하고 쓰므로
 * 여기 적지 않는다. 여기 적으면 그 기능을 바로 부르는 코드도 통과하기 때문이다(추천 적용 2026-11-04)
 */
export const POLYFILLS = [];

/**
 * 화면 코드의 eslint-disable 주석이 가리키는, 아직 싣지 않은 React·접근성 규칙의 자리 표시자(아무것도 보고하지 않는다).
 * 그 플러그인(react-hooks·jsx-a11y·next)을 싣는 단계에서 진짜 플러그인으로 바꾼다. 여기 없는 규칙을 가리키는 주석은 오류가 나 새로 알 수 있다
 */
const noop = { meta: { type: 'problem', schema: false }, create: () => ({}) };
const PLACEHOLDER_PLUGINS = {
  'react-hooks': { rules: { 'exhaustive-deps': noop } },
  'jsx-a11y': { rules: { 'no-autofocus': noop } },
  '@next/next': { rules: { 'no-img-element': noop } },
};

/** 화면 폴더 안에 있어도 Node에서 도는 시험 파일은 브라우저 지원을 보지 않는다 */
export const NODE_ONLY_FILES = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/__tests__/**'];

/** @param {string[]} files 화면 코드 글롭 */
export function webCompatConfigs(files) {
  return [
    {
      files,
      ignores: NODE_ONLY_FILES,
      languageOptions: {
        parser: tsParser,
        parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
      },
      // 자리 표시자 규칙은 꺼져 있어 그 주석은 '쓰이지 않은 주석'이 된다. 그 규칙들을 싣기 전까지 그 보고는 끈다
      linterOptions: { reportUnusedDisableDirectives: 'off' },
      plugins: { compat, 'peaket-compat': bcdPlugin, ...PLACEHOLDER_PLUGINS },
      settings: { browsers: BROWSERS, lintAllEsApis: true, polyfills: POLYFILLS },
      rules: { 'compat/compat': 'error', 'peaket-compat/bcd': 'error' },
    },
  ];
}
