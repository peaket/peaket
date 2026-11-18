// 탈퇴 요청의 HTTP 답(DELETE /v1/identity/account, docs/api/openapi.yaml deleteIdentityAccount 204·202, docs/features/identity.md §8
// '탈퇴 참여자와 탈퇴 미룸의 첫 구현' '차례', ADR-0284, BUILD_ORDER PRF-169, I-T84 ①②, BAT-010 시험 담당).
// 끝냈으면 204, 참여자를 기다려 미뤘으면 본문 없는 202이고 둘 다 Cache-Control: no-store다. 참여자는 SessionModule 선택지로 넣는 대역이다
// (구현 전 트리에서도 읽히도록 새 모듈을 가져오지 않는다).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CreateSession, JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { fanKey, ISSUER, newKey, recordingSignals, testAgency, testDeviceRefs } from './support.js';

type Answer = { state: 'DONE' } | { state: 'PENDING'; reasons: readonly string[] };
let svc: Awaited<ReturnType<typeof createService>>;
let signer: JoseTokenSigner;
const clock = fakeClock({ now: Date.parse('2026-11-18T08:21:09.117Z') });
let answer: Answer = { state: 'PENDING', reasons: ['PAYMENT_PENDING_ORDER'] };
const asked: string[] = [];
const participant = {
  name: 'purchase',
  process: async (accountId: string) => {
    asked.push(accountId);
    return answer;
  },
};

beforeAll(async () => {
  const fan = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) });
  const session = { signer: (signer = new JoseTokenSigner(keys, ISSUER)), keys, deviceRefs: testDeviceRefs(), signals: recordingSignals(), cookieDomain: 'peaket.example', withdrawalParticipants: [participant] };
  svc = await createService({
    name: 'identity-svc',
    module: AppModule.register({ memory: true, session: session as never, verification: { provider: testAgency(clock), hashers: HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5)) } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
});
afterAll(async () => {
  await svc?.close();
});

const login = () => svc.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `w-${newKey().slice(0, 8)}`, email: null, deviceId: null });
const fanHeaders = (s: { accountId: string; sessionId: string }) => ({ 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'x-user-scope': '' });
const reauth = async (s: { accountId: string; sessionId: string }) => (await signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, svc.clock.now())).token;
const del = async (s: { accountId: string; sessionId: string }) =>
  svc.http.inject({ method: 'DELETE', url: '/v1/identity/account', headers: { ...fanHeaders(s), 'content-type': 'application/json', 'x-reauth-token': await reauth(s) }, payload: '{}' });
const refresh = (rt: string) => svc.http.inject({ method: 'POST', url: '/v1/identity/access-tokens', headers: { cookie: `__Secure-peaket_rt=${rt}` } });

describe('DELETE /v1/identity/account의 204·202(I-T84 ①②)', () => {
  test('I-T84②_참여자가PENDING이면_본문없는202이고Cache-Control no-store이며_세션은살아있어갱신이된다', async () => {
    answer = { state: 'PENDING', reasons: ['PAYMENT_PENDING_ORDER'] };
    const s = await login();
    const r = await del(s);
    expect(r.statusCode).toBe(202);
    expect(r.payload).toBe('');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(asked).toContain(s.accountId);
    expect((await refresh(s.refreshToken)).statusCode).toBe(204);
  });

  test('I-T84①_미룬계정이다시요청해참여자가DONE이면_204·no-store이고그세션의갱신이더는안된다 [ASVS v5.0.0-7.4.2]', async () => {
    answer = { state: 'PENDING', reasons: ['DEPOSIT_CANCEL_PENDING'] };
    const s = await login();
    expect((await del(s)).statusCode).toBe(202);
    answer = { state: 'DONE' };
    clock.advance(4_000);
    const r = await del(s);
    expect(r.statusCode).toBe(204);
    expect(r.payload).toBe('');
    expect(r.headers['cache-control']).toBe('no-store');
    expect((await refresh(s.refreshToken)).statusCode).toBe(401);
  });
});
