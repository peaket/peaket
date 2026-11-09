// 결제 수단 연결값 단위 시험(P-T50의 시뮬레이터 몫, BUILD_ORDER HOT-145, docs/features/payment.md §2.1 '결제 수단 연결값의 첫 구현').
// 계산식, 함께 있거나 함께 빔, refMissing 조건, 대응표, 라벨 키 설정, 값이 결과·객체에 새지 않음을 본다.
import { createHmac, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { PlatformMetrics } from '@peaket/platform';
import { describe, expect, test, vi } from 'vitest';
import { portoneCardOf, tossCardOf } from '../src/modules/payment/adapters/pg/card-fields.js';
import { PayRefKeyRing } from '../src/modules/payment/adapters/pay-ref-key-ring.js';
import { PromPaymentMethodRefSignals } from '../src/modules/payment/adapters/prom-payment-method-ref-signals.js';
import { paymentMethodLinkOf } from '../src/modules/payment/domain/payment-method-ref.js';
import type { ConfirmCard } from '../src/modules/payment/domain/payment-gateway.js';

const KEY = randomBytes(32);
const ring = new PayRefKeyRing({ key: KEY, version: 3 });
const refOf = (value: string): string => `k3.${createHmac('sha256', KEY).update(value, 'utf8').digest('base64url')}`;

const toss: ConfirmCard = { maskedNumber: '43301234****123*', bin: '433012', issuerCode: 'HYUNDAI', cardType: 'CREDIT' };

describe('P-T50 계산식', () => {
  test('P-T50_토스 모양: BIN·보이는 끝자리·발급사·종류를 이어 invRef를 만들고 cardBin은 6자리다 [ASVS v5.0.0-11.2.1]', () => {
    expect(paymentMethodLinkOf(toss, ring)).toEqual({ kind: 'LINKED', paymentMethodRef: refOf('433012|123|HYUNDAI|CREDIT'), cardBin: '433012' });
  });

  test('P-T50_포트원의 8자리 bin도 cardBin과 계산에는 앞 6자리만 쓴다', () => {
    expect(paymentMethodLinkOf({ maskedNumber: '43301234****1234', bin: '43301234', issuerCode: 'SHINHAN', cardType: 'DEBIT' }, ring)).toEqual({
      kind: 'LINKED',
      paymentMethodRef: refOf('433012|1234|SHINHAN|DEBIT'),
      cardBin: '433012',
    });
  });

  test('P-T50_발급사·종류·끝자리가 빠지면 그 자리를 빈 글자로 계산한다', () => {
    expect(paymentMethodLinkOf({ bin: '433012', issuerCode: '', cardType: '' }, ring)).toEqual({ kind: 'LINKED', paymentMethodRef: refOf('433012|||'), cardBin: '433012' });
    expect(paymentMethodLinkOf({ maskedNumber: '433012******', bin: '433012', issuerCode: 'KB', cardType: '' }, ring)).toEqual({ kind: 'LINKED', paymentMethodRef: refOf('433012||KB|'), cardBin: '433012' });
  });

  test('P-T50_같은 카드는 같은 값이고 끝자리가 다르면 다른 값이다', () => {
    const a = paymentMethodLinkOf(toss, ring);
    const b = paymentMethodLinkOf({ ...toss }, ring);
    const c = paymentMethodLinkOf({ ...toss, maskedNumber: '43301234****456*' }, ring);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test('P-T50_키 판 접두어가 값 앞에 붙는다', () => {
    const v2 = new PayRefKeyRing({ key: KEY, version: 2 });
    expect(paymentMethodLinkOf(toss, v2)).toMatchObject({ paymentMethodRef: expect.stringMatching(/^k2\.[A-Za-z0-9_-]+$/) });
  });

  test('P-T50_결과에 가린 번호·라벨 키가 없다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-14.2.4]', () => {
    const text = JSON.stringify(paymentMethodLinkOf(toss, ring));
    expect(text).not.toContain('****');
    expect(text).not.toContain(KEY.toString('hex'));
  });
});

describe('P-T50 함께 있거나 함께 빔과 refMissing', () => {
  test.each<[string, ConfirmCard | undefined]>([
    ['카드 정보 없음(계좌이체·가상계좌)', undefined],
    ['BIN도 가린 번호도 없음', { issuerCode: 'HYUNDAI', cardType: 'CREDIT' }],
  ])('P-T50_%s: 두 칸이 비고 refMissing 거짓이다(NONE)', (_n, card) => {
    expect(paymentMethodLinkOf(card, ring)).toEqual({ kind: 'NONE' });
  });

  test.each<[string, ConfirmCard]>([
    ['BIN이 숫자가 아님', { maskedNumber: '43301234****123*', bin: 'abcdef', issuerCode: 'A', cardType: 'CREDIT' }],
    ['BIN이 5자리', { bin: '43301', issuerCode: 'A', cardType: 'CREDIT' }],
    ['BIN이 9자리', { bin: '433012345', issuerCode: 'A', cardType: 'CREDIT' }],
    ['가린 번호가 다 보임(가리지 않음)', { maskedNumber: '4330123412341234', bin: '433012', issuerCode: 'A', cardType: 'CREDIT' }],
    ['가린 번호에 *가 없음(보이는 숫자가 12개 이하라 자리 수 검사로는 걸러지지 않는다)', { maskedNumber: '43301234', bin: '433012', issuerCode: 'A', cardType: 'CREDIT' }],
    ['가린 번호에 다른 글자', { maskedNumber: '4330.12**.****.1234', bin: '433012', issuerCode: 'A', cardType: 'CREDIT' }],
    ['가린 번호가 숫자로 시작하지 않음', { maskedNumber: '****1234', bin: '433012', issuerCode: 'A', cardType: 'CREDIT' }],
    ['가린 번호가 20자 넘음', { maskedNumber: `433012${'*'.repeat(15)}`, bin: '433012', issuerCode: 'A', cardType: 'CREDIT' }],
    ['보이는 숫자가 12개 넘음', { maskedNumber: '4330123412345***', bin: '433012', issuerCode: 'A', cardType: 'CREDIT' }],
  ])('P-T50_%s: 계산하지 않고 CARD_SHAPE를 센다 [ASVS v5.0.0-2.2.1]', (_n, card) => {
    const onMissing = vi.fn();
    expect(paymentMethodLinkOf(card, ring, onMissing)).toEqual({ kind: 'MISSING', reason: 'CARD_SHAPE' });
    expect(onMissing).toHaveBeenCalledExactlyOnceWith('CARD_SHAPE');
  });

  test('P-T50_리뷰 고침 H1: 라벨 키가 없으면 결제를 막지 않고 NO_KEY로 센다 [ASVS v5.0.0-16.5.2]', () => {
    const onMissing = vi.fn();
    expect(paymentMethodLinkOf(toss, undefined, onMissing)).toEqual({ kind: 'MISSING', reason: 'NO_KEY' });
    expect(paymentMethodLinkOf(toss, { ref: () => undefined }, onMissing)).toEqual({ kind: 'MISSING', reason: 'NO_KEY' });
    expect(onMissing.mock.calls).toEqual([['NO_KEY'], ['NO_KEY']]);
  });

  test('P-T50_리뷰 고침 H1: 계산이 던져도 결제를 막지 않고 NO_KEY로 센다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.5.3]', () => {
    const onMissing = vi.fn();
    expect(
      paymentMethodLinkOf(
        toss,
        {
          ref: () => {
            throw new Error('키 오류');
          },
        },
        onMissing,
      ),
    ).toEqual({ kind: 'MISSING', reason: 'NO_KEY' });
    expect(onMissing).toHaveBeenCalledExactlyOnceWith('NO_KEY');
  });

  test('P-T50_리뷰 고침 H1: 카드 정보가 없으면 라벨 키가 없어도 세지 않는다', () => {
    const onMissing = vi.fn();
    expect(paymentMethodLinkOf(undefined, undefined, onMissing)).toEqual({ kind: 'NONE' });
    expect(onMissing).not.toHaveBeenCalled();
  });

  test('P-T50_리뷰 고침 H1: 지표는 NO_KEY와 CARD_SHAPE를 처음부터 0으로 보이고 까닭별로 늘린다', async () => {
    const metrics = new PlatformMetrics('payment-svc');
    const signals = new PromPaymentMethodRefSignals().register(metrics.registry);
    const line = async (reason: string): Promise<string | undefined> => (await metrics.registry.metrics()).split('\n').find((l) => l.startsWith('inv_ref_missing_total{') && l.includes(`reason="${reason}"`));
    expect(await line('NO_KEY')).toMatch(/ 0$/);
    expect(await line('CARD_SHAPE')).toMatch(/ 0$/);
    signals.missing('NO_KEY');
    expect(await line('NO_KEY')).toMatch(/ 1$/);
    expect(await line('CARD_SHAPE')).toMatch(/ 0$/);
  });

  test('P-T50_리뷰 고침 M3: 구분자 - 를 지운 뒤 판정해 구분자 없는 번호와 같은 값이다 [ASVS v5.0.0-2.2.1]', () => {
    const onMissing = vi.fn();
    expect(paymentMethodLinkOf({ ...toss, maskedNumber: '4330-1234-****-123*' }, ring, onMissing)).toEqual(paymentMethodLinkOf(toss, ring));
    expect(onMissing).not.toHaveBeenCalled();
  });

  test('P-T50_리뷰 고침 M3: 토스 가린 번호에 구분자가 있어도 BIN은 숫자 앞 6자리다', () => {
    const card = tossCardOf({ number: '4330-1234-****-123*', issuerCode: '61', cardType: '신용' });
    expect(card?.bin).toBe('433012');
    expect(paymentMethodLinkOf(card, ring)).toEqual({ kind: 'LINKED', paymentMethodRef: refOf('433012|123|HYUNDAI|CREDIT'), cardBin: '433012' });
  });

  test.each<[string, string]>([
    ['구분자를 지워도 다 보임', '4330-1234-1234-1234'],
    ['구분자를 빼면 *가 없음', '4330-1234'],
    ['구분자를 넣어 20자를 넘김', `4330-${'*'.repeat(16)}`],
    ['구분자 말고 빈칸', '4330 1234 **** 123*'],
  ])('P-T50_리뷰 고침 M3: %s이면 CARD_SHAPE다 [ASVS v5.0.0-2.2.1]', (_n, maskedNumber) => {
    expect(paymentMethodLinkOf({ maskedNumber, bin: '433012', issuerCode: 'A', cardType: 'CREDIT' }, ring)).toEqual({ kind: 'MISSING', reason: 'CARD_SHAPE' });
  });
});

describe('P-T16 카드 칸 대응표', () => {
  const TOSS_ISSUERS: readonly [string, string][] = [
    ['3K', 'IBK_BC'], ['46', 'GWANGJUBANK'], ['71', 'LOTTE'], ['30', 'KDBBANK'], ['31', 'BC'], ['51', 'SAMSUNG'],
    ['38', 'SAEMAUL'], ['41', 'SHINHAN'], ['62', 'SHINHYEOP'], ['36', 'CITI'], ['33', 'WOORI'], ['W1', 'WOORI'],
    ['37', 'POST'], ['39', 'SAVINGBANK'], ['35', 'JEONBUKBANK'], ['42', 'JEJUBANK'], ['15', 'KAKAOBANK'], ['3A', 'KBANK'],
    ['24', 'TOSSBANK'], ['21', 'HANA'], ['61', 'HYUNDAI'], ['11', 'KOOKMIN'], ['91', 'NONGHYEOP'], ['34', 'SUHYEOP'],
    ['6D', 'DINERS'], ['4M', 'MASTER'], ['3C', 'UNIONPAY'], ['7A', 'AMEX'], ['4J', 'JCB'], ['4V', 'VISA'],
  ];

  test.each(TOSS_ISSUERS)('P-T16_토스 발급사 코드 %s는 %s다(카드사 코드 문서 2026-11-09 확인)', (code, name) => {
    expect(tossCardOf({ number: '43301234****123*', issuerCode: code, cardType: '신용' })?.issuerCode).toBe(name);
  });

  test('P-T16_토스 표에 없는 발급사 코드는 빈 글자다 [ASVS v5.0.0-2.2.1]', () => {
    expect(tossCardOf({ number: '43301234****123*', issuerCode: 'ZZ', cardType: '신용' })?.issuerCode).toBe('');
    expect(tossCardOf({ number: '43301234****123*', issuerCode: 'constructor', cardType: '신용' })?.issuerCode).toBe('');
  });

  test.each([
    ['신용', 'CREDIT'],
    ['체크', 'DEBIT'],
    ['기프트', 'GIFT'],
    ['미확인', ''],
    ['없는 값', ''],
  ])('P-T16_토스 카드 종류 %s는 %s다', (raw, expected) => {
    expect(tossCardOf({ number: '43301234****123*', issuerCode: '61', cardType: raw })?.cardType).toBe(expected);
  });

  test('P-T16_토스는 가린 번호의 앞 6자리가 BIN이고 가린 번호를 그대로 넘긴다', () => {
    expect(tossCardOf({ number: '43301234****123*', issuerCode: '61', cardType: '신용', acquirerCode: '31' })).toEqual({ maskedNumber: '43301234****123*', bin: '433012', issuerCode: 'HYUNDAI', cardType: 'CREDIT' });
  });

  test('P-T16_토스 카드 칸에 번호가 없으면 BIN이 없다', () => {
    expect(tossCardOf({ issuerCode: '61', cardType: '신용' })).toEqual({ issuerCode: 'HYUNDAI', cardType: 'CREDIT' });
    expect(tossCardOf({ number: '', issuerCode: '61', cardType: '신용' })).toEqual({ issuerCode: 'HYUNDAI', cardType: 'CREDIT' });
  });

  test.each([undefined, null, 'x', 7, []])('P-T16_토스 카드 칸이 %s이면 카드 정보가 없다', (raw) => {
    expect(tossCardOf(raw)).toBeUndefined();
  });

  test('P-T16_포트원은 bin과 가린 번호를 넘기고 종류는 공식 열거값이다', () => {
    expect(portoneCardOf({ number: '43301234****1234', bin: '43301234', issuer: 'SHINHAN', publisher: 'X', type: 'CREDIT', brand: 'VISA' })).toEqual({ maskedNumber: '43301234****1234', bin: '43301234', issuerCode: 'SHINHAN', cardType: 'CREDIT' });
  });

  test.each([
    ['DEBIT', 'DEBIT'],
    ['GIFT', 'GIFT'],
    ['CHECK', ''],
    [undefined, ''],
  ])('P-T16_포트원 카드 종류 %s는 %s다', (raw, expected) => {
    expect(portoneCardOf({ type: raw })?.cardType).toBe(expected);
  });

  test.each<[string, unknown, string]>([
    ['소문자는 대문자로', 'shinhan_card-1', 'SHINHAN_CARD-1'],
    ['빠진 칸은 빈 글자', undefined, ''],
    ['글자 모양이 틀림', 'SHIN|HAN', ''],
    ['너무 김', 'A'.repeat(41), ''],
    ['글이 아님', 42, ''],
  ])('P-T16_포트원 발급사 코드: %s [ASVS v5.0.0-2.2.1]', (_n, issuer, expected) => {
    expect(portoneCardOf({ issuer })?.issuerCode).toBe(expected);
  });

  test.each([undefined, null, 'x'])('P-T16_포트원 카드 칸이 %s이면 카드 정보가 없다', (raw) => {
    expect(portoneCardOf(raw)).toBeUndefined();
  });
});

describe('P-T50 라벨 키 pay', () => {
  const b64 = KEY.toString('base64');

  test('P-T50_invRef 계산은 identity-svc와 같다: k + 판 + . + base64url(HMAC-SHA256(라벨 키, 값))이고 값마다 다르다', () => {
    const r = new PayRefKeyRing({ key: KEY, version: 7 });
    expect(r.ref('a')).toBe(`k7.${createHmac('sha256', KEY).update('a', 'utf8').digest('base64url')}`);
    expect(r.ref('a')).not.toBe(r.ref('b'));
    expect(r.ref('a')).not.toContain('=');
  });

  test.each(['local', 'ci', 'demo'])('P-T50_%s는 라벨 키 값 설정을 받는다', (PEAKET_ENV) => {
    const { ring: r, warnings } = PayRefKeyRing.fromEnv({ PEAKET_ENV, PEAKET_INV_REF_PAY_KEY: b64, PEAKET_INV_REF_PAY_KEY_VERSION: '4' });
    expect(warnings).toEqual([]);
    expect(r.ref('a')).toMatch(/^k4\./);
  });

  test('P-T50_판을 비우면 1이다', () => {
    expect(PayRefKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_PAY_KEY: b64 }).ring.ref('a')).toMatch(/^k1\./);
  });

  test.each(['staging', 'prod', undefined])('P-T50_PEAKET_ENV %s에는 라벨 키 값을 넣으면 시작하지 않고 글에 값이 없다 [ASVS v5.0.0-13.3.1]', (PEAKET_ENV) => {
    const run = () => PayRefKeyRing.fromEnv({ PEAKET_ENV, PEAKET_INV_REF_PAY_KEY: b64 });
    expect(run).toThrow(/PEAKET_INV_REF_PAY_KEY/);
    expect(() => run()).not.toThrow(b64);
  });

  test.each([
    ['31바이트', randomBytes(31).toString('base64')],
    ['33바이트', randomBytes(33).toString('base64')],
  ])('P-T50_라벨 키가 %s면 시작하지 않는다', (_n, raw) => {
    expect(() => PayRefKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_PAY_KEY: raw })).toThrow(/32바이트/);
  });

  test.each(['0', '-1', '1.5', 'x'])('P-T50_판이 %s면 시작하지 않는다', (v) => {
    expect(() => PayRefKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_PAY_KEY: b64, PEAKET_INV_REF_PAY_KEY_VERSION: v })).toThrow(/판/);
  });

  test('P-T50_라벨 키 설정이 없으면 경고하고 값을 만들지 않는다 [ASVS v5.0.0-16.5.2]', () => {
    const { ring: r, warnings } = PayRefKeyRing.fromEnv({ PEAKET_ENV: 'ci' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/PEAKET_INV_REF_PAY/);
    expect(r.ref('a')).toBeUndefined();
  });

  test('P-T50_KMS 키만 있으면 받는 길이 아직 없어 경고하고 값을 만들지 않는다(시작은 막지 않는다) [ASVS v5.0.0-16.5.2]', () => {
    const { ring: r, warnings } = PayRefKeyRing.fromEnv({ PEAKET_ENV: 'staging', PEAKET_INV_REF_PAY_KMS_KEY: 'key-id' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/KMS/);
    expect(r.ref('a')).toBeUndefined();
  });

  test('P-T50_객체를 로그로 찍거나 JSON으로 바꿔도 라벨 키가 실리지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    for (const text of [inspect(ring, { depth: 8, showHidden: true }), JSON.stringify(ring)]) {
      expect(text).not.toContain(KEY.toString('hex'));
      expect(text).not.toContain(KEY.toString('base64'));
    }
  });
});
