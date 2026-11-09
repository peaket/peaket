// 세션 유스케이스 시험 묶음. 메모리 저장소(단위 시험)와 PostgreSQL 저장소(통합 시험)에 같은 시험을 돌린다.
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { describe, expect, test } from 'vitest';
import type { CreateSessionInput } from '../src/modules/session/application/create-session.js';
import { refreshHash } from '../src/modules/session/application/create-session.js';
import { SessionError } from '../src/modules/session/application/session-error.js';
import type { SessionStore } from '../src/modules/session/domain/ports.js';
import { ISSUER, type Kit, kit, newKey } from './support.js';

/** 저장소 하나를 만든다. peek은 시험이 저장된 값을 들여다보는 길이다 */
export interface StoreUnderTest {
  store: SessionStore;
  refreshHashOf(sessionId: string): Promise<Uint8Array | null>;
  sessionCount(accountId: string): Promise<number>;
  deviceRows(accountId: string): Promise<number>;
  loginVerdictOf(sessionId: string): Promise<string | null>;
}

const login = (k: Kit, over: Partial<CreateSessionInput> = {}) =>
  k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: '4000001', email: 'fan@kakao.test', deviceId: 'dev-A', ...over });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof SessionError) return e.code;
    throw e;
  }
}

export function sessionCases(name: string, make: () => Promise<StoreUnderTest>) {
  describe(`세션 유스케이스(${name})`, () => {
    test('FR001_ADR0119_처음로그인은_새계정과세션을만들고_다음로그인은같은계정이다 [ASVS v5.0.0-6.8.1] [ASVS v5.0.0-10.5.2]', async () => {
      const t = await make();
      const k = await kit(t.store);
      const first = await login(k);
      expect(first.newAccount).toBe(true);
      expect(first.replayed).toBe(false);
      const again = await login(k, { deviceId: 'dev-B' });
      expect(again.newAccount).toBe(false);
      expect(again.accountId).toBe(first.accountId);
      expect(again.sessionId).not.toBe(first.sessionId);
      // 다른 제공자의 같은 sub는 다른 계정이다([ASVS v5.0.0-6.8.1], (제공자, sub) 복합 키)
      const naver = await login(k, { provider: 'naver', email: null });
      expect(naver.accountId).not.toBe(first.accountId);
      expect(k.signals.seen).toEqual(['created:kakao:true', 'created:kakao:false', 'created:naver:true']);
      // 로그인 판정은 trust-svc가 생기기 전까지 UNKNOWN(identity §2 '첫 구현', §7)
      expect(await t.loginVerdictOf(first.sessionId)).toBe('UNKNOWN');
    });

    test('I-T50_①_같은멱등키를다시보내면_세션은하나이고_앞서준리프레시토큰은쓸수없다 [ASVS v5.0.0-7.2.4]', async () => {
      const t = await make();
      const k = await kit(t.store);
      const key = newKey();
      const a = await login(k, { idempotencyKey: key });
      k.clock.advance(3_000);
      const b = await login(k, { idempotencyKey: key });
      expect(b.replayed).toBe(true);
      expect(b.sessionId).toBe(a.sessionId);
      expect(b.newAccount).toBe(a.newAccount);
      expect(await t.sessionCount(a.accountId)).toBe(1);
      expect(await t.deviceRows(a.accountId)).toBe(1);
      expect(b.refreshToken).not.toBe(a.refreshToken);
      expect(Buffer.from((await t.refreshHashOf(a.sessionId))!)).toEqual(Buffer.from(refreshHash(b.refreshToken)));
      expect(k.signals.seen).toEqual(['created:kakao:true', 'replayed:kakao']);
    });

    test('I-T50_①_10분이지난같은키는_잊고새세션을만든다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const key = newKey();
      const a = await login(k, { idempotencyKey: key });
      k.clock.advance(10 * 60_000 + 1);
      const b = await login(k, { idempotencyKey: key });
      expect(b.replayed).toBe(false);
      expect(b.sessionId).not.toBe(a.sessionId);
    });

    test('I-T50_②_같은멱등키에다른provider_user_id는_ALREADY_EXISTS다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const key = newKey();
      await login(k, { idempotencyKey: key });
      expect(await codeOf(login(k, { idempotencyKey: key, providerUserId: '4000002' }))).toBe('ALREADY_EXISTS');
      expect(await codeOf(login(k, { idempotencyKey: key, provider: 'google' }))).toBe('ALREADY_EXISTS');
    });

    test('I-T50_입력모양이틀리면_INVALID_ARGUMENT다', async () => {
      const t = await make();
      const k = await kit(t.store);
      expect(await codeOf(login(k, { idempotencyKey: 'short' }))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(login(k, { providerUserId: '' }))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(login(k, { deviceId: 'x'.repeat(129) }))).toBe('INVALID_ARGUMENT');
    });

    test('POL019_여섯번째기기로그인은_마지막활동이가장이른기기의세션을끝낸다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const first = await login(k, { deviceId: 'dev-0' });
      // 같은 기기의 두 번째 세션은 기기 수를 늘리지 않는다
      k.clock.advance(1_000);
      const sameDevice = await login(k, { deviceId: 'dev-0' });
      for (let d = 1; d <= 4; d++) {
        k.clock.advance(1_000);
        await login(k, { deviceId: `dev-${d}` });
      }
      expect(await t.sessionCount(first.accountId)).toBe(6);
      expect(k.signals.seen.filter((s) => s.startsWith('terminated'))).toEqual([]);
      k.clock.advance(1_000);
      await login(k, { deviceId: 'dev-5' });
      // dev-0의 두 세션이 함께 끝난다
      expect(k.signals.seen.at(-1)).toBe('terminated:DEVICE_LIMIT:2');
      expect(await t.sessionCount(first.accountId)).toBe(5);
      expect(await codeOf(k.reauth.run({ sessionId: sameDevice.sessionId, accountId: first.accountId, provider: 'kakao', providerUserId: '4000001', strength: 'verified', purpose: 'sensitive' }))).toBe('FAILED_PRECONDITION');
    });

    test('identity§10_기기가명키가없으면_기기행없이세션을만든다', async () => {
      const t = await make();
      const k = await kit(t.store, { keyless: true });
      const a = await login(k);
      expect(await t.deviceRows(a.accountId)).toBe(0);
      expect(await t.sessionCount(a.accountId)).toBe(1);
    });

    test('ADR0011_액세스토큰은_팬토큰키ES256_typ_at+jwt_15분이고_scope·pid가없다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const a = await login(k);
      expect(decodeProtectedHeader(a.accessToken)).toMatchObject({ alg: 'ES256', typ: 'at+jwt', kid: k.publicJwk.kid });
      const { payload } = await jwtVerify(a.accessToken, await importJWK(k.publicJwk, 'ES256'), { issuer: ISSUER, audience: 'fan', typ: 'at+jwt', currentDate: new Date(k.clock.now()) });
      expect(payload).toMatchObject({ sub: a.accountId, sid: a.sessionId });
      expect(payload.exp! - payload.iat!).toBe(15 * 60);
      expect(payload).not.toHaveProperty('scope');
      expect(payload).not.toHaveProperty('pid');
      expect(a.accessTokenExpiresAt).toBe(k.clock.now() + 15 * 60_000);
      expect(a.refreshTokenExpiresAt).toBe(k.clock.now() + 14 * 24 * 3_600_000);
    });

    test('I-T50_④_끝난세션에EndSession을다시보내면_성공이고ended는false다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const a = await login(k);
      expect(await k.end.run({ sessionId: a.sessionId, accountId: a.accountId })).toEqual({ ended: true });
      expect(await k.end.run({ sessionId: a.sessionId, accountId: a.accountId })).toEqual({ ended: false });
      expect(k.signals.seen.filter((s) => s.startsWith('terminated'))).toEqual(['terminated:LOGOUT:1']);
    });

    test('I-T50_EndSession은_다른계정이면FAILED_PRECONDITION_없는세션은NOT_FOUND다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const a = await login(k);
      const b = await login(k, { providerUserId: '4000002' });
      expect(await codeOf(k.end.run({ sessionId: a.sessionId, accountId: b.accountId }))).toBe('FAILED_PRECONDITION');
      expect(await codeOf(k.end.run({ sessionId: '0190f3a1-7c2e-7a00-8000-000000000001', accountId: a.accountId }))).toBe('NOT_FOUND');
      expect(await codeOf(k.end.run({ sessionId: 'not-a-uuid', accountId: a.accountId }))).toBe('INVALID_ARGUMENT');
    });

    test('I-T54_①③_재인증토큰은_강도와제공자_세션_FAN_SENSITIVE를싣고5분이다 [ASVS v5.0.0-6.8.4]', async () => {
      const t = await make();
      const k = await kit(t.store);
      const a = await login(k);
      for (const strength of ['verified', 'requested'] as const) {
        const r = await k.reauth.run({ sessionId: a.sessionId, accountId: a.accountId, provider: 'kakao', providerUserId: '4000001', strength, purpose: 'sensitive' });
        if (r.result !== 'ISSUED') throw new Error(r.result);
        expect(decodeProtectedHeader(r.token)).toMatchObject({ alg: 'ES256', typ: 'reauth+jwt', kid: k.publicJwk.kid });
        const { payload } = await jwtVerify(r.token, await importJWK(k.publicJwk, 'ES256'), { issuer: ISSUER, audience: 'fan', typ: 'reauth+jwt', currentDate: new Date(k.clock.now()) });
        expect(payload).toMatchObject({ sub: a.accountId, sid: a.sessionId, act: 'FAN_SENSITIVE', provider: 'kakao', strength });
        expect(typeof payload.jti).toBe('string');
        expect(payload.exp! - payload.iat!).toBe(5 * 60);
        expect(r.expiresAt).toBe(k.clock.now() + 5 * 60_000);
      }
      expect(k.signals.seen.slice(-2)).toEqual(['reauth:kakao:verified', 'reauth:kakao:requested']);
    });

    test('I-T54_고위험재인증이_요청만함이고로그인판정이UNKNOWN이면_본인확인재통과가필요하고토큰이없다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const a = await login(k, { provider: 'naver', providerUserId: 'nv-1', email: null });
      expect(await k.reauth.run({ sessionId: a.sessionId, accountId: a.accountId, provider: 'naver', providerUserId: 'nv-1', strength: 'requested', purpose: 'high-risk' })).toEqual({ result: 'REVERIFY_REQUIRED' });
      expect(k.signals.seen.at(-1)).toBe('reverify:naver');
    });

    test('I-T54_고위험재인증이_확인됨이면_act가FAN_HIGH_RISK인토큰이다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const a = await login(k);
      const r = await k.reauth.run({ sessionId: a.sessionId, accountId: a.accountId, provider: 'kakao', providerUserId: '4000001', strength: 'verified', purpose: 'high-risk' });
      if (r.result !== 'ISSUED') throw new Error(r.result);
      const { payload } = await jwtVerify(r.token, await importJWK(k.publicJwk, 'ES256'), { issuer: ISSUER, audience: 'fan', typ: 'reauth+jwt', currentDate: new Date(k.clock.now()) });
      expect(payload).toMatchObject({ act: 'FAN_HIGH_RISK', strength: 'verified' });
    });

    test('I-T54_다른제공자계정으로재인증하면_ACCOUNT_MISMATCH이고토큰이없다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const a = await login(k);
      // 다른 계정의 카카오, 연결하지 않은 구글
      expect(await k.reauth.run({ sessionId: a.sessionId, accountId: a.accountId, provider: 'kakao', providerUserId: '4000002', strength: 'verified', purpose: 'sensitive' })).toEqual({ result: 'ACCOUNT_MISMATCH' });
      expect(await k.reauth.run({ sessionId: a.sessionId, accountId: a.accountId, provider: 'google', providerUserId: '4000001', strength: 'requested', purpose: 'sensitive' })).toEqual({ result: 'ACCOUNT_MISMATCH' });
      expect(k.signals.seen.slice(-2)).toEqual(['mismatch:kakao', 'mismatch:google']);
    });

    test('I-T54_끝났거나만료됐거나남의세션이면_재인증토큰을주지않는다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const a = await login(k);
      const b = await login(k, { providerUserId: '4000002' });
      const ask = (sessionId: string, accountId: string) => k.reauth.run({ sessionId, accountId, provider: 'kakao', providerUserId: '4000001', strength: 'verified', purpose: 'sensitive' });
      expect(await codeOf(ask(a.sessionId, b.accountId))).toBe('FAILED_PRECONDITION');
      await k.end.run({ sessionId: b.sessionId, accountId: b.accountId });
      expect(await codeOf(k.reauth.run({ sessionId: b.sessionId, accountId: b.accountId, provider: 'kakao', providerUserId: '4000002', strength: 'verified', purpose: 'sensitive' }))).toBe('FAILED_PRECONDITION');
      k.clock.advance(14 * 24 * 3_600_000);
      expect(await codeOf(ask(a.sessionId, a.accountId))).toBe('FAILED_PRECONDITION');
    });
  });
}
