// 서버 액션 암호화 키 형식 확인 시험(docs/security/secrets-and-keys.md, BUILD_ORDER BAS-220)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertServerActionsKey, checkServerActionsKey } from './server-actions-key.mjs';

test('32바이트 키의 표준 base64만 받는다(Next.js가 atob 뒤 AES-GCM 원문 키로 읽는다)', () => {
  assert.deepEqual(checkServerActionsKey(randomBytes(32).toString('base64')), { ok: true });
  assert.match(checkServerActionsKey(undefined).reason, /없다/);
  assert.match(checkServerActionsKey('').reason, /없다/);
  assert.match(checkServerActionsKey(randomBytes(16).toString('base64')).reason, /32바이트/);
  assert.match(checkServerActionsKey(randomBytes(32).toString('base64url')).reason, /base64/);
  assert.match(checkServerActionsKey('not base64!').reason, /base64/);
});

test('Node 운영 서버가 뜰 때만 보고, 빌드 작업자·개발 서버·edge 실행 환경은 키가 없어도 지나간다', () => {
  const prod = { NEXT_RUNTIME: 'nodejs', NODE_ENV: 'production' };
  assert.throws(() => assertServerActionsKey(prod), /서버 액션 암호화 키/);
  assert.throws(() => assertServerActionsKey({ ...prod, NEXT_PHASE: 'phase-production-server' }), /서버 액션 암호화 키/);
  assert.doesNotThrow(() => assertServerActionsKey({ ...prod, NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64') }));
  assert.doesNotThrow(() => assertServerActionsKey({ ...prod, NEXT_PHASE: 'phase-production-build' }));
  assert.doesNotThrow(() => assertServerActionsKey({ NEXT_RUNTIME: 'nodejs', NODE_ENV: 'development' }));
  assert.doesNotThrow(() => assertServerActionsKey({ NEXT_RUNTIME: 'edge', NODE_ENV: 'production' }));
});

test('한 바이트만 되풀이한 키(예: 0으로 채운 키)는 받지 않는다(새 맥락 리뷰 재현)', () => {
  assert.match(checkServerActionsKey(Buffer.alloc(32).toString('base64')).reason, /되풀이/);
});
