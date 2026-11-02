// identity-svc 앱 포트의 REST 경로: 팬 토큰 갱신(openapi POST /v1/identity/access-tokens, I-T4)과 공개키 묶음(GET /internal/jwks/{set}.json, I-T20).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CreateSession, JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { fanKey, ISSUER, newKey, recordingSignals, testDeviceRefs } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const quiet = new Writable({ write: (_c, _e, cb) => cb() });

beforeAll(async () => {
  const fan = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) });
  svc = await createService({
    name: 'identity-svc',
    module: AppModule.register({ memory: true, session: { signer: new JoseTokenSigner(keys, ISSUER), keys, deviceRefs: testDeviceRefs(), signals: recordingSignals(), cookieDomain: 'peaket.example' } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: Date.parse('2026-11-03T03:00:00Z') }),
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});

const login = () => svc.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `u-${newKey().slice(0, 8)}`, email: null, deviceId: null });
const refresh = (cookie?: string) => svc.http.inject({ method: 'POST', url: '/v1/identity/access-tokens', headers: cookie ? { cookie } : {} });
const attrs = (c: string) => Object.fromEntries(c.split(';').slice(1).map((x) => { const [k, v] = x.trim().split('='); return [k!.toLowerCase(), v ?? true]; }));

describe('팬 토큰 갱신 경로', () => {
  test('I-T4_리프레시쿠키로갱신하면_204와새쿠키둘이고본문에토큰이없다 [ASVS v5.0.0-3.3.4]', async () => {
    const s = await login();
    const r = await refresh(`__Secure-peaket_rt=${s.refreshToken}; other=1`);
    expect(r.statusCode).toBe(204);
    expect(r.payload).toBe('');
    expect(r.headers['cache-control']).toBe('no-store');
    const cookies = [r.headers['set-cookie']].flat() as string[];
    const at = cookies.find((c) => c.startsWith('__Secure-peaket_at='))!;
    const rt = cookies.find((c) => c.startsWith('__Secure-peaket_rt='))!;
    expect(attrs(at)).toMatchObject({ path: '/', domain: 'peaket.example', httponly: true, secure: true, samesite: 'Strict' });
    expect(attrs(rt)).toMatchObject({ path: '/v1/identity/access-tokens', domain: 'peaket.example', httponly: true, secure: true, samesite: 'Strict' });
    // 액세스 쿠키 수명은 리프레시 쿠키와 같다(identity §3)
    expect(attrs(at)['max-age']).toBe(attrs(rt)['max-age']);
    expect(rt).not.toContain(s.refreshToken);
  });

  test('I-T4_재사용탐지와모르는토큰과쿠키없음은_401과WWW-Authenticate이고쿠키를지운다', async () => {
    const s = await login();
    expect((await refresh(`__Secure-peaket_rt=${s.refreshToken}`)).statusCode).toBe(204);
    // 30초 [가정] 유예 밖에서 다시 쓴다(시계를 민다)
    (svc.clock as ReturnType<typeof fakeClock>).advance(31_000);
    for (const r of [await refresh(`__Secure-peaket_rt=${s.refreshToken}`), await refresh('__Secure-peaket_rt=nope'), await refresh()]) {
      expect(r.statusCode).toBe(401);
      expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
      expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/refresh-token-invalid', status: 401 });
      const cleared = [r.headers['set-cookie']].flat() as string[];
      expect(cleared.map((c) => attrs(c)['max-age'])).toEqual(['0', '0']);
    }
  });
});

describe('공개키 묶음 경로', () => {
  test('I-T20_키셋마다공개키묶음을주고_캐시5분이며_없는키셋은404다', async () => {
    const r = await svc.http.inject({ method: 'GET', url: '/internal/jwks/fan.json' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/jwk-set+json');
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    const body = JSON.parse(r.payload) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).not.toHaveProperty('d');
    expect(JSON.parse((await svc.http.inject({ method: 'GET', url: '/internal/jwks/admin.json' })).payload)).toEqual({ keys: [] });
    expect((await svc.http.inject({ method: 'GET', url: '/internal/jwks/other.json' })).statusCode).toBe(404);
  });
});
