// SCR-036 스태프 토큰 저장·만료 경계 시험(BAT-450). IndexedDB가 없는 Node에서는 순수 함수만 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrollWithNewDeviceKey, parseStoredSession, sessionExpired } from '../src/api/key-store.ts';
import type { DpopKey } from '../src/api/dpop.ts';

test('토큰 만료 경계는 정확히 만료 시각부터 만료다', () => {
  const s = { token: 'staff-token', expiresAtMs: 1_000 };
  assert.equal(sessionExpired(s, 999), false);
  assert.equal(sessionExpired(s, 1_000), true);
  assert.equal(sessionExpired(s, 1_001), true);
});

test('기기 등록·재등록은 새 키를 만들고, 등록이 실패하면 저장하지 않는다(C1-12)', async () => {
  const fresh = { jkt: 'fresh' } as unknown as DpopKey;
  let saved: DpopKey | undefined;
  await enrollWithNewDeviceKey({ generate: async () => fresh, enroll: async (key) => assert.equal(key, fresh), save: async (key) => void (saved = key) });
  assert.equal(saved, fresh);

  saved = undefined;
  await assert.rejects(
    enrollWithNewDeviceKey({ generate: async () => fresh, enroll: async () => { throw new Error('등록 거절'); }, save: async (key) => void (saved = key) }),
    /등록 거절/,
  );
  assert.equal(saved, undefined);
});

test('저장값은 새 JSON 객체와 옛 문자열 토큰을 모두 읽고, 깨진 값은 버린다', () => {
  assert.deepEqual(parseStoredSession(JSON.stringify({ token: 'a', expiresAtMs: 2_000 })), { token: 'a', expiresAtMs: 2_000 });
  assert.deepEqual(parseStoredSession('legacy-token'), { token: 'legacy-token', expiresAtMs: Number.MAX_SAFE_INTEGER });
  assert.equal(parseStoredSession(''), undefined);
  assert.equal(parseStoredSession(null), undefined);
  assert.equal(parseStoredSession(JSON.stringify({ token: '' })), undefined);
  assert.equal(parseStoredSession(JSON.stringify({ token: 'a', expiresAtMs: 'soon' })), undefined);
});
