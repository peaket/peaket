// 컨테이너 실행기 시험: 컨테이너에 까는 pnpm 판은 이 패키지 package.json의 packageManager에서 읽는다(따로 적지 않는다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pnpmVersion } from './docker.mjs';

test('도구 packageManager의 pnpm 판을 읽는다(corepack 해시는 뗀다)', () => {
  assert.equal(pnpmVersion({ packageManager: 'pnpm@12.16.0' }), '12.16.0');
  assert.equal(pnpmVersion({ packageManager: 'pnpm@12.16.0+sha512.0123abcd' }), '12.16.0');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(`pnpm@${pnpmVersion(pkg)}`, pkg.packageManager.split('+')[0]);
});

test('도구 packageManager가 없거나 pnpm@x.y.z가 아니면 분명히 멈춘다', () => {
  for (const bad of [{}, { packageManager: 'yarn@4.0.0' }, { packageManager: 'pnpm' }, { packageManager: 'pnpm@latest' }, { packageManager: 'pnpm@12; rm -rf /' }]) {
    assert.throws(() => pnpmVersion(bad), /packageManager/, JSON.stringify(bad));
  }
});
