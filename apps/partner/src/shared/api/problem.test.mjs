// I-T53·J-T26 화면이 problem+json을 같은 문구로 바꾸는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNotFound, isPartnerAdminRequired, isReauthRequired, isRetentionEnded, problemMessage } from './problem.ts';

test('I-T53 재인증 오류를 알아본다', () => {
  assert.equal(isReauthRequired({ status: 403, type: 'reauth-required' }), true);
  assert.match(problemMessage({ status: 403, type: 'reauth-required' }, '기본'), /다시 인증/);
});

test('J-T26 보유 기간 끝과 관리자 전용을 가른다', () => {
  assert.equal(isRetentionEnded({ status: 410, type: 'retention-ended' }), true);
  assert.equal(isPartnerAdminRequired({ status: 403, type: 'partner-admin-required' }), true);
  assert.match(problemMessage({ status: 410, type: 'retention-ended' }, '기본'), /보유 기간/);
});

test('없는 자원과 서버 오류를 구분한다', () => {
  assert.equal(isNotFound({ status: 404, type: 'not-found' }), true);
  assert.match(problemMessage({ status: 500 }, '기본'), /서버가 응답하지/);
  assert.equal(problemMessage(new TypeError('fetch failed'), '기본'), '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
});
