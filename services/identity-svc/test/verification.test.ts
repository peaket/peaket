// 본인확인 시험 어댑터와 구매 권한(docs/features/identity.md §5 '본인확인 시험 어댑터와 첫 구현'·'모의 기관과 기관 창 흐름',
// BUILD_ORDER PRF-040·BOT-010, FR-002, POL-001, I-T6, I-T45).
import { decodeJwt } from 'jose';
import { describe, expect, test } from 'vitest';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { openTestAgencyResult, sealTestAgencyResult } from '../src/modules/verification/adapters/test-agency.js';
import { TestVerificationProvider } from '../src/modules/verification/adapters/test-verification-provider.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { GetVerificationResult } from '../src/modules/verification/application/get-verification-result.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { VerificationError } from '../src/modules/verification/application/verification-error.js';
import { AGENCY_SECRET, AGENCY_URL, agencyResult, kit, newKey, testAgency } from './support.js';

async function setup(mode: 'POPUP' | 'REDIRECT' = 'POPUP') {
  const verifications = new MemoryVerificationStore();
  const claims = new VerificationClaims(verifications);
  const k = await kit(new MemorySessionStore(), { claims });
  const provider = testAgency(k.clock, mode);
  const hashers = new HmacIdentityHashers(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  return {
    k,
    verifications,
    provider,
    start: new StartVerification(verifications, provider, k.clock),
    confirm: new ConfirmVerification(verifications, provider, hashers, k.clock),
    result: new GetVerificationResult(verifications, k.clock),
    /** 모의 기관이 돌려준 결과 값 */
    agency: (verificationId: string, o: Parameters<typeof agencyResult>[2]) => agencyResult(k.clock, verificationId, o),
  };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof VerificationError) return e.code;
    throw e;
  }
};

describe('본인확인(시험 어댑터)', () => {
  test('FR002_본인확인을마치면_다음토큰부터ticket:buy와pid가실린다', async () => {
    const t = await setup();
    const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v-1', email: null, deviceId: null });
    expect(decodeJwt(s.accessToken)).not.toHaveProperty('scope');
    const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/my/settings' });
    expect(st.expiresAt).toBe(t.k.clock.now() + 10 * 60_000);
    const r = await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: t.agency(st.verificationId, { person: 'kim' }) });
    expect(r).toEqual({ verificationId: st.verificationId, purpose: 'FIRST', status: 'VERIFIED', next: '/my/settings', restrictedUntil: null });
    const after = await t.k.refresh.run({ refreshToken: s.refreshToken });
    if (after.result !== 'OK') throw new Error(after.result);
    const claims = decodeJwt(after.accessToken);
    expect(claims.scope).toBe('ticket:buy');
    expect(claims.pid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 같은 결과를 다시 보내면 같은 결과다
    expect(await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: t.agency(st.verificationId, { person: 'kim' }) })).toEqual(r);
    expect(await t.result.run({ accountId: s.accountId, verificationId: st.verificationId })).toEqual(r);
  });

  test('I-T6_같은사람이다른계정에서본인확인하면_DUPLICATE_ACCOUNT이고저장하지않는다', async () => {
    const t = await setup();
    const a = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v-a', email: null, deviceId: null });
    const b = await t.k.create.run({ idempotencyKey: newKey(), provider: 'naver', providerUserId: 'v-b', email: null, deviceId: null });
    const sa = await t.start.run({ accountId: a.accountId, purpose: 'FIRST', next: '/' });
    await t.confirm.run({ accountId: a.accountId, verificationId: sa.verificationId, providerResult: t.agency(sa.verificationId, { person: 'lee' }) });
    const sb = await t.start.run({ accountId: b.accountId, purpose: 'FIRST', next: '/' });
    expect(await code(t.confirm.run({ accountId: b.accountId, verificationId: sb.verificationId, providerResult: t.agency(sb.verificationId, { person: 'lee' }) }))).toBe('DUPLICATE_ACCOUNT');
    expect((await t.result.run({ accountId: b.accountId, verificationId: sb.verificationId })).status).toBe('DUPLICATE_ACCOUNT');
    expect(await t.verifications.claimsOf(b.accountId)).toBeNull();
  });

  test('POL001_같은사람의pid는_계정이바뀌어도같고_다른사람이면다르다', async () => {
    const t = await setup();
    const ids: string[] = [];
    for (const person of ['park', 'choi']) {
      const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: `v-${person}`, email: null, deviceId: null });
      const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
      await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: t.agency(st.verificationId, { person }) });
      ids.push((await t.verifications.claimsOf(s.accountId))!.pid);
    }
    expect(ids[0]).not.toBe(ids[1]);
    const again = new HmacIdentityHashers(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
    const ci = await testAgency(t.k.clock).confirm('x', t.agency('x', { person: 'park' }));
    if (ci.outcome !== 'VERIFIED') throw new Error('x');
    expect(again.pid(again.ci(ci.ci).hmac).pid.toString('base64url')).toBe(ids[0]);
  });

  test('FR002_이미본인확인한계정의FIRST시작은409이고_취소·실패는저장하지않는다', async () => {
    const t = await setup();
    const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v-2', email: null, deviceId: null });
    for (const outcome of ['CANCELLED', 'FAILED'] as const) {
      const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
      expect((await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: t.agency(st.verificationId, { outcome }) })).status).toBe(outcome);
    }
    expect(await t.verifications.claimsOf(s.accountId)).toBeNull();
    const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
    await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: t.agency(st.verificationId, { person: 'jung' }) });
    expect(await code(t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' }))).toBe('ALREADY_VERIFIED');
  });

  test('ASVS v5.0.0-3.7.2_I-T45_⑤돌아갈주소가같은출처경로가아니면_시작하지않는다', async () => {
    const t = await setup();
    for (const next of ['//evil.example', 'https://evil.example', '/%2f%2fevil', '/a\\b']) {
      expect(await code(t.start.run({ accountId: '0190f3a1-7c2e-7a00-8000-000000000001', purpose: 'FIRST', next }))).toBe('NEXT_INVALID');
    }
  });

  test('FR002_남의건·만료된건은_찾을수없고_결과는1일만조회한다', async () => {
    const t = await setup();
    const a = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v-3', email: null, deviceId: null });
    const b = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v-4', email: null, deviceId: null });
    const st = await t.start.run({ accountId: a.accountId, purpose: 'FIRST', next: '/' });
    expect(await code(t.confirm.run({ accountId: b.accountId, verificationId: st.verificationId, providerResult: t.agency(st.verificationId, { person: 'x' }) }))).toBe('NOT_FOUND');
    expect(await code(t.result.run({ accountId: b.accountId, verificationId: st.verificationId }))).toBe('NOT_FOUND');
    expect((await t.result.run({ accountId: a.accountId, verificationId: st.verificationId })).status).toBe('PENDING');
    t.k.clock.advance(10 * 60_000 + 1);
    expect(await code(t.confirm.run({ accountId: a.accountId, verificationId: st.verificationId, providerResult: t.agency(st.verificationId, { person: 'x' }) }))).toBe('NOT_FOUND');
    const st2 = await t.start.run({ accountId: a.accountId, purpose: 'FIRST', next: '/' });
    await t.confirm.run({ accountId: a.accountId, verificationId: st2.verificationId, providerResult: t.agency(st2.verificationId, { person: 'y' }) });
    t.k.clock.advance(24 * 3_600_000 + 1);
    expect(await code(t.result.run({ accountId: a.accountId, verificationId: st2.verificationId }))).toBe('NOT_FOUND');
  });

  test('identity§10_본인확인기관이없으면_시작이503PROVIDER_DOWN이고건을남기지않는다', async () => {
    const { unavailableProvider } = await import('../src/modules/verification/adapters/unavailable-verification.js');
    const t = await setup();
    const start = new StartVerification(t.verifications, unavailableProvider, t.k.clock);
    expect(await code(start.run({ accountId: '0190f3a1-7c2e-7a00-8000-000000000001', purpose: 'FIRST', next: '/' }))).toBe('PROVIDER_DOWN');
  });

  test('ADR0050_다시본인확인은_같은사람이면VERIFIED이고pid는그대로_다른사람이면FAILED다', async () => {
    const t = await setup();
    const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v-re', email: null, deviceId: null });
    const first = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
    await t.confirm.run({ accountId: s.accountId, verificationId: first.verificationId, providerResult: t.agency(first.verificationId, { person: 'han' }) });
    const pid = (await t.verifications.claimsOf(s.accountId))!.pid;
    const same = await t.start.run({ accountId: s.accountId, purpose: 'REVERIFY', next: '/' });
    expect((await t.confirm.run({ accountId: s.accountId, verificationId: same.verificationId, providerResult: t.agency(same.verificationId, { person: 'han' }) })).status).toBe('VERIFIED');
    const other = await t.start.run({ accountId: s.accountId, purpose: 'REVERIFY', next: '/' });
    expect((await t.confirm.run({ accountId: s.accountId, verificationId: other.verificationId, providerResult: t.agency(other.verificationId, { person: 'oh' }) })).status).toBe('FAILED');
    expect((await t.verifications.claimsOf(s.accountId))!.pid).toBe(pid);
  });

  test('openapi_기관결과는그건에묶여야한다_다른건의결과값이면FAILED다(새맥락리뷰)', async () => {
    const t = await setup();
    const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v-bind', email: null, deviceId: null });
    const a = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
    const b = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
    expect((await t.confirm.run({ accountId: s.accountId, verificationId: b.verificationId, providerResult: t.agency(a.verificationId, { person: 'bind' }) })).status).toBe('FAILED');
    expect((await t.confirm.run({ accountId: s.accountId, verificationId: a.verificationId, providerResult: t.agency(a.verificationId, { person: 'bind' }) })).status).toBe('VERIFIED');
  });

  test('FR002_미성년자계약취소목적은_그단계전까지시작에서거절한다(새맥락리뷰)', async () => {
    const t = await setup();
    expect(await code(t.start.run({ accountId: '0190f3a1-7c2e-7a00-8000-000000000001', purpose: 'MINOR_CONTRACT', next: '/' }))).toBe('PURPOSE_UNSUPPORTED');
  });

  test('FR002_확정한건도1일이지나면_다시보내기를받지않는다(새맥락리뷰)', async () => {
    const t = await setup();
    const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v-late', email: null, deviceId: null });
    const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
    const res = t.agency(st.verificationId, { person: 'late' });
    await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: res });
    t.k.clock.advance(24 * 3_600_000 + 1);
    expect(await code(t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: res }))).toBe('NOT_FOUND');
  });

  test('FR002_UUID가아닌건ID는_찾을수없음이다(새맥락리뷰)', async () => {
    const t = await setup();
    expect(await code(t.result.run({ accountId: '0190f3a1-7c2e-7a00-8000-000000000001', verificationId: 'abc' }))).toBe('NOT_FOUND');
    expect(await code(t.confirm.run({ accountId: '0190f3a1-7c2e-7a00-8000-000000000001', verificationId: 'abc', providerResult: {} }))).toBe('NOT_FOUND');
  });
});

describe('모의 기관과 기관 창 흐름(BOT-010)', () => {
  test('I-T45_기관창값은_모의기관주소·POST·건ID하나이고_방식은설정대로다', async () => {
    for (const mode of ['POPUP', 'REDIRECT'] as const) {
      const t = await setup(mode);
      const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `w-${mode}`, email: null, deviceId: null });
      const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/events/e-1' });
      expect(st.window).toEqual({ url: AGENCY_URL, method: 'POST', fields: { verificationId: st.verificationId }, mode });
    }
  });

  test('I-T45_서명이틀리거나_다른비밀로서명했거나_칸이빠지면_FAILED다', async () => {
    const t = await setup();
    const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'w-sig', email: null, deviceId: null });
    const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
    const good = t.agency(st.verificationId, { person: 'sig' });
    const body = JSON.parse(Buffer.from(good.result!, 'base64url').toString()) as Record<string, unknown>;
    // 이름표만 바꿔 다시 적은 결과(서명은 옛 것): 브라우저가 다른 사람인 척하는 경우
    const swapped = { ...good, result: Buffer.from(JSON.stringify({ ...body, person: 'someone-else' })).toString('base64url') };
    const wrongKey = agencyResult(t.k.clock, st.verificationId, { person: 'sig' }, Buffer.alloc(32, 9));
    const bad: Record<string, string>[] = [
      swapped,
      wrongKey,
      { ...good, mac: good.mac!.slice(0, -2) + (good.mac!.endsWith('AA') ? 'BB' : 'AA') },
      { verificationId: st.verificationId, result: good.result! },
      { verificationId: st.verificationId, testPerson: 'sig' },
      { ...good, result: '!!!' },
    ];
    for (const r of bad) expect((await t.provider.confirm(st.verificationId, r)).outcome).toBe('FAILED');
    expect((await t.provider.confirm(st.verificationId, good)).outcome).toBe('VERIFIED');
  });

  test('I-T45_결과값의건ID와칸의건ID가_그건이아니면FAILED다', async () => {
    const t = await setup();
    const id = '0190f3a1-7c2e-7a00-8000-0000000000aa';
    const other = '0190f3a1-7c2e-7a00-8000-0000000000bb';
    const sealedForOther = t.agency(other, { person: 'tx' });
    expect((await t.provider.confirm(id, sealedForOther)).outcome).toBe('FAILED');
    // 칸의 건 ID만 바꿔도(서명한 본문은 다른 건) 받지 않는다
    expect((await t.provider.confirm(id, { ...sealedForOther, verificationId: id })).outcome).toBe('FAILED');
    expect((await t.provider.confirm(id, { ...t.agency(id, { person: 'tx' }), verificationId: other })).outcome).toBe('FAILED');
  });

  test('I-T45_만든지10분이넘었거나_1분넘게앞선결과는_FAILED다', async () => {
    const t = await setup();
    const id = '0190f3a1-7c2e-7a00-8000-0000000000cc';
    const now = t.k.clock.now();
    expect((await t.provider.confirm(id, t.agency(id, { person: 'a', iatMs: now - 10 * 60_000 }))).outcome).toBe('VERIFIED');
    expect((await t.provider.confirm(id, t.agency(id, { person: 'a', iatMs: now - 10 * 60_000 - 1 }))).outcome).toBe('FAILED');
    expect((await t.provider.confirm(id, t.agency(id, { person: 'a', iatMs: now + 60_000 }))).outcome).toBe('VERIFIED');
    expect((await t.provider.confirm(id, t.agency(id, { person: 'a', iatMs: now + 60_001 }))).outcome).toBe('FAILED');
  });

  test('I-T45_기관장애결과면_결과확정이503PROVIDER_DOWN이고_그건은PROVIDER_DOWN으로마쳐다시보내도503이다', async () => {
    const t = await setup();
    const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'w-down', email: null, deviceId: null });
    const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/events/e-3' });
    expect(await code(t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: t.agency(st.verificationId, { outcome: 'DOWN' }) }))).toBe('PROVIDER_DOWN');
    expect(await t.result.run({ accountId: s.accountId, verificationId: st.verificationId })).toEqual({ verificationId: st.verificationId, purpose: 'FIRST', status: 'PROVIDER_DOWN', next: '/events/e-3', restrictedUntil: null });
    // 기관이 살아난 뒤 같은 건에 맞는 결과를 보내도 같은 결과(503)이고 저장하지 않는다. [다시 시도]는 새 건으로 한다
    expect(await code(t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: t.agency(st.verificationId, { person: 'down' }) }))).toBe('PROVIDER_DOWN');
    expect(await t.verifications.claimsOf(s.accountId)).toBeNull();
    const again = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
    expect((await t.confirm.run({ accountId: s.accountId, verificationId: again.verificationId, providerResult: t.agency(again.verificationId, { person: 'down' }) })).status).toBe('VERIFIED');
  });

  test('I-T45_이름표가없거나64자를넘는VERIFIED는_FAILED다', async () => {
    const t = await setup();
    const id = '0190f3a1-7c2e-7a00-8000-0000000000dd';
    expect((await t.provider.confirm(id, t.agency(id, { outcome: 'VERIFIED' }))).outcome).toBe('FAILED');
    expect((await t.provider.confirm(id, t.agency(id, { person: 'x'.repeat(65) }))).outcome).toBe('FAILED');
    expect((await t.provider.confirm(id, t.agency(id, { person: 'x'.repeat(64) }))).outcome).toBe('VERIFIED');
  });

  test('I-T45_결과값형식은_봉하고열면그대로이고_생년월일모양이틀리면열지않는다', () => {
    const r = { v: 1 as const, tx: 'tx-1', outcome: 'VERIFIED' as const, person: '김', birth: '2010-03-04', iat: 1_762_137_600_000 };
    const sealed = sealTestAgencyResult(AGENCY_SECRET, r);
    expect(Object.keys(sealed).sort()).toEqual(['mac', 'result', 'verificationId']);
    expect(sealed.verificationId).toBe('tx-1');
    expect(openTestAgencyResult(AGENCY_SECRET, sealed)).toEqual(r);
    expect(openTestAgencyResult(AGENCY_SECRET, sealTestAgencyResult(AGENCY_SECRET, { ...r, birth: '2010/03/04' }))).toBeNull();
    expect(openTestAgencyResult(AGENCY_SECRET, sealTestAgencyResult(AGENCY_SECRET, { ...r, outcome: 'MAYBE' as never }))).toBeNull();
  });

  test('I-T45_시험어댑터는local·ci·demo에서만켜고_모의기관주소·방식이틀리면시작하지않는다', () => {
    const base = { PEAKET_VERIFICATION_PROVIDER: 'test', PEAKET_TEST_VERIFICATION_URL: AGENCY_URL };
    expect(() => TestVerificationProvider.fromEnv({ ...base, PEAKET_ENV: 'prod' })).toThrow();
    expect(() => TestVerificationProvider.fromEnv({ ...base, PEAKET_ENV: 'staging' })).toThrow();
    expect(() => TestVerificationProvider.fromEnv({ PEAKET_ENV: 'local', PEAKET_VERIFICATION_PROVIDER: 'test' })).toThrow(/PEAKET_TEST_VERIFICATION_URL/);
    expect(() => TestVerificationProvider.fromEnv({ ...base, PEAKET_ENV: 'local', PEAKET_TEST_VERIFICATION_URL: 'javascript:alert(1)' })).toThrow();
    expect(() => TestVerificationProvider.fromEnv({ ...base, PEAKET_ENV: 'local', PEAKET_TEST_VERIFICATION_MODE: 'TAB' })).toThrow(/PEAKET_TEST_VERIFICATION_MODE/);
    const p = TestVerificationProvider.fromEnv({ ...base, PEAKET_ENV: 'ci', PEAKET_TEST_VERIFICATION_MODE: 'REDIRECT' });
    expect(p.window('w').mode).toBe('REDIRECT');
    // demo는 바깥에서 닿으므로 공개된 개발용 비밀로 시작하지 않는다
    expect(() => TestVerificationProvider.fromEnv({ ...base, PEAKET_ENV: 'demo' })).toThrow(/PEAKET_TEST_VERIFICATION_SECRET/);
    const secret = AGENCY_SECRET.toString('base64');
    expect(TestVerificationProvider.fromEnv({ ...base, PEAKET_ENV: 'demo', PEAKET_TEST_VERIFICATION_SECRET: secret }).window('w')).toEqual({ url: AGENCY_URL, method: 'POST', fields: { verificationId: 'w' }, mode: 'POPUP' });
  });
});
