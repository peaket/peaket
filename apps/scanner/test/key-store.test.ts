// SCR-036 스태프 토큰 저장·만료 경계 시험(BAT-450). IndexedDB가 없는 Node에서는 순수 함수만 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStoredSession, sessionExpired } from '../src/api/key-store.ts';

test('토큰 만료 경계는 정확히 만료 시각부터 만료다', () => {
  const s = { token: 'staff-token', expiresAtMs: 1_000 };
  assert.equal(sessionExpired(s, 999), false);
  assert.equal(sessionExpired(s, 1_000), true);
  assert.equal(sessionExpired(s, 1_001), true);
});

test('저장값은 새 JSON 객체와 옛 문자열 토큰을 모두 읽고, 깨진 값은 버린다', () => {
  assert.deepEqual(parseStoredSession(JSON.stringify({ token: 'a', expiresAtMs: 2_000 })), { token: 'a', expiresAtMs: 2_000 });
  assert.deepEqual(parseStoredSession('legacy-token'), { token: 'legacy-token', expiresAtMs: Number.MAX_SAFE_INTEGER });
  assert.equal(parseStoredSession(''), undefined);
  assert.equal(parseStoredSession(null), undefined);
  assert.equal(parseStoredSession(JSON.stringify({ token: '' })), undefined);
  assert.equal(parseStoredSession(JSON.stringify({ token: 'a', expiresAtMs: 'soon' })), undefined);
});
