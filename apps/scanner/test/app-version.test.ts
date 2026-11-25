// F-05-10 IR-05: 화면이 실제 빌드 판을 읽는지 확인한다.
// Vite define `__APP_VERSION__`은 apps/scanner/package.json의 version에서 만든다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
const mod = (await import('../src/app/app-version.ts').catch(() => ({}))) as { APP_VERSION?: string };

test('GAT-140 IR-05 앱 판은 빌드 package.json 판과 같다', () => {
  assert.equal(typeof mod.APP_VERSION, 'string', 'src/app/app-version.ts의 APP_VERSION이 없다');
  assert.equal(mod.APP_VERSION, pkg.version);
  assert.notEqual(pkg.version, '0.0.0');
});
