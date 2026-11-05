// SCR-005 가입 마무리 폼의 규칙(d5 §5.5, ADR-0203 결정 1·2, BUILD_ORDER HOT-323)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nicknameProblem, normalizeNickname, phoneDigits, toSignupInput, validateSignup, ERRORS } from './signup.ts';

const ok = { age: true, terms: true, privacy: true, marketing: false, phoneConsent: false, phone: '', nickname: '피켓팬', nick: 'ok' };

test('닉네임 규칙: NFC·앞뒤 공백, 문자소 2~12개, 글자·숫자·가운데 공백 한 칸·_·.·-만(이모지·기호 불가)', () => {
  assert.equal(normalizeNickname('  루멘 팬 '), '루멘 팬');
  assert.equal(normalizeNickname('각'), '각', 'NFC');
  for (const good of ['지민', 'LUMEN_fan', 'a.b-c', '루멘 팬', 'Ölçek', '一二三', '열두글자열두글자열두글자']) assert.equal(nicknameProblem(good), null, good);
  assert.equal(nicknameProblem('지'), 'length');
  assert.equal(nicknameProblem('열두글자를넘는닉네임입니다'), 'length');
  for (const bad of ['루멘🎤', '👩‍🎤팬', 'a  b', 'a\tb', '<b>', 'ab!', '#tag']) assert.equal(nicknameProblem(bad), 'chars', bad);
  // 이모지 표시 문자(키캡·변형 선택자·ZWJ)와 그림 문자는 결합 표시로 숨어 들어와도 막는다(HOT-323 새 맥락 리뷰 낮음 7)
  for (const bad of ['1️⃣2️⃣', '가️나', 'ab‍c', '가나❤']) assert.equal(nicknameProblem(bad), 'chars', JSON.stringify(bad));
  // 한 글자에 결합 표시를 셋 넘게 붙이면 막고(문자소 수로는 안 보인다), UTF-16 64자를 넘으면 막는다
  assert.equal(nicknameProblem('a' + '́'.repeat(60) + 'b'), 'chars');
  assert.equal(nicknameProblem('नमस्ते'), null, '데바나가리 결합 글자는 받는다');
  assert.equal(nicknameProblem(''), 'empty');
  assert.equal(nicknameProblem('   '), 'empty');
});

test('휴대폰 번호는 숫자만 남긴다', () => {
  assert.equal(phoneDigits('010-1234-5678'), '01012345678');
  assert.equal(phoneDigits(' 010 1234 5678 '), '01012345678');
});

test('검사: 필수 확인·동의·닉네임·동의한 휴대폰 번호를 위에서부터 칸 id와 문구로 낸다', () => {
  assert.deepEqual(validateSignup(ok), []);
  assert.deepEqual(
    validateSignup({ ...ok, age: false, terms: false, privacy: false, nickname: '' }).map((e) => e.fieldId),
    ['c-age', 'c-terms', 'c-privacy', 'f-nick'],
  );
  assert.equal(validateSignup({ ...ok, age: false })[0].message, ERRORS.age);
  assert.deepEqual(validateSignup({ ...ok, nickname: '루멘🎤' }), [{ fieldId: 'f-nick', message: ERRORS.nickChars }]);
  assert.deepEqual(validateSignup({ ...ok, nick: 'taken' }), [{ fieldId: 'f-nick', message: ERRORS.nickTaken }]);
  // 휴대폰 번호는 동의했을 때만 본다
  assert.deepEqual(validateSignup({ ...ok, phoneConsent: false, phone: '123' }), []);
  assert.deepEqual(validateSignup({ ...ok, phoneConsent: true, phone: '' }), [{ fieldId: 'f-phone', message: ERRORS.phone }]);
  assert.deepEqual(validateSignup({ ...ok, phoneConsent: true, phone: '010-1234-567' }), [{ fieldId: 'f-phone', message: ERRORS.phone }]);
  assert.deepEqual(validateSignup({ ...ok, phoneConsent: true, phone: '010-1234-5678' }), []);
});

test('요청 본문: 동의 넷, 정규화한 닉네임, 휴대폰 번호는 동의했을 때만 숫자로', () => {
  assert.deepEqual(toSignupInput({ ...ok, nickname: ' 피켓팬 ', marketing: true }), {
    ageOver14: true,
    consents: { terms: true, privacy: true, marketing: true, phone: false },
    nickname: '피켓팬',
  });
  assert.deepEqual(toSignupInput({ ...ok, phoneConsent: true, phone: '010-1234-5678' }), {
    ageOver14: true,
    consents: { terms: true, privacy: true, marketing: false, phone: true },
    nickname: '피켓팬',
    phone: '01012345678',
  });
  assert.equal(toSignupInput({ ...ok, phoneConsent: false, phone: '010-1234-5678' }).phone, undefined);
});
