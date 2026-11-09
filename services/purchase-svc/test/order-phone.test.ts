// 예매자 휴대폰 번호의 E.164 맞추기(domain/phone.ts toE164, docs/features/payment.md §2 '주문 생성의 첫 구현' 예매자·동의, BUILD_ORDER PRF-161).
// identity-svc toE164(services/identity-svc/src/modules/session/domain/inv-ref.ts)와 같은 규칙이어야 두 서비스의 조사용 가명이 같아진다(P-T52 ①②).
// 그래서 identity-svc 시험(test/investigation.test.ts 'I-T64')의 시험 벡터를 그대로 옮기고(identity는 null, 여기는 undefined), 경계를 더 본다.
import { describe, expect, test } from 'vitest';
import { toE164 } from '../src/modules/booking/index.js';

/** identity-svc 시험 벡터(test/investigation.test.ts I-T64) 그대로. 맞출 수 없는 값은 identity의 null 대신 undefined */
const IDENTITY_VECTORS: [string, string | undefined][] = [
  ['010-1234-5678', '+821012345678'],
  ['+82 10 1234 5678', '+821012345678'],
  ['01012345678', '+821012345678'],
  ['+1 415 555 0100', '+14155550100'],
  ['+82 010-1234-5678', '+821012345678'],
  ['0082 10-1234-5678', '+821012345678'],
  ['0082 010-1234-5678', '+821012345678'],
  ['1234', undefined],
  ['010-1234-567a', undefined],
];

describe('toE164: identity-svc와 같은 규칙', () => {
  test.each(IDENTITY_VECTORS)('PT52_identity 시험 벡터 %j → %j', (raw, want) => {
    expect(toE164(raw)).toBe(want);
  });

  test('PT52_①_국내 표기 010-1234-5678과 국제 표기 +82 10-1234-5678, +82 010…, 0082…는 모두 같은 글 +821012345678이 된다(두 주문의 contactRef가 같아지는 바탕)', () => {
    const forms = ['010-1234-5678', '+82 10-1234-5678', '+82 010-1234-5678', '0082 10 1234 5678', '0082 010 1234 5678', '(010) 1234.5678', '010 1234 5678'];
    expect(new Set(forms.map(toE164))).toEqual(new Set(['+821012345678']));
  });

  test('빈칸·하이픈·괄호·점만 뺀다: 밑줄·빗금·별표 같은 다른 기호가 남으면 맞추지 않는다', () => {
    expect(toE164('(+1) 415.555-0100')).toBe('+14155550100');
    for (const raw of ['010_1234_5678', '010/1234/5678', '010*1234*5678', '010#12345678', '010,1234,5678']) expect({ raw, got: toE164(raw) }).toEqual({ raw, got: undefined });
  });

  test("'+'는 맨 앞 하나만 받는다: 가운데·두 번 쓴 '+'는 맞추지 않는다", () => {
    for (const raw of ['82+1012345678', '++821012345678', '+82+1012345678', '0101234567+8']) expect({ raw, got: toE164(raw) }).toEqual({ raw, got: undefined });
  });

  test('ASCII 숫자만 숫자로 본다: 전각 숫자·아랍 숫자(٨) 같은 다른 숫자 글자는 맞추지 않는다', () => {
    expect(toE164('０１０-１２３４-５６７８')).toBeUndefined();
    expect(toE164('010-1234-567٨')).toBeUndefined();
  });

  test('빈 글, 기호만, + 하나, 00만은 맞추지 않는다', () => {
    for (const raw of ['', '   ', '---', '()', '+', '00', '000', '+ ']) expect({ raw, got: toE164(raw) }).toEqual({ raw, got: undefined });
  });

  test("'0'·'+'·'00' 밖의 숫자(1~9)로 시작하면 국가 번호를 알 수 없어 맞추지 않는다", () => {
    expect(toE164('821012345678')).toBeUndefined();
    expect(toE164('1012345678')).toBeUndefined();
    expect(toE164('4155550100')).toBeUndefined();
  });
});

describe('toE164: +820(국제 표기에 남은 국내 앞자리 0)과 국가 번호 첫 숫자', () => {
  test("'+820'으로 시작하면 0 하나만 빼고, 빼고도 '+820'으로 시작하면 E.164가 아니라 맞추지 않는다(같은 번호가 다른 가명이 되지 않게)", () => {
    expect(toE164('+82 010 1234 5678')).toBe('+821012345678');
    // 0이 둘 남은 모양: 하나를 빼도 +820…이다
    expect(toE164('+82 00 1234 5678')).toBeUndefined();
    expect(toE164('+8200-1234-5678')).toBeUndefined();
    expect(toE164('0082 00 1234 5678')).toBeUndefined();
    // 0을 빼고 남는 것이 없거나 짧으면 자릿수에서 걸린다
    expect(toE164('+820')).toBeUndefined();
    expect(toE164('+82 0')).toBeUndefined();
  });

  test("'+' 뒤 첫 숫자는 0이 아니다: +0…·00 0…은 맞추지 않는다", () => {
    expect(toE164('+0 10 1234 5678')).toBeUndefined();
    expect(toE164('000 10 1234 5678')).toBeUndefined();
  });
});

describe("toE164: 자릿수 경계('+' 뒤 숫자 8~15자리)", () => {
  test('국제 표기: 7자리는 맞추지 않고 8자리는 맞추며, 15자리는 맞추고 16자리는 맞추지 않는다', () => {
    expect(toE164('+1234567')).toBeUndefined();
    expect(toE164('+12345678')).toBe('+12345678');
    expect(toE164('+123456789012345')).toBe('+123456789012345');
    expect(toE164('+1234567890123456')).toBeUndefined();
  });

  test('국내 표기(0 + 나머지 → +82 + 나머지): 결과가 7자리(012345)면 맞추지 않고 8자리(0123456)면 맞춘다. 15자리는 맞추고 16자리는 맞추지 않는다', () => {
    expect(toE164('012345')).toBeUndefined();
    expect(toE164('0123456')).toBe('+82123456');
    expect(toE164('01234567890123')).toBe('+821234567890123');
    expect(toE164('012345678901234')).toBeUndefined();
  });

  test('국제전화 앞자리 00 표기도 같은 경계다: 0012345678(8자리)은 맞추고 001234567(7자리)·001234567890123456(16자리)은 맞추지 않는다', () => {
    expect(toE164('0012345678')).toBe('+12345678');
    expect(toE164('001234567')).toBeUndefined();
    expect(toE164('001234567890123456')).toBeUndefined();
  });

  test('기호는 자릿수에 들지 않는다: 하이픈·빈칸이 많아도 숫자 자릿수로만 본다', () => {
    expect(toE164('+1-2-3-4-5-6-7-8')).toBe('+12345678');
    expect(toE164('+1 2 3 4 5 6 7')).toBeUndefined();
  });
});
