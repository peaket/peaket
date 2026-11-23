// J-T37 ①⑦ 토스 지급대행 전송 어댑터(F-07-6 LCH-110, settlement §8 JWE·§5.2, ADR-0369 결정 1·7).
// 진짜 HttpTossPayoutTransport를 시험 안 대역 서버(test/support/toss-payout-fake.ts, 공개 안내 모양 [가정])에 붙여,
// 경로·Basic 인증·Idempotency-Key·text/plain·복호한 본문 칸과 JWE 머리(dir·A256GCM·iat·nonce), 다른 alg/enc·변조 응답 버림을 본다.
// 대역 서버는 node:crypto로 JWE를 직접 만들고 풀어, 구현이 쓰는 JOSE 라이브러리와 서로 맞는지 본다. 결제사는 부르지 않는다.
import { fakeClock } from '@peaket/platform';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { HttpTossPayoutTransport, TossTransportError } from '../src/modules/settlement/adapters/http-toss-payout-transport.js';
import { openTossJwe, sealTossJwe, TossJweError } from '../src/modules/settlement/adapters/toss-jwe.js';
import { settlementApprovalLog } from '../src/modules/settlement/index.js';
import { collectingLogger } from './settlement-flow-support.js';
import { configOf, kst, newKeys, type StoreKeys } from './support/toss-harness.js';
import { sealJwe, openJwe, startTossPayoutFake, type TossPayoutFake } from './support/toss-payout-fake.js';

const NOW = kst('2026-12-04T10:00:00.000');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

let fake: TossPayoutFake | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function rig() {
  const keys: Record<'STANDARD' | 'ESCROW', StoreKeys> = { STANDARD: newKeys('STANDARD'), ESCROW: newKeys('ESCROW') };
  fake = await startTossPayoutFake({
    STANDARD: { secretKey: keys.STANDARD.secretKey, securityKey: Buffer.from(keys.STANDARD.current, 'hex') },
    ESCROW: { secretKey: keys.ESCROW.secretKey, securityKey: Buffer.from(keys.ESCROW.current, 'hex') },
  });
  const clock = fakeClock({ now: NOW });
  const { lines, logger } = collectingLogger(() => clock.now());
  const transport = new HttpTossPayoutTransport(configOf(keys), { baseUrl: fake.url, clock, log: settlementApprovalLog(logger) });
  return { keys, fake, clock, lines, transport };
}

const basic = (secret: string) => `Basic ${Buffer.from(`${secret}:`).toString('base64')}`;
const items = [
  { refPayoutId: 'stmt-a-1', amount: 999_999_999, tossSellerId: 'FSEL-A' },
  { refPayoutId: 'stmt-a-2', amount: 1, tossSellerId: 'FSEL-A' },
];

describe('J-T37 ① JWE 봉인·풀기', () => {
  test('J-T37 ① 지급 요청 본문은 그 상점 보안 키의 dir·A256GCM JWE이고 사용자 머리 iat(만든 시각)·nonce(16바이트)를 싣는다 [ASVS v5.0.0-11.2.1] [ASVS v5.0.0-11.3.1]', async () => {
    const r = await rig();
    const out = await r.transport.requestPayouts('STANDARD', { payoutDate: '2026-12-07', idempotencyKey: 'key-std-1', items });
    expect(out.kind).toBe('ACCEPTED');
    const [req] = r.fake.calls('POST', /^\/v2\/payouts$/);
    expect(req?.decryptError).toBeUndefined();
    const header = req!.jweHeader!;
    expect({ alg: header.alg, enc: header.enc }).toEqual({ alg: 'dir', enc: 'A256GCM' });
    expect(typeof header.iat).toBe('string');
    expect(header.iat as string).toMatch(ISO);
    expect(Date.parse(header.iat as string)).toBe(NOW);
    expect(Buffer.from(header.nonce as string, 'base64url')).toHaveLength(16);
    // 다섯 조각이고 암호화 키 조각은 비어 있다(dir)
    expect(req!.rawBody.split('.')).toHaveLength(5);
    expect(req!.rawBody.split('.')[1]).toBe('');
    // 같은 키로 다른 상점(에스크로) 요청은 에스크로 키로만 풀린다
    await r.transport.requestPayouts('ESCROW', { payoutDate: '2026-12-07', idempotencyKey: 'key-esc-1', items: [{ refPayoutId: 'stmt-e-1', amount: 5_000, tossSellerId: 'FSEL-E' }] });
    const esc = r.fake.calls('POST', /^\/v2\/payouts$/)[1]!;
    expect(esc.store).toBe('ESCROW');
    expect(esc.decryptError).toBeUndefined();
    expect(() => openJwe(esc.rawBody, Buffer.from(r.keys.STANDARD.current, 'hex'))).toThrow();
  });

  test('J-T37 ① 같은 본문을 두 번 봉인하면 nonce와 IV가 다르고, 둘 다 같은 평문으로 풀린다 [ASVS v5.0.0-11.2.1] [ASVS v5.0.0-11.3.3]', async () => {
    const key = randomBytes(32);
    const payload = { refPayoutId: 'stmt-1-1', amount: { currency: 'KRW', value: 123_456 } };
    const a = await sealTossJwe(payload, key, new Date(NOW));
    const b = await sealTossJwe(payload, key, new Date(NOW));
    const ha = openJwe(a, key);
    const hb = openJwe(b, key);
    expect(ha.payload).toEqual(payload);
    expect(hb.payload).toEqual(payload);
    expect(ha.header.nonce).not.toBe(hb.header.nonce);
    expect(ha.iv).not.toBe(hb.iv);
    expect(Date.parse(ha.header.iat as string)).toBe(NOW);
    // 대역 서버가 만든 JWE를 구현이 푼다(서로 맞는 구현). 키 목록 가운데 맞는 키로 푼다(교체 중의 옛 키)
    const old = randomBytes(32);
    expect(await openTossJwe(sealJwe(payload, old), [key, old])).toEqual(payload);
  });

  test('J-T37 ① 다른 alg·enc, 변조한 태그, 맞지 않는 키는 TossJweError로 거부한다 [ASVS v5.0.0-11.3.1] [ASVS v5.0.0-11.3.3]', async () => {
    const key = randomBytes(32);
    const payload = { ok: true };
    await expect(openTossJwe(sealJwe(payload, key, { enc: 'A128GCM' }), [key])).rejects.toBeInstanceOf(TossJweError);
    await expect(openTossJwe(sealJwe(payload, key, { alg: 'A256KW' }), [key])).rejects.toBeInstanceOf(TossJweError);
    const parts = sealJwe(payload, key).split('.');
    const tag = Buffer.from(parts[4]!, 'base64url');
    tag[0] = tag[0]! ^ 0x01;
    parts[4] = tag.toString('base64url');
    await expect(openTossJwe(parts.join('.'), [key])).rejects.toBeInstanceOf(TossJweError);
    await expect(openTossJwe(sealJwe(payload, randomBytes(32)), [key])).rejects.toBeInstanceOf(TossJweError);
    await expect(openTossJwe('not.a.jwe', [key])).rejects.toBeInstanceOf(TossJweError);
  });

  test('J-T37 ① 응답의 enc·alg가 다르거나 복호가 실패하면 응답을 쓰지 않고(NO_RESPONSE) 보안 로그를 남기며, 키·JWE 원문은 로그에 없다 [ASVS v5.0.0-11.3.3] [ASVS v5.0.0-16.3.4]', async () => {
    const r = await rig();
    for (const fault of ['WRONG_ENC', 'WRONG_ALG', 'BAD_JWE'] as const) {
      r.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, fault);
      const out = await r.transport.requestPayouts('STANDARD', { payoutDate: '2026-12-07', idempotencyKey: `key-${fault}`, items });
      expect([fault, out]).toEqual([fault, { kind: 'NO_RESPONSE' }]);
    }
    // 셀러 등록 응답이 변조되면 쓰지 않고 TossTransportError(응답을 받지 못함)다
    r.fake.inject({ method: 'POST', path: /^\/v2\/sellers$/ }, 'BAD_JWE');
    await expect(
      r.transport.registerSeller('STANDARD', {
        refSellerId: 'p-STANDARD',
        businessType: 'CORPORATE',
        company: { name: '주식회사 피켓엔터', representativeName: '김대표', businessRegistrationNumber: '1234567890', email: 'ops@example.com', phone: '0212345678' },
        account: { bankCode: '004', accountNumber: '12345678901234', holderName: '주식회사 피켓엔터' },
      }),
    ).rejects.toBeInstanceOf(TossTransportError);
    const security = r.lines.filter((l) => l.event === 'settlement_toss_jwe_invalid');
    expect(security).toHaveLength(4);
    expect(security.map((l) => l.pgStore)).toEqual(['STANDARD', 'STANDARD', 'STANDARD', 'STANDARD']);
    const all = JSON.stringify(r.lines);
    for (const secret of [r.keys.STANDARD.current, r.keys.STANDARD.old, r.keys.STANDARD.secretKey, '12345678901234']) expect(all).not.toContain(secret);
    for (const req of r.fake.requests) if (req.method === 'POST') expect(all).not.toContain(req.rawBody.slice(0, 40));
  });
});

describe('J-T37 ⑦ 공개 안내 모양 대역 서버와의 계약', () => {
  test('J-T37 ⑦ 지급 요청: POST /v2/payouts, 그 상점 Basic 인증, Idempotency-Key, text/plain, 복호한 본문 칸과 접수 결과', async () => {
    const r = await rig();
    const out = await r.transport.requestPayouts('STANDARD', { payoutDate: '2026-12-07', idempotencyKey: 'peaket-payout-abc', items });
    const [req] = r.fake.calls('POST', /^\/v2\/payouts$/);
    expect(req!.headers.authorization).toBe(basic(r.keys.STANDARD.secretKey));
    expect(req!.headers['idempotency-key']).toBe('peaket-payout-abc');
    expect(String(req!.headers['content-type'])).toMatch(/^text\/plain/);
    expect(req!.body).toEqual([
      expect.objectContaining({ refPayoutId: 'stmt-a-1', destination: 'FSEL-A', scheduleType: 'SCHEDULED', payoutDate: '2026-12-07', amount: { currency: 'KRW', value: 999_999_999 } }),
      expect.objectContaining({ refPayoutId: 'stmt-a-2', destination: 'FSEL-A', scheduleType: 'SCHEDULED', payoutDate: '2026-12-07', amount: { currency: 'KRW', value: 1 } }),
    ]);
    const created = [...r.fake.payouts.values()];
    expect(out).toEqual({
      kind: 'ACCEPTED',
      payouts: [
        { refPayoutId: 'stmt-a-1', pgPayoutId: created[0]!.id, status: 'REQUESTED' },
        { refPayoutId: 'stmt-a-2', pgPayoutId: created[1]!.id, status: 'REQUESTED' },
      ],
    });
    // 응답 없음 뒤 같은 키로 다시 보내면 결제사는 처음 응답을 그대로 준다(지급이 둘로 늘지 않는다)
    const again = await r.transport.requestPayouts('STANDARD', { payoutDate: '2026-12-07', idempotencyKey: 'peaket-payout-abc', items });
    expect(again).toEqual(out);
    expect(r.fake.payouts.size).toBe(2);
  });

  test('J-T37 ⑦ 전송 결과 넷: 오류 응답은 REJECTED(첫 오류 코드), 409 IDEMPOTENT_REQUEST_PROCESSING은 PROCESSING, 연결 끊김·5xx는 NO_RESPONSE이고 던지지 않는다', async () => {
    const r = await rig();
    const send = (k: string) => r.transport.requestPayouts('STANDARD', { payoutDate: '2026-12-07', idempotencyKey: k, items });
    r.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, { code: 'INVALID_ACCOUNT_NUMBER', status: 400 });
    expect(await send('k1')).toEqual({ kind: 'REJECTED', code: 'INVALID_ACCOUNT_NUMBER' });
    r.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, 'PROCESSING');
    expect(await send('k2')).toEqual({ kind: 'PROCESSING' });
    r.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, 'NO_RESPONSE');
    expect(await send('k3')).toEqual({ kind: 'NO_RESPONSE' });
    r.fake.inject({ method: 'POST', path: /^\/v2\/payouts$/ }, 'SERVER_ERROR');
    expect(await send('k4')).toEqual({ kind: 'NO_RESPONSE' });
    // 처리 중이던 키를 다시 보내면 접수된다
    expect((await send('k2')).kind).toBe('ACCEPTED');
    expect(r.fake.calls('POST', /^\/v2\/payouts$/)).toHaveLength(5);
  });

  test('J-T37 ⑦ 단건 조회·취소·셀러 등록·셀러 조회·잔액·정산(수수료) 조회의 경로·인증·본문', async () => {
    const r = await rig();
    await r.transport.requestPayouts('ESCROW', { payoutDate: '2026-12-07', idempotencyKey: 'k-esc', items: [{ refPayoutId: 'stmt-e-1', amount: 70_000, tossSellerId: 'FSEL-E' }] });
    const [p] = [...r.fake.payouts.values()];
    r.fake.setPayout(p!.id, 'FAILED', 'ACCOUNT_CLOSED');
    expect(await r.transport.getPayout('ESCROW', p!.id)).toEqual({ pgPayoutId: p!.id, status: 'FAILED', errorCode: 'ACCOUNT_CLOSED' });
    const get = r.fake.calls('GET', /^\/v2\/payouts\//)[0]!;
    expect([get.path, get.headers.authorization, get.headers['idempotency-key']]).toEqual([`/v2/payouts/${p!.id}`, basic(r.keys.ESCROW.secretKey), undefined]);

    await r.transport.requestPayouts('STANDARD', { payoutDate: '2026-12-07', idempotencyKey: 'k-std', items: [{ refPayoutId: 'stmt-c-1', amount: 9_000, tossSellerId: 'FSEL-C' }] });
    const toCancel = r.fake.payoutByRef('stmt-c-1')!;
    await r.transport.cancelPayout('STANDARD', toCancel.id);
    const cancel = r.fake.calls('POST', /\/cancel$/)[0]!;
    expect([cancel.path, cancel.headers.authorization, String(cancel.headers['content-type']).startsWith('text/plain'), cancel.decryptError]).toEqual([`/v2/payouts/${toCancel.id}/cancel`, basic(r.keys.STANDARD.secretKey), true, undefined]);
    expect(r.fake.payouts.get(toCancel.id)?.status).toBe('CANCELED');

    const registration = {
      refSellerId: 'promoter-1-ESCROW',
      businessType: 'CORPORATE' as const,
      company: { name: '주식회사 피켓엔터', representativeName: '김대표', businessRegistrationNumber: '1234567890', email: 'ops@example.com', phone: '0212345678' },
      account: { bankCode: '004', accountNumber: '12345678901234', holderName: '주식회사 피켓엔터' },
    };
    const seller = await r.transport.registerSeller('ESCROW', registration);
    const sellerReq = r.fake.calls('POST', /^\/v2\/sellers$/)[0]!;
    expect([sellerReq.headers.authorization, String(sellerReq.headers['content-type']).startsWith('text/plain'), sellerReq.headers['idempotency-key']]).toEqual([basic(r.keys.ESCROW.secretKey), true, undefined]);
    expect(sellerReq.body).toEqual(expect.objectContaining(registration));
    const fakeSeller = [...r.fake.sellers.values()][0]!;
    expect(seller).toEqual({ tossSellerId: fakeSeller.id, status: 'PARTIALLY_APPROVED' });
    fakeSeller.status = 'KYC_REQUIRED';
    expect(await r.transport.getSeller('ESCROW', fakeSeller.id)).toEqual({ tossSellerId: fakeSeller.id, status: 'KYC_REQUIRED' });
    expect(r.fake.calls('GET', /^\/v2\/sellers\//)[0]!.path).toBe(`/v2/sellers/${fakeSeller.id}`);

    r.fake.balances.STANDARD = { available: 12_345_678, pending: 2_000_001 };
    expect(await r.transport.balance('STANDARD')).toEqual({ availableAmount: 12_345_678, pendingAmount: 2_000_001 });
    expect(r.fake.calls('GET', /^\/v2\/balances$/)[0]!.headers.authorization).toBe(basic(r.keys.STANDARD.secretKey));

    r.fake.settlementRows.ESCROW = [
      { paymentKey: 'pk-1', amount: 110_000, fee: 3_300 },
      { paymentKey: 'pk-2', amount: 55_000, fee: 1_650 },
    ];
    expect(await r.transport.listSettlementFees('ESCROW', new Date(kst('2026-11-01T00:00:00.000')), new Date(kst('2026-11-30T22:00:00.000')))).toBe(4_950);
    const fees = r.fake.calls('GET', /^\/v1\/settlements$/)[0]!;
    expect([fees.query.startDate, fees.query.endDate, fees.headers.authorization]).toEqual(['2026-11-01', '2026-11-30', basic(r.keys.ESCROW.secretKey)]);
  });

  test('J-T37 ⑦ 읽기·셀러 호출이 응답을 받지 못하면 TossTransportError를 던진다(결과를 지어내지 않는다)', async () => {
    const r = await rig();
    r.fake.inject({ method: 'GET', path: /^\/v2\/balances$/ }, 'NO_RESPONSE');
    await expect(r.transport.balance('STANDARD')).rejects.toBeInstanceOf(TossTransportError);
    r.fake.inject({ method: 'GET', path: /^\/v2\/sellers\// }, 'SERVER_ERROR');
    await expect(r.transport.getSeller('STANDARD', 'FSEL-X')).rejects.toBeInstanceOf(TossTransportError);
    r.fake.inject({ method: 'GET', path: /^\/v2\/payouts\// }, 'NO_RESPONSE');
    await expect(r.transport.getPayout('STANDARD', 'FPAY-X')).rejects.toBeInstanceOf(TossTransportError);
    r.fake.inject({ method: 'GET', path: /^\/v1\/settlements$/ }, 'SERVER_ERROR');
    await expect(r.transport.listSettlementFees('STANDARD', new Date(NOW - 86_400_000), new Date(NOW))).rejects.toBeInstanceOf(TossTransportError);
  });
});
