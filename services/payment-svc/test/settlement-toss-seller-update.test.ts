// HttpTossPayoutTransport.updateSeller HTTP 계약 시험(F-07-7 계획 §5.1 (나) 끝·(타) 결정 1·(파) (바) (5), 시험 리뷰 TR-07).
// 셀러 수정은 POST /v2/sellers/{id}, 그 상점 보안 키의 JWE 본문(셀러 등록과 같은 칸), 암호화 머리, Basic 인증이다.
// 결제사는 부르지 않는다. 대역 서버는 F-07-7 쪽 test/support/toss-seller-update-fake.ts(F-07-6 대역의 JWE 도구를 그대로 쓴다).
import { fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { HttpTossPayoutTransport, TossTransportError } from '../src/modules/settlement/adapters/http-toss-payout-transport.js';
import { configOf, newKeys, type StoreKeys } from './support/toss-harness.js';
import { TossSellerUpdateFake } from './support/toss-seller-update-fake.js';
import type { PgStore } from '../src/modules/settlement/domain/settlement.js';

const NOW = Date.parse('2026-11-27T01:00:00.000Z');
const ACCOUNT = '11012345678901';
const keys: Record<PgStore, StoreKeys> = { STANDARD: newKeys('STANDARD'), ESCROW: newKeys('ESCROW') };
const fake = new TossSellerUpdateFake({
  STANDARD: { secretKey: keys.STANDARD.secretKey, securityKey: Buffer.from(keys.STANDARD.current, 'hex') },
  ESCROW: { secretKey: keys.ESCROW.secretKey, securityKey: Buffer.from(keys.ESCROW.current, 'hex') },
});
beforeAll(async () => {
  await fake.start();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.sellers.clear();
});

const body = (store: PgStore) => ({
  refSellerId: `0b6d6a3c-1f4e-4a77-9d0e-6a1b2c3d4e5f-${store}`,
  businessType: 'CORPORATE' as const,
  company: { name: '주식회사 피켓엔터', representativeName: '김대표', businessRegistrationNumber: '1234567890', email: 'pay@peaket.test', phone: '0212345678' },
  account: { bankCode: '88', accountNumber: ACCOUNT, holderName: '(주)피켓엔터' },
});
const transport = () => new HttpTossPayoutTransport(configOf(keys), { baseUrl: fake.url, clock: fakeClock({ now: NOW }) });

describe('J-T40 ③ 토스 셀러 수정 HTTP 계약', () => {
  test.each(['STANDARD', 'ESCROW'] as const)('J-T40 ③ %s 상점: POST /v2/sellers/{id}·Basic·암호화 머리·text/plain·그 상점 보안 키 JWE(alg dir·enc A256GCM·iat·nonce)이고 응답 상태를 돌려준다', async (store) => {
    fake.sellers.set(`FSEL-${store}-1`, { store, status: 'PARTIALLY_APPROVED' });
    const t = transport();
    expect(typeof t.updateSeller).toBe('function');
    await expect(t.updateSeller!(store, `FSEL-${store}-1`, body(store))).resolves.toEqual({ tossSellerId: `FSEL-${store}-1`, status: 'PARTIALLY_APPROVED' });
    expect(fake.requests).toHaveLength(1);
    const r = fake.requests[0]!;
    expect([r.method, r.path, r.store]).toEqual(['POST', `/v2/sellers/FSEL-${store}-1`, store]);
    expect(r.headers.authorization).toBe(`Basic ${Buffer.from(`${keys[store].secretKey}:`).toString('base64')}`);
    expect(String(r.headers['tosspayments-api-security-mode']).toUpperCase()).toBe('ENCRYPTION');
    expect(String(r.headers['content-type'])).toMatch(/^text\/plain/);
    expect(r.decryptError).toBeUndefined();
    expect(r.jweHeader).toMatchObject({ alg: 'dir', enc: 'A256GCM', iat: expect.any(String), nonce: expect.any(String) });
    expect(r.body).toEqual(body(store));
  });

  test('J-T40 ③ 없는 셀러(다른 상점의 셀러) 404는 TossTransportError로 던지고, 오류 글에 계좌번호가 없다', async () => {
    fake.sellers.set('FSEL-ESCROW-1', { store: 'ESCROW', status: 'APPROVED' });
    const t = transport();
    const notFound = await t.updateSeller!('STANDARD', 'FSEL-ESCROW-1', body('STANDARD')).catch((e: unknown) => e);
    expect(notFound).toBeInstanceOf(TossTransportError);
    expect(`${String(notFound)} ${JSON.stringify(notFound)}`).not.toContain(ACCOUNT);
    expect(fake.requests.map((r) => [r.path, r.store])).toEqual([['/v2/sellers/FSEL-ESCROW-1', 'STANDARD']]);
  });
});
