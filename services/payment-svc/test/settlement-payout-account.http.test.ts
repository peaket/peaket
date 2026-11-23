// 정산 계좌 변경 서버 경계 시험(J-T40 ①②③④⑦, I-T53 ②③, J-T14 로그 표본, settlement §6·§8, ADR-0370 결정 5, F-07-7 계획 §5.1(라)).
// 파트너 PUT·GET을 Fastify 주입으로 부르고, 재인증은 실제 JwksReauthVerifier를 시험용 관리 JWKS·한 번 쓰기 저장소로 조립한다.
// 포트원 플랫폼은 대역 서버, 토스는 F-07-6 전송 포트 짝 대역, ops 감사 받기는 대역 서버다. 결제사는 부르지 않는다.
// 단언 값은 정본 값이다: 3영업일(금요일 10:00 KST → 다음 주 수요일 10:00 KST), 계좌번호 숫자 6~20자, 403·428·412·400·409·422·502·503.
import { fakeClock, MemoryReauthJtiStore } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { JwksReauthVerifier, SettlementDueWorker } from '../src/modules/settlement/index.js';
import { adminKey, ISS, JWKS_URL, jwksFetch, reauthClaims, signReauth } from './support/admin-reauth.js';
import { OpsIntakeFake } from './support/ops-intake-fake.js';
import { PortonePlatformFake } from './support/portone-platform-fake.js';
import { dumpStore, harness, httpService, kyc, leaks, PartnerSessions, PORTONE_SECRET, portonePartner, statement, TOSS_CONFIG, tossSeller, type Harness } from './support/settlement-portone-harness.js';

/** 금요일 10:00 KST(2026-11-27 01:00 UTC) */
const FRIDAY_10_KST = Date.parse('2026-11-27T01:00:00.000Z');
/** 3영업일 뒤 = 다음 주 수요일 10:00 KST */
const WEDNESDAY_10_KST = '2026-12-02T01:00:00.000Z';
const LEGAL = '주식회사 피켓엔터';
const NEW_ACCOUNT = '11012345678901';
const BANK = '88';
const BANK_ENUM = 'SHINHAN';
const OLD = { bankCode: '06', accountLast4: '1234', version: 9 };

const fake = new PortonePlatformFake(PORTONE_SECRET);
const ops = new OpsIntakeFake();
const key = adminKey('admin-f077-1');
const otherKey = adminKey('admin-f077-other');

beforeAll(async () => {
  await fake.start();
  await ops.start();
});
afterAll(async () => {
  await fake.close();
  await ops.close();
});

interface Ctx {
  h: Harness;
  P: string;
  partnerId: string;
  sessions: PartnerSessions;
  admin: ReturnType<PartnerSessions['partner']>;
  svc: Awaited<ReturnType<typeof httpService>>;
}
let ctx: Ctx;

async function setup(o: { portone?: boolean; legalName?: string | null; now?: number } = {}): Promise<Ctx> {
  fake.reset();
  ops.reset();
  const now = o.now ?? FRIDAY_10_KST;
  const sessions = new PartnerSessions();
  const P = randomUUID();
  const clock = fakeClock({ now });
  const reauth = new JwksReauthVerifier({ jwksUrl: JWKS_URL, issuer: ISS, clock, fetch: jwksFetch([key]), jti: new MemoryReauthJtiStore() });
  const h = harness({ now, ...(o.portone === false ? {} : { portone: fake }), toss: true, ops, clock, reauth });
  const at = new Date(now - 30 * 86_400_000);
  h.store.kycs.set(P, { ...kyc(P, at, { legalName: LEGAL, representative: '김대표' }), ...(o.legalName === null ? { legalName: null, representative: null } : {}) });
  h.store.accounts.set(P, { promoterId: P, bankCode: OLD.bankCode, accountLast4: OLD.accountLast4, version: OLD.version, changedAt: at, holdUntil: at, holderVerified: true, agencySyncPending: false });
  const partnerId = portonePartner(h.store, P, at);
  fake.partners.set(partnerId, { id: partnerId, name: LEGAL, account: { bank: 'KOOKMIN', number: '06400000001234', holder: LEGAL }, defaultContractId: 'contract', scheduled: null });
  tossSeller(h.store, P, 'STANDARD', 'PARTIALLY_APPROVED', at);
  tossSeller(h.store, P, 'ESCROW', 'PARTIALLY_APPROVED', at);
  fake.holder(BANK_ENUM, NEW_ACCOUNT, '㈜피켓엔터');
  const svc = await httpService(h, { sessions });
  return { h, P, partnerId, sessions, admin: sessions.partner(P), svc };
}

const token = (c: Ctx, over: Record<string, unknown> = {}, signer = key) => signReauth(signer, reauthClaims({ nowMs: c.h.clock.now(), accountId: c.admin.accountId, sessionId: c.admin.sessionId }, over));
const body = (o: Record<string, unknown> = {}) => JSON.stringify({ bankCode: BANK, accountNumber: NEW_ACCOUNT, holderName: '(주)피켓엔터', ...o });
const put = (c: Ctx, o: { headers?: Record<string, string | undefined>; payload?: string; as?: { headers: Record<string, string> } } = {}) => {
  const headers: Record<string, string> = { ...(o.as ?? c.admin).headers };
  for (const [k, v] of Object.entries({ 'if-match': `"${OLD.version}"`, 'x-reauth-token': token(c), ...o.headers })) if (v !== undefined) headers[k] = v;
  return c.svc.http.inject({ method: 'PUT', url: '/v1/partner/payout-account', headers, payload: o.payload ?? body() });
};
const providerWrites = () => ({
  lookups: fake.calls('GET /platform/bank-accounts/{bank}/{accountNumber}/holder').length,
  partnerPatches: fake.calls('PATCH /platform/partners/{id}').length,
  partnerPosts: fake.calls('POST /platform/partners').length,
  tossUpdates: ctx.h.toss!.callsOf('updateSeller').length,
  tossRegisters: ctx.h.toss!.callsOf('registerSeller').length,
});
const unchanged = (c: Ctx) => expect(c.h.store.accounts.get(c.P)).toMatchObject({ bankCode: OLD.bankCode, accountLast4: OLD.accountLast4, version: OLD.version, agencySyncPending: false });

afterEach(async () => {
  await ctx?.svc.close();
});

describe('J-T40 ① 재인증·권한·판·본문 경계', () => {
  beforeEach(async () => {
    ctx = await setup();
  });

  test.each([
    ['토큰 없음', (_c: Ctx) => undefined],
    ['만료(exp가 지금보다 1초 앞)', (c: Ctx) => token(c, { iat: Math.floor(c.h.clock.now() / 1000) - 171, exp: Math.floor(c.h.clock.now() / 1000) - 1 })],
    ['act가 BOOKER_EXPORT', (c: Ctx) => token(c, { act: 'BOOKER_EXPORT' })],
    ['factors에 passkey 없음(비밀번호·TOTP만, I-T53 ②)', (c: Ctx) => token(c, { factors: ['password', 'totp'] })],
    ['factors 칸 없음', (c: Ctx) => token(c, { factors: undefined })],
    ['다른 세션의 토큰', (c: Ctx) => token(c, { sid: randomUUID() })],
    ['다른 키로 서명', (c: Ctx) => token(c, {}, otherKey)],
  ])('J-T40 ①·I-T53 ② %s → 403 reauth-required, 결제사 호출·행 0 [ASVS v5.0.0-3.3.4]', async (_name, make) => {
    const res = await put(ctx, { headers: { 'x-reauth-token': make(ctx) } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).type).toContain('reauth-required');
    expect(providerWrites()).toEqual({ lookups: 0, partnerPatches: 0, partnerPosts: 0, tossUpdates: 0, tossRegisters: 0 });
    expect(ctx.h.store.payoutAccountChanges).toEqual([]);
    unchanged(ctx);
    // 보안 로그: 파트너·사유 종류만(토큰·계좌 없음, ASVS 16.3.3)
    const rejected = ctx.h.log.lines.filter((l) => l.includes('"payout_account_reauth_rejected"'));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain(ctx.P);
    expect(leaks(ctx.h.log.text(), NEW_ACCOUNT)).toEqual([]);
  });

  test('J-T40 ①·I-T53 ③ 같은 재인증 토큰(jti) 두 번째는 403이고 결제사 호출·변경 행이 늘지 않는다', async () => {
    const once = token(ctx);
    const first = await put(ctx, { headers: { 'x-reauth-token': once } });
    expect(first.statusCode).toBe(200);
    const after = providerWrites();
    const second = await put(ctx, { headers: { 'x-reauth-token': once, 'if-match': '"10"' }, payload: body({ accountNumber: '11012345678902' }) });
    expect(second.statusCode).toBe(403);
    expect(JSON.parse(second.payload).type).toContain('reauth-required');
    expect(providerWrites()).toEqual(after);
    expect(ctx.h.store.payoutAccountChanges).toHaveLength(1);
    expect(ctx.h.store.accounts.get(ctx.P)).toMatchObject({ accountLast4: '8901', version: 10 });
  });

  test('J-T40 ① partner_member는 403이고 결제사를 부르지 않는다 [ASVS v5.0.0-8.2.2]', async () => {
    const member = ctx.sessions.partner(ctx.P, 'partner_member');
    const t = signReauth(key, reauthClaims({ nowMs: ctx.h.clock.now(), accountId: member.accountId, sessionId: member.sessionId }));
    const res = await put(ctx, { as: member, headers: { 'x-reauth-token': t } });
    expect(res.statusCode).toBe(403);
    expect(providerWrites()).toEqual({ lookups: 0, partnerPatches: 0, partnerPosts: 0, tossUpdates: 0, tossRegisters: 0 });
    unchanged(ctx);
  });

  test('J-T40 ① If-Match 없음 428, 판이 다르면 412(지금 판 9에 "8"·"10"), 맞는 "9"는 받는다(두 자리로 넘어감)', async () => {
    expect((await put(ctx, { headers: { 'if-match': undefined } })).statusCode).toBe(428);
    expect((await put(ctx, { headers: { 'if-match': '"8"' } })).statusCode).toBe(412);
    expect((await put(ctx, { headers: { 'if-match': '"10"' } })).statusCode).toBe(412);
    expect(providerWrites()).toEqual({ lookups: 0, partnerPatches: 0, partnerPosts: 0, tossUpdates: 0, tossRegisters: 0 });
    const ok = await put(ctx, { headers: { 'if-match': '"9"' } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload).version).toBe(10);
    expect(ok.headers.etag).toBe('"10"');
  });

  test.each([
    ['모르는 칸(memo)', body({ memo: 'x' })],
    ['모르는 칸(accountLast4)', body({ accountLast4: '8901' })],
    ['은행 코드 목록 밖(04)', body({ bankCode: '04' })],
    ['은행 코드 목록 밖(99)', body({ bankCode: '99' })],
    ['금융결제원 세 자리 코드(088)', body({ bankCode: '088' })],
    ['계좌번호 숫자 5자리', body({ accountNumber: '12345' })],
    ['계좌번호 숫자 21자리', body({ accountNumber: '123456789012345678901' })],
    ['계좌번호에 글자', body({ accountNumber: '11012345678a01' })],
    ['예금주 빈 글', body({ holderName: '' })],
    ['예금주 101자', body({ holderName: '가'.repeat(101) })],
  ])('J-T40 ① 본문 %s → 400이고 결제사를 부르지 않는다 [ASVS v5.0.0-15.3.3]', async (_name, payload) => {
    const res = await put(ctx, { payload });
    expect(res.statusCode).toBe(400);
    expect(providerWrites()).toEqual({ lookups: 0, partnerPatches: 0, partnerPosts: 0, tossUpdates: 0, tossRegisters: 0 });
    expect(ctx.h.store.payoutAccountChanges).toEqual([]);
    unchanged(ctx);
    expect(leaks(res.payload, '123456789012345678901')).toEqual([]);
  });

  test.each([
    ['6자리', '123456', '3456'],
    ['20자리', '12345678901234567890', '7890'],
  ])('J-T40 ① 계좌번호 숫자 %s는 받는다', async (_name, accountNumber, last4) => {
    fake.holder(BANK_ENUM, accountNumber, LEGAL);
    const res = await put(ctx, { payload: body({ accountNumber, holderName: LEGAL }) });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toMatchObject({ bankCode: BANK, payoutAccountLast4: last4, version: 10 });
  });

  test('J-T40 ① 본문에 Content-Type이 JSON이 아니면(text/plain) 받지 않는다 [ASVS v5.0.0-3.5.2]', async () => {
    const res = await put(ctx, { headers: { 'content-type': 'text/plain' } });
    expect([400, 415]).toContain(res.statusCode);
    expect(providerWrites()).toEqual({ lookups: 0, partnerPatches: 0, partnerPosts: 0, tossUpdates: 0, tossRegisters: 0 });
    unchanged(ctx);
  });
});

describe('J-T40 ②③④ 예금주 대조·세 곳 수정·결제사 수정 대기', () => {
  test('J-T40 ② 예금주가 다르면 422이고 payout_account가 그대로이며 HOLDER_MISMATCH 한 행이 남는다 [ASVS v5.0.0-16.3.3]', async () => {
    ctx = await setup();
    fake.holder(BANK_ENUM, NEW_ACCOUNT, '피켓엔터테인먼트');
    const t = token(ctx);
    const jti = (JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString('utf8')) as { jti: string }).jti;
    const res = await put(ctx, { headers: { 'x-reauth-token': t } });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.payload).type).toContain('payout-account-holder-mismatch');
    expect(leaks(res.payload, NEW_ACCOUNT, '피켓엔터테인먼트')).toEqual([]);
    unchanged(ctx);
    expect(ctx.h.store.payoutAccountChanges).toEqual([
      expect.objectContaining({ promoterId: ctx.P, actorAccountId: ctx.admin.accountId, reauthJti: jti, result: 'HOLDER_MISMATCH', bankCode: BANK, accountLast4: '8901', holdUntil: null, createdAt: new Date(FRIDAY_10_KST), auditSentAt: null }),
    ]);
    expect(providerWrites()).toEqual({ lookups: 1, partnerPatches: 0, partnerPosts: 0, tossUpdates: 0, tossRegisters: 0 });
  });

  test('J-T40 ③ 같으면 토스 두 상점 셀러 수정·포트원 파트너 수정이 한 번씩이고, PUT 응답과 GET이 같으며 보류 끝은 금요일 10:00 KST → 수요일 10:00 KST [ASVS v5.0.0-2.1.3]', async () => {
    ctx = await setup();
    const res = await put(ctx);
    expect(res.statusCode).toBe(200);
    const want = { bankCode: BANK, payoutAccountLast4: '8901', holderVerified: true, holdUntil: WEDNESDAY_10_KST, agencySyncPending: false, version: 10 };
    expect(JSON.parse(res.payload)).toEqual(want);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(providerWrites()).toEqual({ lookups: 1, partnerPatches: 1, partnerPosts: 0, tossUpdates: 2, tossRegisters: 0 });
    expect(fake.calls('PATCH /platform/partners/{id}')[0]!.path).toBe(`/platform/partners/${ctx.partnerId}`);
    expect(fake.partners.get(ctx.partnerId)!.account).toEqual({ bank: BANK_ENUM, number: NEW_ACCOUNT, holder: expect.any(String) });
    expect(ctx.h.toss!.callsOf('updateSeller').map((c) => c.pgStore).sort()).toEqual(['ESCROW', 'STANDARD']);
    const get = await ctx.svc.http.inject({ method: 'GET', url: '/v1/partner/payout-account', headers: ctx.admin.headers });
    expect(get.statusCode).toBe(200);
    expect(JSON.parse(get.payload)).toEqual(want);
    expect(get.headers.etag).toBe('"10"');
    expect(get.headers['cache-control']).toBe('no-store');
    expect(ctx.h.store.accounts.get(ctx.P)).toEqual(expect.objectContaining({ bankCode: BANK, accountLast4: '8901', version: 10, holdUntil: new Date(WEDNESDAY_10_KST), holderVerified: true, agencySyncPending: false, changedAt: new Date(FRIDAY_10_KST) }));
    expect(ctx.h.store.payoutAccountChanges).toEqual([
      expect.objectContaining({ result: 'ACCEPTED', bankCode: BANK, accountLast4: '8901', holdUntil: new Date(WEDNESDAY_10_KST), agencyResults: { PORTONE: 'UPDATED', TOSS_STANDARD: 'UPDATED', TOSS_ESCROW: 'UPDATED' } }),
    ]);
    // 응답·저장소·로그에 계좌번호 원문이 없다
    expect(leaks(res.payload + get.payload + dumpStore(ctx.h.store) + ctx.h.log.text(), NEW_ACCOUNT)).toEqual([]);
    expect(await ctx.h.registry.metrics()).toContain('settlement_payout_account_change_total{result="ACCEPTED"} 1');
  });

  test('J-T40 ③ 실무자도 지금 계좌를 읽고, 계좌가 없으면 null 칸·판 0·ETag "0"이다 [ASVS v5.0.0-14.2.6]', async () => {
    ctx = await setup();
    const fresh = randomUUID();
    const member = ctx.sessions.partner(fresh, 'partner_member');
    const res = await ctx.svc.http.inject({ method: 'GET', url: '/v1/partner/payout-account', headers: member.headers });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ bankCode: null, payoutAccountLast4: null, holderVerified: false, holdUntil: null, agencySyncPending: false, version: 0 });
    expect(res.headers.etag).toBe('"0"');
    // 남의 계좌는 보이지 않는다(세션의 테넌트만)
    expect(res.payload).not.toContain(OLD.accountLast4);
  });

  test('J-T40 ④ 한 결제사 수정만 실패하면 502이고 새 계좌·보류와 agencySyncPending true가 저장되며, 보류가 끝나도 묶음에서 HELD·ACCOUNT_CHANGE, 다음 변경이 모두 성공하면 지워진다', async () => {
    ctx = await setup();
    ctx.h.toss!.fail('updateSeller', 'STANDARD', 1);
    const res = await put(ctx);
    expect(res.statusCode).toBe(502);
    const problem = JSON.parse(res.payload) as { type: string; failedAgencies: string[] };
    expect(problem.type).toContain('payout-agency-update-failed');
    expect(problem.failedAgencies).toEqual(['TOSS_STANDARD']);
    expect(ctx.h.store.accounts.get(ctx.P)).toEqual(expect.objectContaining({ bankCode: BANK, accountLast4: '8901', version: 10, holdUntil: new Date(WEDNESDAY_10_KST), agencySyncPending: true }));
    expect(ctx.h.store.payoutAccountChanges.map((c) => [c.result, c.agencyResults])).toEqual([['AGENCY_FAILED', { PORTONE: 'UPDATED', TOSS_STANDARD: 'FAILED', TOSS_ESCROW: 'UPDATED' }]]);
    const get = await ctx.svc.http.inject({ method: 'GET', url: '/v1/partner/payout-account', headers: ctx.admin.headers });
    expect(JSON.parse(get.payload)).toMatchObject({ agencySyncPending: true, version: 10 });
    expect(await ctx.h.registry.metrics()).toContain('settlement_payout_agency_sync_pending 1');

    // 보류 끝(수요일 10:00 KST) 1시간 뒤: 그 파트너의 확정 정산서는 지급 묶음에서 HELD·ACCOUNT_CHANGE로 빠진다
    ctx.h.clock.advance(Date.parse(WEDNESDAY_10_KST) - FRIDAY_10_KST + 3_600_000);
    const s = statement({ promoterId: ctx.P, pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-12-04', at: new Date(ctx.h.clock.now()) });
    await ctx.h.store.saveStatement(s);
    await expect(ctx.h.settlements.createPayoutBatch({ pg: 'TOSS', pgStore: 'STANDARD', payoutDate: '2026-12-04', actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-account-change-hold') });
    expect(ctx.h.store.statements.get(s.statementId)).toMatchObject({ status: 'HELD', holdReason: 'ACCOUNT_CHANGE' });
    // 표시가 있는 동안에는 재확정도 409
    await expect(ctx.h.settlements.reconfirmStatement(s.statementId, { actor: randomUUID() })).rejects.toMatchObject({ status: 409, type: expect.stringContaining('payout-account-change-hold') });

    // 다음 변경이 모두 성공하면 표시가 지워진다
    fake.holder(BANK_ENUM, '11012345678902', LEGAL);
    const again = await put(ctx, { headers: { 'if-match': '"10"', 'x-reauth-token': token(ctx) }, payload: body({ accountNumber: '11012345678902', holderName: LEGAL }) });
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.payload)).toMatchObject({ agencySyncPending: false, version: 11, payoutAccountLast4: '8902' });
    expect(ctx.h.store.accounts.get(ctx.P)?.agencySyncPending).toBe(false);
    expect(await ctx.h.registry.metrics()).toContain('settlement_payout_agency_sync_pending 0');
  });

  test('J-T40 ④ 포트원 파트너 수정만 실패해도 502·[PORTONE]이고 토스 두 상점 수정은 남는다', async () => {
    ctx = await setup();
    fake.fault('PATCH /platform/partners/{id}', '5xx', 1);
    const res = await put(ctx);
    expect(res.statusCode).toBe(502);
    expect((JSON.parse(res.payload) as { failedAgencies: string[] }).failedAgencies).toEqual(['PORTONE']);
    expect(ctx.h.toss!.callsOf('updateSeller')).toHaveLength(2);
    expect(ctx.h.store.accounts.get(ctx.P)).toMatchObject({ accountLast4: '8901', agencySyncPending: true });
  });

  test('J-T40 ② 판매자 확인(seller_kyc 상호)이 없으면 409 payout-seller-unverified이고 예금주 조회도 하지 않는다', async () => {
    ctx = await setup({ legalName: null });
    const res = await put(ctx);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).type).toContain('payout-seller-unverified');
    expect(providerWrites()).toEqual({ lookups: 0, partnerPatches: 0, partnerPosts: 0, tossUpdates: 0, tossRegisters: 0 });
    unchanged(ctx);
  });

  test.each([
    ['5xx', '5xx' as const],
    ['응답 없음', 'reset' as const],
  ])('J-T40 ② 예금주 조회가 %s면 503 payout-holder-lookup-unavailable이고 계좌·결제사가 그대로다 [ASVS v5.0.0-16.5.3]', async (_name, mode) => {
    ctx = await setup();
    fake.fault('GET /platform/bank-accounts/{bank}/{accountNumber}/holder', mode);
    const res = await put(ctx);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.payload).type).toContain('payout-holder-lookup-unavailable');
    expect(providerWrites()).toMatchObject({ partnerPatches: 0, partnerPosts: 0, tossUpdates: 0, tossRegisters: 0 });
    unchanged(ctx);
  });

  test('J-T40 ② 포트원 플랫폼이 꺼진 조립에서는 예금주를 조회할 수 없어 503 payout-holder-lookup-unavailable이고 아무것도 바뀌지 않는다(ADR-0370 결정 3)', async () => {
    ctx = await setup({ portone: false });
    const res = await put(ctx);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.payload).type).toContain('payout-holder-lookup-unavailable');
    expect(fake.requests).toEqual([]);
    expect(ctx.h.toss!.callsOf('updateSeller')).toEqual([]);
    unchanged(ctx);
  });
});

describe('J-T40 ⑦ 변경 기록과 ops 감사 보내기', () => {
  test('J-T40 ⑦·I-T53 ③ 성공·거부·실패마다 한 행이고, ops 503 동안은 보낸 시각이 비며 다음 30분 점검이 보내 채운다 [ASVS v5.0.0-16.3.1]', async () => {
    ctx = await setup();
    ops.mode = '503';
    // 거부(예금주 다름)
    fake.holder(BANK_ENUM, '11000000000001', '다른회사');
    expect((await put(ctx, { payload: body({ accountNumber: '11000000000001' }) })).statusCode).toBe(422);
    // 실패(토스 일반 상점 수정 실패)
    ctx.h.toss!.fail('updateSeller', 'STANDARD', 1);
    expect((await put(ctx)).statusCode).toBe(502);
    // 성공(다음 판)
    fake.holder(BANK_ENUM, '11000000000002', LEGAL);
    expect((await put(ctx, { headers: { 'if-match': '"10"', 'x-reauth-token': token(ctx) }, payload: body({ accountNumber: '11000000000002', holderName: LEGAL }) })).statusCode).toBe(200);
    const rows = ctx.h.store.payoutAccountChanges;
    expect(rows.map((r) => [r.result, r.accountLast4, r.auditSentAt])).toEqual([
      ['HOLDER_MISMATCH', '0001', null],
      ['AGENCY_FAILED', '8901', null],
      ['ACCEPTED', '0002', null],
    ]);
    expect(new Set(rows.map((r) => r.reauthJti)).size).toBe(3);
    expect(ops.audits).toEqual([]);

    // 30분 뒤 정산 일꾼 점검: ops가 살아 있으면 보낸다
    ops.mode = 'up';
    ctx.h.clock.advance(30 * 60_000);
    const worker = new SettlementDueWorker({ settlements: ctx.h.settlements, leader: { isLeader: () => true }, clock: ctx.h.clock });
    await worker.tick(false);
    expect(ops.audits.map((a) => [a.recordType, a.eventKey, a.recordId])).toEqual(rows.map((r) => ['PAYOUT_ACCOUNT_CHANGED', `payout-account-change:${r.id}`, r.id]));
    expect(ctx.h.store.payoutAccountChanges.map((r) => r.auditSentAt)).toEqual([new Date(ctx.h.clock.now()), new Date(ctx.h.clock.now()), new Date(ctx.h.clock.now())]);
    const accepted = ops.audits[2]!.payload;
    expect(accepted).toEqual({
      promoterId: ctx.P,
      actorAccountId: ctx.admin.accountId,
      result: 'ACCEPTED',
      reauthFactors: ['password', 'totp', 'passkey'],
      holderMatched: true,
      bankCode: BANK,
      accountLast4: '0002',
      holdUntil: expect.any(String),
      agencies: { PORTONE: 'UPDATED', TOSS_STANDARD: 'UPDATED', TOSS_ESCROW: 'UPDATED' },
    });
    expect(ops.audits[0]!.payload).toMatchObject({ result: 'HOLDER_MISMATCH', holderMatched: false, holdUntil: null });
    expect(ops.audits[1]!.payload).toMatchObject({ result: 'AGENCY_FAILED', agencies: { PORTONE: 'UPDATED', TOSS_STANDARD: 'FAILED', TOSS_ESCROW: 'UPDATED' } });
    // 감사 본문에 계좌번호·예금주명이 없다
    for (const n of ['11000000000001', '11000000000002', NEW_ACCOUNT]) expect(leaks(JSON.stringify(ops.audits), n, '다른회사')).toEqual([]);
    expect(ops.tokens.every((t) => t !== undefined)).toBe(true);
    // 보낸 행은 다시 보내지 않는다
    await expect(ctx.h.settlements.retryPayoutAccountAudits()).resolves.toEqual({ sent: 0, pending: 0 });
    expect(ops.audits).toHaveLength(3);
    expect(await ctx.h.registry.metrics()).toContain('settlement_payout_account_change_total{result="HOLDER_MISMATCH"} 1');
  });

  test('J-T40 ⑦ ops가 계속 503이면 retryPayoutAccountAudits가 { sent: 0, pending: 행 수 }이고 보낸 시각을 채우지 않는다', async () => {
    ctx = await setup();
    expect((await put(ctx)).statusCode).toBe(200);
    ops.mode = '503';
    await expect(ctx.h.settlements.retryPayoutAccountAudits()).resolves.toEqual({ sent: 0, pending: 1 });
    expect(ctx.h.store.payoutAccountChanges[0]!.auditSentAt).toBeNull();
    expect(ops.refused.get('/internal/v1/ops/audit-records')).toBe(1);
  });
});

describe('J-T14 정산 계좌 변경 로그 표본', () => {
  test('J-T14 등록·계좌 변경·셀러 수정·거부·결제사 실패 시나리오의 로그 전체와 파트너 응답에 계좌번호·보안 키·JWE compact가 0건이다 [ASVS v5.0.0-16.2.5]', async () => {
    ctx = await setup();
    const P2 = randomUUID();
    fake.holder(BANK_ENUM, '11077777777777', LEGAL);
    await ctx.h.settlements.registerPayoutAgencies({
      promoterId: P2,
      businessType: 'CORPORATE',
      company: { name: LEGAL, representativeName: '김대표', businessRegistrationNumber: '1234567890', email: 'pay@peaket.test', phone: '0212345678' },
      account: { bankCode: BANK, accountNumber: '11077777777777', holderName: LEGAL },
    });
    const responses: string[] = [];
    responses.push((await put(ctx)).payload);
    fake.holder(BANK_ENUM, '11066666666666', '다른회사');
    responses.push((await put(ctx, { headers: { 'if-match': '"10"', 'x-reauth-token': token(ctx) }, payload: body({ accountNumber: '11066666666666' }) })).payload);
    ctx.h.toss!.fail('updateSeller', 'ESCROW', 1);
    fake.holder(BANK_ENUM, '11055555555555', LEGAL);
    responses.push((await put(ctx, { headers: { 'if-match': '"10"', 'x-reauth-token': token(ctx) }, payload: body({ accountNumber: '11055555555555', holderName: LEGAL }) })).payload);
    responses.push((await ctx.svc.http.inject({ method: 'GET', url: '/v1/partner/payout-account', headers: ctx.admin.headers })).payload);
    const logs = ctx.h.log.text();
    expect(ctx.h.log.lines.length).toBeGreaterThan(0);
    for (const n of [NEW_ACCOUNT, '11077777777777', '11066666666666', '11055555555555']) {
      expect(leaks(logs, n)).toEqual([]);
      expect(leaks(responses.join('\n'), n)).toEqual([]);
    }
    for (const store of Object.values(TOSS_CONFIG.stores)) for (const k of store!.securityKeys) expect(logs).not.toContain(k.toString('hex'));
    // JWE compact(다섯 조각 base64url)와 재인증 토큰(JWS 세 조각)도 로그에 없다
    expect(logs).not.toMatch(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
    expect(logs).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    for (const r of responses) expect(Object.keys(JSON.parse(r) as object)).not.toContain('accountNumber');
  });
});
