// 후기 운영자 조치 입력 시험(POL-044). node --test가 .ts를 타입 지우기로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModerationPayload } from './moderation.ts';

const now = Date.parse('2026-11-14T00:00:00Z');

test('SCR016_ 임시조치는 위반 유형·30일 안 끝 시각·사유가 필요하다', () => {
  assert.deepEqual(
    buildModerationPayload({ action: 'TEMP_BLOCK', reason: '권리 침해', violation: 'RIGHTS', endsAt: '2026-11-21T14:59:59Z', nowMs: now }),
    { ok: true, body: { action: 'TEMP_BLOCK', reason: '권리 침해', violation: 'RIGHTS', endsAt: '2026-11-21T14:59:59.000Z' } },
  );
  assert.equal(buildModerationPayload({ action: 'TEMP_BLOCK', reason: '사유', endsAt: '2026-11-21T14:59:59Z', nowMs: now }).ok, false);
  assert.equal(buildModerationPayload({ action: 'TEMP_BLOCK', reason: '사유', violation: 'RIGHTS', endsAt: '2026-11-13T00:00:00Z', nowMs: now }).ok, false);
  assert.equal(buildModerationPayload({ action: 'TEMP_BLOCK', reason: '사유', violation: 'RIGHTS', endsAt: '2026-12-20T00:00:00Z', nowMs: now }).ok, false);
});

test('SCR016_ 노출 차단은 위반 유형, 해제는 사유만 있으면 된다', () => {
  assert.deepEqual(buildModerationPayload({ action: 'BLOCK', reason: '운영정책 위반', violation: 'ABUSE', nowMs: now }), {
    ok: true,
    body: { action: 'BLOCK', reason: '운영정책 위반', violation: 'ABUSE' },
  });
  assert.deepEqual(buildModerationPayload({ action: 'RELEASE', reason: '이의 인정', nowMs: now }), { ok: true, body: { action: 'RELEASE', reason: '이의 인정' } });
  assert.equal(buildModerationPayload({ action: 'RELEASE', reason: '  ', nowMs: now }).ok, false);
});
