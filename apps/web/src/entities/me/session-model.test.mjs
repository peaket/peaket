// 팬 계정 요약(GET /v1/identity/me) → 화면 값(ADR-0202 결정 1·2·3, BUILD_ORDER HOT-321)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalCta, shellUserOf, toMember } from './session-model.ts';

test('요약을 화면의 로그인한 팬으로: 닉네임 첫 글자(문자소)가 아바타 글자, 가입을 마치기 전이면 표시 이름은 "회원"', () => {
  assert.deepEqual(toMember({ nickname: '지민', signupCompleted: true, verified: true, hasStaffAssignment: false }), {
    name: '지민',
    avatarText: '지',
    verified: true,
    signupCompleted: true,
    hasStaffAssignment: false,
  });
  assert.equal(toMember({ nickname: '👩‍🎤루멘', signupCompleted: true, verified: false, hasStaffAssignment: true }).avatarText, '👩‍🎤');
  const pending = toMember({ nickname: null, signupCompleted: false, verified: false, hasStaffAssignment: false });
  assert.deepEqual([pending.name, pending.avatarText, pending.signupCompleted], ['회원', '회', false]);
});

test('셸 머리 사용자: 받기 전은 빈자리(undefined), 비로그인·모름은 [로그인](null), 로그인이면 계정 메뉴', () => {
  assert.equal(shellUserOf({ status: 'loading' }), undefined);
  assert.equal(shellUserOf({ status: 'guest' }), null);
  assert.equal(shellUserOf({ status: 'unknown' }), null);
  const me = toMember({ nickname: '지민', signupCompleted: true, verified: true, hasStaffAssignment: true });
  assert.deepEqual(shellUserOf({ status: 'member', me }), { name: '지민', avatarText: '지', verified: true, hasStaffAssignment: true });
});

test('공연 상세 예매 버튼의 개인 상태: 들어갈 수 있는 상태에만 덮고, 모르면 덮지 않는다', () => {
  const verified = { status: 'member', me: toMember({ nickname: '지민', signupCompleted: true, verified: true, hasStaffAssignment: false }) };
  const unverified = { status: 'member', me: toMember({ nickname: '지민', signupCompleted: true, verified: false, hasStaffAssignment: false }) };
  const pending = { status: 'member', me: toMember({ nickname: null, signupCompleted: false, verified: false, hasStaffAssignment: false }) };
  for (const phase of ['notYet', 'lobby', 'queue']) {
    assert.equal(personalCta(phase, { status: 'guest' }), 'login', phase);
    assert.equal(personalCta(phase, unverified), 'verify', phase);
    assert.equal(personalCta(phase, pending), 'signup', phase);
    assert.equal(personalCta(phase, verified), null, phase);
    assert.equal(personalCta(phase, { status: 'unknown' }), null, `${phase}: 모르면 진입 경로가 막는다`);
    assert.equal(personalCta(phase, { status: 'loading' }), 'loading', `${phase}: 받기 전은 뼈대`);
  }
  for (const phase of ['closed', 'fifo', 'pending', 'ended', 'cancelled', undefined]) {
    assert.equal(personalCta(phase, { status: 'guest' }), null, String(phase));
    assert.equal(personalCta(phase, unverified), null, String(phase));
    assert.equal(personalCta(phase, { status: 'loading' }), null, String(phase));
  }
});
