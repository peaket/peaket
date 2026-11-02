// 돌아갈 주소 safeNext()(docs/frontend.md §5.14 '돌아갈 주소', FE-T12, asvs/auth.md 3.7.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from './safe-next.ts';

test('FE-T12 같은 출처 경로와 쿼리만 받고 조각은 버린다', () => {
  assert.equal(safeNext('/my/tickets'), '/my/tickets');
  assert.equal(safeNext('/search?q=%EA%B3%B5%EC%97%B0&page=2'), '/search?q=%EA%B3%B5%EC%97%B0&page=2');
  assert.equal(safeNext('/my/tickets#token=abc'), '/my/tickets');
});

test('FE-T12 다른 사이트로 가는 모양은 첫 화면으로 보낸다', () => {
  for (const bad of [
    '//evil.example/x',
    '/\\evil.example',
    'https://evil.example/',
    'javascript:alert(1)',
    'my/tickets',
    '/%2f%2fevil.example',
    '/%2F%2Fevil.example',
    '/%5c%5cevil.example',
    '/a/%5Cb',
    '/a/../%2f%2fevil',
    '/..//evil.example',
    '/a\u0000b',
    '/a\nb',
    `/${'a'.repeat(512)}`,
    '',
    undefined,
    null,
    42,
  ]) {
    assert.equal(safeNext(bad), '/', String(bad));
  }
  assert.equal(safeNext(`/${'a'.repeat(511)}`), `/${'a'.repeat(511)}`);
});
