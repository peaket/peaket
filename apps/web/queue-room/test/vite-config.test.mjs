// 대기실 빌드는 소비자 웹과 따로 설치·빌드한다(CI: pnpm install --filter "@peaket/queue-room..."). 폴더 위쪽의 apps/web/postcss.config.mjs를
// 찾아 읽으면 웹 앱에만 있는 @tailwindcss/postcss를 찾지 못해 빌드가 실패한다(CI 실행 42089422611). 대기실 CSS는 Tailwind를 쓰지 않으므로 PostCSS 설정을 비워 찾지 않게 한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../vite.config.ts';

test('대기실 빌드는 폴더 위쪽의 PostCSS 설정을 찾아 읽지 않는다(웹 앱 의존성 없이 빌드된다)', () => {
  const c = typeof config === 'function' ? config({ command: 'build', mode: 'production' }) : config;
  assert.deepEqual(c.css?.postcss, { plugins: [] });
});
