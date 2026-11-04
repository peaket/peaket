// SEED 색 모드 스크립트(@seed-design/css/theming의 generateThemingScript)를 앱이 같은 출처 파일로 싣게 내준다
// (docs/design/d2 §1 'Next.js 앱은 SEED 색 모드 스크립트를 같은 출처 파일로 루트 레이아웃에 싣는다', BUILD_ORDER HOT-291).
// 스크립트는 html에 data-seed-color-mode·data-seed-user-color-scheme(운영체제 다크면 dark, 바뀌면 따라감)을 단다.
// 앱은 붙인 SEED 판이 만드는 글자 그대로를 파일로 두고, 시험이 판과 같은지 본다(SEED를 올리면 다시 만든다).
import { generateThemingScript } from '@seed-design/css/theming';

/** @param {'system' | 'light-only' | 'dark-only'} mode 소비자 웹·파트너는 system(운영체제를 따른다, d1 §4) */
export function colorModeScript(mode) {
  return `${generateThemingScript({ mode }).trim()}\n`;
}
