// 본인확인 시험 어댑터와 구매 권한(docs/features/identity.md §5 '본인확인 시험 어댑터와 첫 구현', BUILD_ORDER PRF-040, FR-002, POL-001, I-T6).
import { decodeJwt } from 'jose';
import { describe, expect, test } from 'vitest';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { TestVerificationProvider } from '../src/modules/verification/adapters/test-verification-provider.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { GetVerificationResult } from '../src/modules/verification/application/get-verification-result.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { VerificationError } from '../src/modules/verification/application/verification-error.js';
import { kit, newKey } from './support.js';

async function setup() {
  const verifications = new MemoryVerificationStore();
  const claims = new VerificationClaims(verifications);
  const k = await kit(new MemorySessionStore(), { claims });
  const provider = new TestVerificationProvider(Buffer.alloc(32, 3), 'https://www.peaket.test');
  const hashers = new HmacIdentityHashers(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  return {
    k,
    verifications,
    start: new StartVerification(verifications, provider, k.clock),
    confirm: new ConfirmVerification(verifications, provider, hashers, k.clock),
    result: new GetVerificationResult(verifications, k.clock),
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
    expect(st.window).toMatchObject({ url: 'https://www.peaket.test/verify/return', method: 'POST', mode: 'POPUP', fields: { verificationId: st.verificationId } });
    expect(st.expiresAt).toBe(t.k.clock.now() + 10 * 60_000);
    const r = await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: { testPerson: 'kim' } });
    expect(r).toEqual({ verificationId: st.verificationId, purpose: 'FIRST', status: 'VERIFIED', next: '/my/settings', restrictedUntil: null });
    const after = await t.k.refresh.run({ refreshToken: s.refreshToken });
    if (after.result !== 'OK') throw new Error(after.result);
    const claims = decodeJwt(after.accessToken);
    expect(claims.scope).toBe('ticket:buy');
    expect(claims.pid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 같은 결과를 다시 보내면 같은 결과다
    expect(await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: { testPerson: 'kim' } })).toEqual(r);
    expect(await t.result.run({ accountId: s.accountId, verificationId: st.verificationId })).toEqual(r);
  });

  test('I-T6_같은사람이다른계정에서본인확인하면_DUPLICATE_ACCOUNT이고저장하지않는다', async () => {
    const t = await setup();
    const a = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v-a', email: null, deviceId: null });
    const b = await t.k.create.run({ idempotencyKey: newKey(), provider: 'naver', providerUserId: 'v-b', email: null, deviceId: null });
    const sa = await t.start.run({ accountId: a.accountId, purpose: 'FIRST', next: '/' });
    await t.confirm.run({ accountId: a.accountId, verificationId: sa.verificationId, providerResult: { testPerson: 'lee' } });
    const sb = await t.start.run({ accountId: b.accountId, purpose: 'FIRST', next: '/' });
    expect(await code(t.confirm.run({ accountId: b.accountId, verificationId: sb.verificationId, providerResult: { testPerson: 'lee' } }))).toBe('DUPLICATE_ACCOUNT');
    expect((await t.result.run({ accountId: b.accountId, verificationId: sb.verificationId })).status).toBe('DUPLICATE_ACCOUNT');
    expect(await t.verifications.claimsOf(b.accountId)).toBeNull();
  });

  test('POL001_같은사람의pid는_계정이바뀌어도같고_다른사람이면다르다', async () => {
    const t = await setup();
    const ids: string[] = [];
    for (const person of ['park', 'choi']) {
      const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'google', providerUserId: `v-${person}`, email: null, deviceId: null });
      const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
      await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: { testPerson: person } });
      ids.push((await t.verifications.claimsOf(s.accountId))!.pid);
    }
    expect(ids[0]).not.toBe(ids[1]);
    const again = new HmacIdentityHashers(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
    const provider = new TestVerificationProvider(Buffer.alloc(32, 3), 'https://www.peaket.test');
    const ci = await provider.confirm('x', { testPerson: 'park' });
    if (ci.outcome !== 'VERIFIED') throw new Error('x');
    expect(again.pid(again.ci(ci.ci).hmac).pid.toString('base64url')).toBe(ids[0]);
  });

  test('FR002_이미본인확인한계정의FIRST시작은409이고_취소·실패는저장하지않는다', async () => {
    const t = await setup();
    const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v-2', email: null, deviceId: null });
    for (const outcome of ['CANCELLED', 'FAILED']) {
      const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
      expect((await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: { outcome } })).status).toBe(outcome);
    }
    expect(await t.verifications.claimsOf(s.accountId)).toBeNull();
    const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
    await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: { testPerson: 'jung' } });
    expect(await code(t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' }))).toBe('ALREADY_VERIFIED');
  });

  test('ASVS v5.0.0-3.7.2_돌아갈주소가같은출처경로가아니면_시작하지않는다', async () => {
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
    expect(await code(t.confirm.run({ accountId: b.accountId, verificationId: st.verificationId, providerResult: { testPerson: 'x' } }))).toBe('NOT_FOUND');
    expect(await code(t.result.run({ accountId: b.accountId, verificationId: st.verificationId }))).toBe('NOT_FOUND');
    expect((await t.result.run({ accountId: a.accountId, verificationId: st.verificationId })).status).toBe('PENDING');
    t.k.clock.advance(10 * 60_000 + 1);
    expect(await code(t.confirm.run({ accountId: a.accountId, verificationId: st.verificationId, providerResult: { testPerson: 'x' } }))).toBe('NOT_FOUND');
    const st2 = await t.start.run({ accountId: a.accountId, purpose: 'FIRST', next: '/' });
    await t.confirm.run({ accountId: a.accountId, verificationId: st2.verificationId, providerResult: { testPerson: 'y' } });
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
    await t.confirm.run({ accountId: s.accountId, verificationId: first.verificationId, providerResult: { testPerson: 'han' } });
    const pid = (await t.verifications.claimsOf(s.accountId))!.pid;
    const same = await t.start.run({ accountId: s.accountId, purpose: 'REVERIFY', next: '/' });
    expect((await t.confirm.run({ accountId: s.accountId, verificationId: same.verificationId, providerResult: { testPerson: 'han' } })).status).toBe('VERIFIED');
    const other = await t.start.run({ accountId: s.accountId, purpose: 'REVERIFY', next: '/' });
    expect((await t.confirm.run({ accountId: s.accountId, verificationId: other.verificationId, providerResult: { testPerson: 'oh' } })).status).toBe('FAILED');
    expect((await t.verifications.claimsOf(s.accountId))!.pid).toBe(pid);
  });

  test('openapi_기관결과는그건에묶여야한다_다른건의결과값이면FAILED다(새맥락리뷰)', async () => {
    const t = await setup();
    const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v-bind', email: null, deviceId: null });
    const a = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
    const b = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
    expect((await t.confirm.run({ accountId: s.accountId, verificationId: b.verificationId, providerResult: { verificationId: a.verificationId, testPerson: 'bind' } })).status).toBe('FAILED');
    expect((await t.confirm.run({ accountId: s.accountId, verificationId: a.verificationId, providerResult: { verificationId: a.verificationId, testPerson: 'bind' } })).status).toBe('VERIFIED');
  });

  test('FR002_미성년자계약취소목적은_그단계전까지시작에서거절한다(새맥락리뷰)', async () => {
    const t = await setup();
    expect(await code(t.start.run({ accountId: '0190f3a1-7c2e-7a00-8000-000000000001', purpose: 'MINOR_CONTRACT', next: '/' }))).toBe('PURPOSE_UNSUPPORTED');
  });

  test('FR002_확정한건도1일이지나면_다시보내기를받지않는다(새맥락리뷰)', async () => {
    const t = await setup();
    const s = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v-late', email: null, deviceId: null });
    const st = await t.start.run({ accountId: s.accountId, purpose: 'FIRST', next: '/' });
    await t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: { testPerson: 'late' } });
    t.k.clock.advance(24 * 3_600_000 + 1);
    expect(await code(t.confirm.run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: { testPerson: 'late' } }))).toBe('NOT_FOUND');
  });

  test('FR002_UUID가아닌건ID는_찾을수없음이다(새맥락리뷰)', async () => {
    const t = await setup();
    expect(await code(t.result.run({ accountId: '0190f3a1-7c2e-7a00-8000-000000000001', verificationId: 'abc' }))).toBe('NOT_FOUND');
    expect(await code(t.confirm.run({ accountId: '0190f3a1-7c2e-7a00-8000-000000000001', verificationId: 'abc', providerResult: {} }))).toBe('NOT_FOUND');
  });
});
