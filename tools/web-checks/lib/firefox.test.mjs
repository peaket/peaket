import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firefoxKind, firefoxUse } from './firefox.mjs';

test('PEAKET_FIREFOX: 비우면 Playwright 판, system이면 정식 판, 그 밖은 멈춘다', () => {
  assert.equal(firefoxKind(undefined), 'playwright');
  assert.equal(firefoxKind(''), 'playwright');
  assert.equal(firefoxKind('system'), 'system');
  assert.throws(() => firefoxKind('System'), /PEAKET_FIREFOX/);
  assert.throws(() => firefoxKind('moz-firefox'), /PEAKET_FIREFOX/);
});

test('Playwright 판은 기기 값에 설정 값만 얹고 채널을 두지 않는다', () => {
  const use = firefoxUse({ viewport: { width: 800, height: 600 } }, { kind: 'playwright', platform: 'win32' });
  assert.equal(use.defaultBrowserType, 'firefox');
  assert.deepEqual(use.viewport, { width: 800, height: 600 });
  assert.equal(use.channel, undefined);
  assert.equal(use.launchOptions, undefined);
});

test('정식 판은 moz-firefox 채널이고, Windows에서만 브라우저 프로세스를 기다린다(있던 실행 인자는 둔다)', () => {
  const win = firefoxUse({ launchOptions: { args: ['-x'], slowMo: 1 } }, { kind: 'system', platform: 'win32' });
  assert.equal(win.channel, 'moz-firefox');
  assert.deepEqual(win.launchOptions, { args: ['-x', '-wait-for-browser'], slowMo: 1 });
  const linux = firefoxUse({}, { kind: 'system', platform: 'linux' });
  assert.equal(linux.channel, 'moz-firefox');
  assert.deepEqual(linux.launchOptions, { args: [] });
});

test('BiDi Firefox 판정은 정식 판의 firefox 프로젝트일 때만 참이다', async () => {
  const { isBidiFirefox } = await import('./firefox.mjs');
  assert.equal(isBidiFirefox('firefox', 'system'), true);
  assert.equal(isBidiFirefox('firefox', 'playwright'), false);
  assert.equal(isBidiFirefox('chromium', 'system'), false);
});
