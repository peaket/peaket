// 대기실 빌드는 소비자 웹과 따로 설치·빌드한다(CI: pnpm install --filter "@peaket/queue-room..."). 폴더 위쪽의 apps/web/postcss.config.mjs를
// 찾아 읽으면 웹 앱에만 있는 @tailwindcss/postcss를 찾지 못해 빌드가 실패한다(CI 실행 42089422611). 대기실 CSS는 Tailwind를 쓰지 않으므로 PostCSS 설정을 비워 찾지 않게 한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config, { shellForPath } from '../vite.config.ts';

const built = () => {
  const c = typeof config === 'function' ? config({ command: 'build', mode: 'production' }) : config;
  return c;
};

test('대기실 빌드는 폴더 위쪽의 PostCSS 설정을 찾아 읽지 않는다(웹 앱 의존성 없이 빌드된다)', () => {
  assert.deepEqual(built().css?.postcss, { plugins: [] });
});

test('HOT-370 로케일 셸 넷을 모두 빌드 입력에 넣는다', () => {
  assert.deepEqual(Object.keys(built().build?.rolldownOptions?.input ?? {}).sort(), ['shell.en', 'shell.ja', 'shell.ko', 'shell.zh']);
});

test('HOT-370 대기실 경로를 로케일 셸로 바꾼다', () => {
  assert.equal(shellForPath('/queue/e1'), '/_q/shell.ko.html');
  assert.equal(shellForPath('/en/queue/e1'), '/_q/shell.en.html');
  assert.equal(shellForPath('/ja/queue/e1/'), '/_q/shell.ja.html');
  assert.equal(shellForPath('/zh/queue/e1'), '/_q/shell.zh.html');
  assert.equal(shellForPath('/shop/md-1/queue'), '/_q/shell.ko.html');
  assert.equal(shellForPath('/events/e1'), null);
  assert.equal(shellForPath('/_q/assets/queue-room.abc.js'), null);
});
