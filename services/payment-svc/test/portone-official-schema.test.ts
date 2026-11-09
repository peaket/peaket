// 포트원 어댑터를 공식 스키마로 쓴 응답 고정 파일로 돌린다(P-T16의 시뮬레이터 몫, BUILD_ORDER HOT-145, docs/features/payment.md §2.1 '계약 시험과 실제 결제사 호출의 몫').
// 고정 파일은 공식 스키마(v2.openapi.json 1.16.0)대로 손으로 쓴 것이고 실제 녹화가 아니다(파일 머리의 _provenance). 계정이 생기면 실제 녹화로 바꾼다.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PortoneGateway } from '../src/modules/payment/adapters/pg/portone-gateway.js';

interface Fixture {
  status: number;
  body: Record<string, unknown>;
}
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/portone/official-schema-responses.json', import.meta.url), 'utf8')) as Record<string, Fixture> & { _provenance: string };

const ORDER_ID = '0195f3a0-0000-7000-8000-00000000a001';
const PAYMENT_ID = `pay-${ORDER_ID}`;
const AMOUNT = 10_000;
const C = { orderId: ORDER_ID, paymentRef: PAYMENT_ID, amount: AMOUNT, idemKey: `confirm-${ORDER_ID}`, confirmToken: 'token-fixture' };

function gatewayWith(...names: string[]): PortoneGateway {
  const queue = names.map((n) => fixtures[n]!);
  const fetchStub: typeof fetch = async () => {
    const next = queue.shift();
    if (!next) throw new Error('답을 더 정하지 않았다');
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return new PortoneGateway({ baseUrl: 'http://pg.test', secret: `portone_${randomBytes(8).toString('hex')}`, storeId: 'store-fixture', channelKey: 'channel-fixture', webhookSecrets: [`whsec_${randomBytes(32).toString('base64')}`], isTest: true, fetch: fetchStub });
}

describe('P-T16 포트원 공식 스키마 고정 파일', () => {
  it('P-T16_고정 파일 머리에 실제 녹화가 아니라고 적혀 있다 [ASVS v5.0.0-13.3.1]', () => {
    expect(fixtures._provenance).toContain('실제 녹화가 아니다');
    expect(fixtures._provenance).toContain('v2.openapi.json');
  });

  it('P-T50_승인 200과 조회: 카드 칸을 공통 값으로 싣고 8자리 bin을 그대로 넘긴다', async () => {
    await expect(gatewayWith('confirmPaid', 'paidCard').confirm(C)).resolves.toEqual({
      outcome: 'APPROVED',
      paymentRef: PAYMENT_ID,
      amount: AMOUNT,
      approvedAt: '2026-11-09T01:00:00.000Z',
      card: { maskedNumber: '43301234****1234', bin: '43301234', issuerCode: 'SHINHAN', cardType: 'CREDIT' },
      method: 'CARD',
    });
  });

  it('P-T50_조회 답에도 카드 칸을 싣는다(UNKNOWN을 조회로 확정할 때 쓴다)', async () => {
    await expect(gatewayWith('paidCardNoIssuer6DigitBin').query(PAYMENT_ID)).resolves.toMatchObject({ kind: 'FOUND', status: 'APPROVED', method: 'CARD', card: { maskedNumber: '433012******1234', bin: '433012', issuerCode: '', cardType: 'DEBIT' } });
  });

  it('P-T50_카드 칸이 빠진 카드 결제는 카드 정보가 없다', async () => {
    const q = await gatewayWith('paidCardNoCardFields').query(PAYMENT_ID);
    expect(q).toMatchObject({ kind: 'FOUND', status: 'APPROVED', method: 'CARD' });
    expect(q).not.toHaveProperty('card');
  });

  it.each(['paidTransfer', 'virtualAccountIssued'])('P-T50_%s는 카드 정보가 없다', async (name) => {
    expect(await gatewayWith(name).query(PAYMENT_ID)).not.toHaveProperty('card');
  });

  it('P-T50_리뷰 고침 M2: 간편결제의 easyPayMethod가 카드면 그 카드 칸을 읽는다(공식 스키마 PaymentMethodEasyPay)', async () => {
    await expect(gatewayWith('paidEasyPayCard').query(PAYMENT_ID)).resolves.toMatchObject({ kind: 'FOUND', status: 'APPROVED', method: 'EASY_PAY', card: { maskedNumber: '43301234****5678', bin: '43301234', issuerCode: 'KOOKMIN', cardType: 'DEBIT' } });
  });

  it('P-T50_리뷰 고침 M2: 승인 답도 간편결제 카드 칸을 조회로 함께 실어 ALREADY_APPROVED다', async () => {
    await expect(gatewayWith('alreadyPaid', 'paidEasyPayCard').confirm(C)).resolves.toMatchObject({ outcome: 'ALREADY_APPROVED', method: 'EASY_PAY', card: { bin: '43301234' } });
  });

  it.each(['paidEasyPayCharge', 'paidEasyPayTransfer', 'paidEasyPayNoMethod'])('P-T50_리뷰 고침 M2: %s는 카드 정보가 없다', async (name) => {
    const q = await gatewayWith(name).query(PAYMENT_ID);
    expect(q).toMatchObject({ kind: 'FOUND', status: 'APPROVED', method: 'EASY_PAY' });
    expect(q).not.toHaveProperty('card');
  });

  it('P-T16_리뷰 고침 L6: 고정 파일 머리에 응답 칸 일부만 적었다고 적혀 있다 [ASVS v5.0.0-13.3.1]', () => {
    expect(fixtures._provenance).toContain('응답 칸 일부만');
  });

  it('P-T16_리뷰 고침 L7: 정본이 어댑터마다 같은 값이라고 적지 않고 포트원 발급사 값의 차이를 적는다', () => {
    const doc = readFileSync(new URL('../../../docs/features/payment.md', import.meta.url), 'utf8');
    expect(doc).not.toContain('어댑터마다 같은 공통 값');
    expect(doc).toContain('시뮬레이터 포트원 경로의 `issuer`');
  });

  it.each<[string, Record<string, unknown>]>([
    ['outstanding', { outcome: 'IN_PROGRESS', pgCode: 'IDEMPOTENCY_OUTSTANDING_REQUEST' }],
    ['informationMismatch', { outcome: 'DECLINED', failureCategory: 'VALIDATION' }],
    ['invalidPaymentToken', { outcome: 'DECLINED', failureCategory: 'VALIDATION' }],
    ['invalidRequest', { outcome: 'DECLINED', failureCategory: 'VALIDATION' }],
    ['unauthorized', { outcome: 'DECLINED', failureCategory: 'PG_ERROR' }],
    ['forbidden', { outcome: 'DECLINED', failureCategory: 'PG_ERROR' }],
    ['paymentNotFound', { outcome: 'UNKNOWN' }],
    ['pgProvider', { outcome: 'UNKNOWN' }],
  ])('P-T16_승인 오류 %s의 정규화 결과 [ASVS v5.0.0-16.5.3]', async (name, expected) => {
    await expect(gatewayWith(name).confirm(C)).resolves.toMatchObject(expected);
  });

  it('P-T16_이미 결제됨은 조회로 맞춰 ALREADY_APPROVED다', async () => {
    await expect(gatewayWith('alreadyPaid', 'paidCard').confirm(C)).resolves.toMatchObject({ outcome: 'ALREADY_APPROVED', amount: AMOUNT, card: { bin: '43301234' } });
  });

  it('P-T16_조회 없음(404 PAYMENT_NOT_FOUND)은 NOT_FOUND다', async () => {
    await expect(gatewayWith('paymentNotFound').query(PAYMENT_ID)).resolves.toEqual({ kind: 'NOT_FOUND' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['cancelSucceeded', { outcome: 'CANCELLED' }],
    ['cancelRequested', { outcome: 'CANCEL_PENDING' }],
    ['paymentAlreadyCancelled', { outcome: 'CANCELLED' }],
  ])('P-T16_취소 답 %s의 정규화 결과', async (name, expected) => {
    await expect(gatewayWith(name).cancel({ paymentRef: PAYMENT_ID, amount: 'ALL', reason: '고객 요청', idemKey: 'cancel-fixture-0001' })).resolves.toMatchObject(expected);
  });
});
