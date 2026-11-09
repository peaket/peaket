// 팬 계정 요약과 가입 마무리의 REST 경로(docs/features/identity.md §8 '팬 계정 요약·세션 종료 사유·가입 마무리의 첫 구현', BUILD_ORDER BOT-047, ADR-0235, I-T77~I-T81).
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { ACCOUNT_CLOSURE, type AccountClosure, CreateSession, EndSession, JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { fanKey, ISSUER, newKey, recordingSignals, testDeviceRefs } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const clock = fakeClock({ now: Date.parse('2026-11-03T03:00:00Z') });

beforeAll(async () => {
  const fan = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) });
  svc = await createService({
    name: 'identity-svc',
    module: AppModule.register({ memory: true, session: { signer: new JoseTokenSigner(keys, ISSUER), keys, deviceRefs: testDeviceRefs(), signals: recordingSignals(), cookieDomain: 'peaket.example' } } as never),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
});
afterAll(async () => {
  await svc?.close();
});

const login = (sub: string) => svc.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: sub, email: null, emailVerified: false, deviceId: 'dev-a' });
const fan = (s: { accountId: string; sessionId: string }) => ({ 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'x-user-scope': '', 'content-type': 'application/json' });
const send = (url: string, headers: Record<string, string>, body?: unknown) => svc.http.inject({ method: 'POST', url, headers, payload: JSON.stringify(body ?? {}) });
const FORM = { ageOver14: true, consents: { terms: true, privacy: true, marketing: false, phone: false }, nickname: '피켓팬' };
const SIGNUP = '/v1/identity/signup-completions';
const NICK = '/v1/identity/nickname-checks';
const CANCEL = '/v1/identity/signup-cancellations';
const ME = '/v1/identity/me';
const problem = (r: { body: string }) => (JSON.parse(r.body) as { type: string }).type.split('/').pop();

describe('GET /v1/identity/me(I-T77)', () => {
  test('I-T77_⑤ 칸은 넷이고 이메일·휴대폰 번호·회원 코드가 없으며 no-store다 [ASVS v5.0.0-14.3.2]', async () => {
    const s = await login('me-1');
    const r = await svc.http.inject({ method: 'GET', url: ME, headers: fan(s) });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body)).toEqual({ nickname: null, signupCompleted: false, verified: false, hasStaffAssignment: false });
  });

  test('I-T77_⑥ 끝난 세션의 신원은 401이고 인증 머리가 있다 [ASVS v5.0.0-7.4.1]', async () => {
    const s = await login('me-2');
    await svc.app.get(EndSession).run({ sessionId: s.sessionId, accountId: s.accountId });
    const r = await svc.http.inject({ method: 'GET', url: ME, headers: fan(s) });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBeTruthy();
  });

  test('I-T77_⑥ 신원 없는 요청은 401이다', async () => {
    expect((await svc.http.inject({ method: 'GET', url: ME })).statusCode).toBe(401);
  });
});

describe('POST /v1/identity/access-tokens의 ended(I-T78)', () => {
  test('I-T78_⑥ 끝난 세션의 쿠키로 갱신하면 401 본문에 ended가 있고 모르는 토큰에는 없다', async () => {
    const s = await login('ended-1');
    await svc.app.get(EndSession).run({ sessionId: s.sessionId, accountId: s.accountId });
    const r = await svc.http.inject({ method: 'POST', url: '/v1/identity/access-tokens', headers: { cookie: `__Secure-peaket_rt=${s.refreshToken}` } });
    expect(r.statusCode).toBe(401);
    const body = JSON.parse(r.body) as { type: string; ended?: string };
    expect(body.type.endsWith('/refresh-token-invalid')).toBe(true);
    expect(body.ended).toBe('LOGOUT');
    const unknown = await svc.http.inject({ method: 'POST', url: '/v1/identity/access-tokens', headers: { cookie: '__Secure-peaket_rt=x' } });
    expect(JSON.parse(unknown.body)).not.toHaveProperty('ended');
  });
});

describe('가입 마무리·닉네임 확인·가입 취소의 REST(I-T79~I-T81)', () => {
  test('I-T79_①⑥ 성공은 200과 새 요약이고 no-store다, 다시 보내면 409다 [ASVS v5.0.0-14.3.2]', async () => {
    const s = await login('su-1');
    const r = await send(SIGNUP, fan(s), { ...FORM, nickname: 'Peaket 팬' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body)).toEqual({ nickname: 'Peaket 팬', signupCompleted: true, verified: false, hasStaffAssignment: false });
    const again = await send(SIGNUP, fan(s), { ...FORM, nickname: 'Peaket 팬' });
    expect(again.statusCode).toBe(409);
    expect(problem(again)).toBe('signup-already-completed');
  });

  test('I-T79_③ 필수 동의 없음·동의 없는 휴대폰 번호·모르는 칸은 400이다', async () => {
    const s = await login('su-2');
    expect((await send(SIGNUP, fan(s), { ...FORM, consents: { ...FORM.consents, terms: false } })).statusCode).toBe(400);
    expect((await send(SIGNUP, fan(s), { ...FORM, ageOver14: false })).statusCode).toBe(400);
    expect((await send(SIGNUP, fan(s), { ...FORM, phone: '01012345678' })).statusCode).toBe(400);
    expect((await send(SIGNUP, fan(s), { ...FORM, extra: 1 })).statusCode).toBe(400);
  });

  test('I-T80_③ 쓰인 닉네임은 409, 꼴이 틀린 닉네임은 400 nickname-invalid다', async () => {
    const a = await login('nick-a');
    const b = await login('nick-b');
    expect((await send(SIGNUP, fan(a), { ...FORM, nickname: '고른닉네임' })).statusCode).toBe(200);
    const taken = await send(SIGNUP, fan(b), { ...FORM, nickname: '고른닉네임' });
    expect(taken.statusCode).toBe(409);
    expect(problem(taken)).toBe('nickname-taken');
    const bad = await send(SIGNUP, fan(b), { ...FORM, nickname: '👍' });
    expect(bad.statusCode).toBe(400);
    expect(problem(bad)).toBe('nickname-invalid');
  });

  test('I-T80_⑤⑦ 닉네임 확인은 본문으로만 받고 31번째 요청은 429와 Retry-After다 [ASVS v5.0.0-14.2.1]', async () => {
    const s = await login('nick-limit');
    expect((await send(`${NICK}?nickname=x`, fan(s), {})).statusCode).toBe(400);
    let last = await send(NICK, fan(s), { nickname: '확인할닉네임' });
    expect(JSON.parse(last.body)).toEqual({ available: true });
    for (let i = 0; i < 30; i++) last = await send(NICK, fan(s), { nickname: '확인할닉네임' });
    expect(last.statusCode).toBe(429);
    expect(problem(last)).toBe('nickname-check-limited');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });

  test('I-T79_⑦ 만 14세 미만으로 정리 중인 계정의 가입 마무리는 403 under-14다', async () => {
    const s = await login('under-14');
    await svc.app.get<AccountClosure>(ACCOUNT_CLOSURE).start(s.accountId, 'UNDER_14');
    const r = await send(SIGNUP, fan(s), { ...FORM, nickname: '정리중' });
    expect(r.statusCode).toBe(403);
    expect(problem(r)).toBe('under-14');
  });

  test('I-T80_⑧ 끝난 세션의 닉네임 확인은 401이다', async () => {
    const s = await login('nick-ended');
    await svc.app.get(EndSession).run({ sessionId: s.sessionId, accountId: s.accountId });
    const r = await send(NICK, fan(s), { nickname: '확인할닉네임' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBeTruthy();
  });

  test('I-T81_① 가입 취소는 204와 팬 쿠키 지우기다', async () => {
    const s = await login('cancel-1');
    const r = await send(CANCEL, fan(s), { reason: 'UNDER_14' });
    expect(r.statusCode).toBe(204);
    const cookies = [r.headers['set-cookie']].flat() as string[];
    expect(cookies.some((c) => c.startsWith('__Secure-peaket_at=;') && c.includes('Max-Age=0'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('__Secure-peaket_rt=;') && c.includes('Max-Age=0'))).toBe(true);
    expect((await svc.http.inject({ method: 'GET', url: ME, headers: fan(s) })).statusCode).toBe(401);
  });

  test('I-T81_② 가입을 마친 계정의 가입 취소는 409이고 ③ 끝난 세션은 401이다', async () => {
    const s = await login('cancel-2');
    await send(SIGNUP, fan(s), { ...FORM, nickname: '취소안됨' });
    const r = await send(CANCEL, fan(s), { reason: 'UNDER_14' });
    expect(r.statusCode).toBe(409);
    expect(problem(r)).toBe('signup-already-completed');
    await svc.app.get(EndSession).run({ sessionId: s.sessionId, accountId: s.accountId });
    expect((await send(CANCEL, fan(s), { reason: 'UNDER_14' })).statusCode).toBe(401);
  });
});
