// 주문 생성 본문의 업무 규칙(domain/order-request.ts, docs/features/payment.md §2 '주문 생성의 첫 구현' 예매자·동의·금액, openapi POST /v1/orders, BUILD_ORDER PRF-161):
// 동의 판정 consentVerdict(422 둘), 예매자 판정 buyerOf(400), 등급 가격 합 priceSeats(금액·항목, 가격 없는 등급 500).
import { describe, expect, test } from 'vitest';
import { BUYER_TEXT_MAX, buyerOf, consentVerdict, type HeldSeat, type OrderConsents, priceSeats } from '../src/modules/booking/index.js';

const V = 'v3';
const OK_CONSENTS: OrderConsents = { provisionToSeller: true, salesTerms: true, consentVersion: V };

describe('consentVerdict: 동의 둘과 고지 문안 판(openapi 422)', () => {
  test('FR011_동의 둘이 true이고 판이 지금 판과 같으면 OK', () => {
    expect(consentVerdict(OK_CONSENTS, V)).toBe('OK');
  });

  test('FR011_consents가 없거나 비었으면 consent-required', () => {
    expect(consentVerdict(undefined, V)).toBe('CONSENT_REQUIRED');
    expect(consentVerdict({}, V)).toBe('CONSENT_REQUIRED');
  });

  test('FR011_판매자 제공 동의(provisionToSeller)가 없거나 false면 consent-required', () => {
    expect(consentVerdict({ salesTerms: true, consentVersion: V }, V)).toBe('CONSENT_REQUIRED');
    expect(consentVerdict({ ...OK_CONSENTS, provisionToSeller: false }, V)).toBe('CONSENT_REQUIRED');
  });

  test('FR011_판매 조건 동의(salesTerms)가 없거나 false면 consent-required', () => {
    expect(consentVerdict({ provisionToSeller: true, consentVersion: V }, V)).toBe('CONSENT_REQUIRED');
    expect(consentVerdict({ ...OK_CONSENTS, salesTerms: false }, V)).toBe('CONSENT_REQUIRED');
  });

  test('FR011_동의 둘이 true여도 consentVersion이 없으면 consent-required', () => {
    expect(consentVerdict({ provisionToSeller: true, salesTerms: true }, V)).toBe('CONSENT_REQUIRED');
  });

  test('FR011_판이 지금 판과 다르면 consent-version-outdated다. 비교는 글 그대로(대소문자·앞뒤 글자도 다르면 다름)', () => {
    expect(consentVerdict({ ...OK_CONSENTS, consentVersion: 'v2' }, V)).toBe('CONSENT_VERSION_OUTDATED');
    expect(consentVerdict({ ...OK_CONSENTS, consentVersion: 'V3' }, V)).toBe('CONSENT_VERSION_OUTDATED');
    expect(consentVerdict({ ...OK_CONSENTS, consentVersion: 'v3.0' }, V)).toBe('CONSENT_VERSION_OUTDATED');
    expect(consentVerdict({ ...OK_CONSENTS, consentVersion: 'v3' }, 'v3.1')).toBe('CONSENT_VERSION_OUTDATED');
  });

  test('FR011_동의가 빠진 것이 판보다 먼저다: 동의 하나가 false이고 판도 다르면 consent-required', () => {
    expect(consentVerdict({ provisionToSeller: false, salesTerms: true, consentVersion: 'v2' }, V)).toBe('CONSENT_REQUIRED');
    expect(consentVerdict({ provisionToSeller: true, salesTerms: false, consentVersion: 'v2' }, V)).toBe('CONSENT_REQUIRED');
  });
});

describe('buyerOf: 예매자 성명·번호(400)', () => {
  test('PT52_FR011_성명은 받은 그대로, 번호는 E.164로 맞춘 값이다', () => {
    expect(buyerOf({ name: '홍길동', phone: '010-1234-5678' })).toEqual({ name: '홍길동', phoneE164: '+821012345678' });
    expect(buyerOf({ name: 'Kim Minji', phone: '+82 10-1234-5678' })).toEqual({ name: 'Kim Minji', phoneE164: '+821012345678' });
    expect(buyerOf({ name: 'Ann', phone: '+1 415 555 0100' })).toEqual({ name: 'Ann', phoneE164: '+14155550100' });
  });

  test('FR011_성명의 앞뒤 빈칸도 고치지 않는다', () => {
    expect(buyerOf({ name: '  홍길동 ', phone: '01012345678' })).toEqual({ name: '  홍길동 ', phoneE164: '+821012345678' });
  });

  test('FR011_성명이나 번호가 없거나 빈 글이면 undefined', () => {
    expect(buyerOf({})).toBeUndefined();
    expect(buyerOf({ name: '홍길동' })).toBeUndefined();
    expect(buyerOf({ phone: '010-1234-5678' })).toBeUndefined();
    expect(buyerOf({ name: '', phone: '010-1234-5678' })).toBeUndefined();
    expect(buyerOf({ name: '홍길동', phone: '' })).toBeUndefined();
  });

  test('FR011_길이 상한은 100자다: 성명 100자는 받고 101자는 받지 않는다', () => {
    expect(BUYER_TEXT_MAX).toBe(100);
    expect(buyerOf({ name: '가'.repeat(100), phone: '010-1234-5678' })).toEqual({ name: '가'.repeat(100), phoneE164: '+821012345678' });
    expect(buyerOf({ name: '가'.repeat(101), phone: '010-1234-5678' })).toBeUndefined();
    expect(buyerOf({ name: 'a'.repeat(101), phone: '010-1234-5678' })).toBeUndefined();
  });

  test('FR011_번호 글도 100자 상한이다: E.164로는 맞출 수 있는 번호라도 빈칸을 채워 101자면 받지 않는다(100자는 받는다)', () => {
    const phone = '010-1234-5678';
    const pad100 = phone + ' '.repeat(100 - phone.length);
    const pad101 = phone + ' '.repeat(101 - phone.length);
    expect(pad100).toHaveLength(100);
    expect(buyerOf({ name: '홍길동', phone: pad100 })).toEqual({ name: '홍길동', phoneE164: '+821012345678' });
    expect(buyerOf({ name: '홍길동', phone: pad101 })).toBeUndefined();
  });

  // 리뷰 고침 L1(2026-11-05): C0(U+0000~001F)·C1(U+007F~009F) 제어 문자가 든 성명·번호는 받지 않는다(빈칸 U+0020은 제어 문자가 아니다)
  const CONTROLS = ['\u0000', '\u0007', '\t', '\n', '\r', '\u001f', '\u007f', '\u0085', '\u009f'];

  test.each(CONTROLS.map((ch) => [JSON.stringify(ch), ch]))('ASVS2.2.1_성명에 제어 문자 %s가 있으면 undefined다 [ASVS v5.0.0-2.2.1]', (_label, ch) => {
    expect(buyerOf({ name: `홍${ch}길동`, phone: '010-1234-5678' })).toBeUndefined();
    expect(buyerOf({ name: `홍길동${ch}`, phone: '010-1234-5678' })).toBeUndefined();
  });

  test.each(CONTROLS.map((ch) => [JSON.stringify(ch), ch]))('ASVS2.2.1_번호에 제어 문자 %s가 있으면(빈칸처럼 빼지 않고) undefined다 [ASVS v5.0.0-2.2.1]', (_label, ch) => {
    expect(buyerOf({ name: '홍길동', phone: `010-1234${ch}5678` })).toBeUndefined();
  });

  test('FR011_제어 문자가 아닌 글자는 받는다: 빈칸(U+0020)·U+00A0·U+00A1·한글·이모지', () => {
    expect(buyerOf({ name: 'Kim Min ji¡ 😀', phone: '010 1234 5678' })).toEqual({ name: 'Kim Min ji¡ 😀', phoneE164: '+821012345678' });
  });

  test('FR011_번호를 E.164로 맞출 수 없으면 undefined(짧은 번호, 글자 섞임, +820…, 국가 번호 없음)', () => {
    for (const phone of ['1234', '010-1234-567a', '+8200-1234-5678', '821012345678', '+1234567', 'abc']) {
      expect({ phone, got: buyerOf({ name: '홍길동', phone }) }).toEqual({ phone, got: undefined });
    }
  });
});

const seat = (seatId: string, tierId: string, sectionId = 'SEC-A'): HeldSeat => ({ seatId, tierId, sectionId });

describe('priceSeats: 홀드 좌석의 등급 가격 합(payment §2 금액)', () => {
  test('FR011_금액은 등급 가격 합이고 항목은 좌석 차례 그대로 unitPrice = 등급 가격이다', () => {
    const seats = [seat('A01', 'R'), seat('A02', 'R'), seat('B01', 'S', 'SEC-B')];
    expect(priceSeats(seats, { R: 110_000, S: 88_000 })).toEqual({
      status: 'OK',
      amount: 308_000,
      items: [
        { seatId: 'A01', tierId: 'R', sectionId: 'SEC-A', unitPrice: 110_000 },
        { seatId: 'A02', tierId: 'R', sectionId: 'SEC-A', unitPrice: 110_000 },
        { seatId: 'B01', tierId: 'S', sectionId: 'SEC-B', unitPrice: 88_000 },
      ],
    });
  });

  test('FR011_좌석 차례를 바꾸지 않는다(정렬하지 않는다)', () => {
    const r = priceSeats([seat('B01', 'S', 'SEC-B'), seat('A01', 'R')], { R: 1, S: 2 });
    expect(r.status === 'OK' && r.items.map((i) => i.seatId)).toEqual(['B01', 'A01']);
  });

  test('FR011_가격 0원 등급은 가격이 있는 것이다(없음이 아니다): 합 0도 OK', () => {
    expect(priceSeats([seat('A01', 'FREE')], { FREE: 0 })).toEqual({ status: 'OK', amount: 0, items: [{ seatId: 'A01', tierId: 'FREE', sectionId: 'SEC-A', unitPrice: 0 }] });
  });

  test('FR011_판에 없는 등급의 가격이 더 있어도 쓰지 않을 뿐이다', () => {
    expect(priceSeats([seat('A01', 'R')], { R: 5_000, VIP: 1, ZZZ: 2 })).toMatchObject({ status: 'OK', amount: 5_000 });
  });

  test('FR011_가격이 없는 등급이 있으면 PRICE_MISSING이고, 좌석 차례로 처음 만난 그 등급을 알린다', () => {
    expect(priceSeats([seat('A01', 'R'), seat('B01', 'S'), seat('C01', 'T')], { R: 1 })).toEqual({ status: 'PRICE_MISSING', tierId: 'S' });
    expect(priceSeats([seat('A01', 'R')], {})).toEqual({ status: 'PRICE_MISSING', tierId: 'R' });
  });

  test("FR011_자기 속성만 본다: 'toString'·'constructor'·'hasOwnProperty'·'__proto__' 같은 이름의 등급도 칸이 없으면 PRICE_MISSING", () => {
    for (const tierId of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
      expect({ tierId, r: priceSeats([seat('A01', tierId)], { R: 1 }) }).toEqual({ tierId, r: { status: 'PRICE_MISSING', tierId } });
    }
  });

  test('FR011_프로토타입이 없는 가격 표(판 파일 해석이 돌려주는 모양)도 읽는다', () => {
    const prices = Object.freeze(Object.assign(Object.create(null) as Record<string, number>, { R: 7_000, toString: 3 }));
    expect(priceSeats([seat('A01', 'R'), seat('A02', 'toString')], prices)).toMatchObject({ status: 'OK', amount: 7_003 });
    expect(priceSeats([seat('A01', 'S')], prices)).toEqual({ status: 'PRICE_MISSING', tierId: 'S' });
  });

  test('FR011_던지지 않는다', () => {
    expect(() => priceSeats([seat('A01', 'X')], {})).not.toThrow();
  });

  // 리뷰 고침 L5(2026-11-05): 합이 주문 금액 칸(PostgreSQL int4)을 넘으면 설정 오류다(주문 저장소의 RangeError 500보다 먼저, 설정 오류 로그를 남기게)
  test('FR011_합이 int4(2,147,483,647)와 같으면 OK이고, 넘으면 AMOUNT_OUT_OF_RANGE다', () => {
    const INT4_MAX = 2_147_483_647;
    expect(priceSeats([seat('A01', 'R'), seat('A02', 'S')], { R: INT4_MAX - 1, S: 1 })).toMatchObject({ status: 'OK', amount: INT4_MAX });
    expect(priceSeats([seat('A01', 'R'), seat('A02', 'S')], { R: INT4_MAX - 1, S: 2 })).toEqual({ status: 'AMOUNT_OUT_OF_RANGE' });
    expect(priceSeats(Array.from({ length: 10 }, (_, i) => seat(`A${i}`, 'R')), { R: INT4_MAX })).toEqual({ status: 'AMOUNT_OUT_OF_RANGE' });
  });

  test('FR011_가격 없는 등급이 합 넘침보다 먼저다(좌석 차례로 보다 가격 없는 등급을 만나면 PRICE_MISSING)', () => {
    expect(priceSeats([seat('A01', 'R'), seat('A02', 'R'), seat('A03', 'T')], { R: 2_000_000_000 })).toEqual({ status: 'PRICE_MISSING', tierId: 'T' });
  });
});
