// 관리 계정 토큰 갱신과 로그아웃의 REST 꼴(openapi POST /v1/partner/auth/access-tokens·/v1/ops/auth/access-tokens, DELETE …/auth/sessions/me)
// (docs/features/identity.md §6 '관리 계정 토큰 갱신과 로그아웃의 첫 구현', BUILD_ORDER BOT-130). 시험: I-T46 ①②③⑥(④⑤는 게이트웨이, BOT-132).
import 'reflect-metadata';
import { type AdminAuthzPort, createService, fakeClock } from '@peaket/platform';
import { decodeJwt } from 'jose';
import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { JoseAdminTokenSigner } from '../src/modules/admin/adapters/jose-admin-token-signer.js';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { LocalTotpSeedCipher } from '../src/modules/admin/adapters/local-totp-seed-cipher.js';
import type { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { MemoryAdminMailer } from '../src/modules/admin/adapters/memory-admin-mailer.js';
import { Pbkdf2AdminPasswords } from '../src/modules/admin/adapters/pbkdf2-admin-passwords.js';
import { loadPolicyLists } from '../src/modules/admin/adapters/word-list-files.js';
import { GetAdminAuthz } from '../src/modules/admin/application/get-admin-authz.js';
import { BeginTotpEnrollment, ConfirmTotpEnrollment } from '../src/modules/admin/application/totp-enrollment.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { ADMIN_LOGIN_STORE } from '../src/modules/admin/domain/ports.js';
import { base32Decode, totpAt } from '../src/modules/admin/domain/totp.js';
import { JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { fanKey, ISSUER, recordingSignals, testAgency, testDeviceRefs } from './support.js';

const PARTNER = '0190f3a1-7c2e-7a00-8000-0000000003a1';
const OPS = '0190f3a1-7c2e-7a00-8000-0000000003a2';
const PW = '봄비내리는월요일아침의커피한잔';
const M = 60_000;
const clock = fakeClock({ now: Date.parse('2026-11-05T03:00:00Z') });
const pepper = new LocalPepper(new Map([[1, Buffer.alloc(32, 8)]]), 1);
const seeds: Record<string, Buffer> = {};
const refreshResults: string[] = [];
let svc: Awaited<ReturnType<typeof createService>>;
let store: MemoryAdminAccountStore;
const authzHolder: { port?: AdminAuthzPort } = {};

beforeAll(async () => {
  const fan = await fanKey();
  const admin = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk), PEAKET_ADMIN_TOKEN_KEY: JSON.stringify({ ...admin.privateJwk, kid: 'admin-rt' }) });
  svc = await createService({
    name: 'identity-svc',
    module: AppModule.register({
      memory: true,
      session: { signer: new JoseTokenSigner(keys, ISSUER), keys, deviceRefs: testDeviceRefs(), signals: recordingSignals() },
      verification: { provider: testAgency(clock), hashers: HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5)) },
      admin: {
        config: DEFAULT_ADMIN_AUTH_CONFIG,
        lists: loadPolicyLists({}),
        pepper,
        iterations: 1_000,
        breaches: { isBreached: async () => false },
        humanCheck: { verify: async (t) => (t === 'ok' ? 'OK' : 'FAILED') },
        signals: { failure: () => {}, alert: () => {}, refreshed: (aud: string, result: string) => void refreshResults.push(`${aud}:${result}`) },
        totpCipher: new LocalTotpSeedCipher(Buffer.alloc(32, 6)),
        signer: new JoseAdminTokenSigner(keys, ISSUER),
        cookieDomain: 'peaket.example',
        mailer: new MemoryAdminMailer(),
      },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    adminAuthz: { getAdminAuthz: (q, o) => authzHolder.port!.getAdminAuthz(q, o) },
  });
  authzHolder.port = svc.app.get(GetAdminAuthz);
  store = svc.app.get<MemoryAdminAccountStore>(ADMIN_LOGIN_STORE);
  const hasher = new Pbkdf2AdminPasswords(pepper, { iterations: 1_000 });
  store.create({ id: PARTNER, role: 'partner_admin', email: 'refresh.partner@haeoreum.example', status: 'ACTIVE', promoterId: '0190f3a1-7c2e-7a00-8000-000000000001', now: clock.now() });
  store.create({ id: OPS, role: 'operator', email: 'refresh.ops@peaket.example', status: 'ACTIVE', now: clock.now() });
  for (const id of [PARTNER, OPS]) {
    await store.setPassword({ id, phc: await hasher.hash(id, PW), breachCheckedAt: clock.now(), now: clock.now() });
    const { otpauthUri } = await svc.app.get(BeginTotpEnrollment).run({ accountId: id });
    seeds[id] = base32Decode(new URL(otpauthUri).searchParams.get('secret')!);
    await svc.app.get(ConfirmTotpEnrollment).run({ accountId: id, code: totpAt(seeds[id]!, Math.floor(clock.now() / 30_000)) });
  }
});
afterAll(async () => {
  await svc?.close();
});

type Aud = 'partner' | 'ops';
const EMAIL: Record<Aud, string> = { partner: 'refresh.partner@haeoreum.example', ops: 'refresh.ops@peaket.example' };
const ID: Record<Aud, string> = { partner: PARTNER, ops: OPS };
const RT: Record<Aud, string> = { partner: '__Secure-peaket_partner_rt', ops: '__Host-peaket_ops_rt' };
const AT: Record<Aud, string> = { partner: '__Secure-peaket_partner_at', ops: '__Host-peaket_ops_at' };

const post = (url: string, body: unknown, ip: string) => svc.http.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, payload: JSON.stringify(body) });
const cookiesOf = (r: { headers: Record<string, unknown> }): string[] => [r.headers['set-cookie']].flat().filter(Boolean) as string[];
const valueOf = (cookies: string[], name: string) => cookies.find((c) => c.startsWith(`${name}=`))?.split(';')[0]!.slice(name.length + 1);

/** 비밀번호와 TOTP로 로그인해 쿠키 값 둘과 세션 ID를 받는다 */
async function login(aud: Aud, ip = '198.51.100.30'): Promise<{ at: string; rt: string; sessionId: string }> {
  clock.advance(30_000);
  const s1 = JSON.parse((await post(`/v1/${aud}/auth/sessions`, { email: EMAIL[aud], password: PW, humanCheckToken: 'ok' }, ip)).payload) as { loginStep: string };
  const s2 = await post(`/v1/${aud}/auth/sessions`, { loginStep: s1.loginStep, code: totpAt(seeds[ID[aud]]!, Math.floor(clock.now() / 30_000)) }, ip);
  expect(s2.statusCode).toBe(200);
  const c = cookiesOf(s2);
  return { at: valueOf(c, AT[aud])!, rt: valueOf(c, RT[aud])!, sessionId: decodeJwt(valueOf(c, AT[aud])!).sid as string };
}
const refresh = (aud: Aud, cookie: string | undefined) => svc.http.inject({ method: 'POST', url: `/v1/${aud}/auth/access-tokens`, headers: cookie ? { cookie } : {} });
const sessionOf = (aud: Aud, id: string) => store.sessions(ID[aud]).find((s) => s.id === id)!;

describe('관리 토큰 갱신(I-T46)', () => {
  test('I-T46①_파트너·운영자리프레시쿠키로갱신하면204와새쿠키둘이고본문에토큰이없으며_유휴만료만늘고절대만료는그대로다 [ASVS v5.0.0-7.2.4]', async () => {
    for (const aud of ['partner', 'ops'] as const) {
      const s = await login(aud);
      const before = sessionOf(aud, s.sessionId);
      clock.advance(20 * M);
      const r = await refresh(aud, `${RT[aud]}=${s.rt}; other=1`);
      expect(r.statusCode).toBe(204);
      expect(r.payload).toBe('');
      expect(r.headers['cache-control']).toBe('no-store');
      const c = cookiesOf(r);
      const at = valueOf(c, AT[aud])!;
      const rt = valueOf(c, RT[aud])!;
      expect(rt).not.toBe(s.rt);
      expect(decodeJwt(at)).toMatchObject({ sid: s.sessionId, sub: ID[aud], aud });
      expect(decodeJwt(at).scope).toBeUndefined();
      // 로그인과 같은 이름·속성(§3 쿠키 표), Max-Age는 절대 만료까지 남은 초
      const maxAge = Math.floor((before.absoluteExpiresAt - clock.now()) / 1000);
      if (aud === 'partner') {
        expect(c).toContain(`${AT.partner}=${at}; Domain=peaket.example; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`);
        expect(c).toContain(`${RT.partner}=${rt}; Domain=peaket.example; Path=/v1/partner/auth/access-tokens; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`);
      } else {
        expect(c).toContain(`${AT.ops}=${at}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`);
        expect(c).toContain(`${RT.ops}=${rt}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`);
      }
      const after = sessionOf(aud, s.sessionId);
      expect(after.idleExpiresAt).toBe(clock.now() + 60 * M);
      expect(after.absoluteExpiresAt).toBe(before.absoluteExpiresAt);
    }
    expect(refreshResults).toEqual(expect.arrayContaining(['partner:rotated', 'ops:rotated']));
  });

  test('I-T46⑥_갱신응답을잃은뒤30초안에같은토큰으로다시갱신하면204이고세션이이어지며_②30초가지난뒤앞토큰이면401과패밀리종료·REFRESH_REUSE사건이다 [ASVS v5.0.0-7.2.4]', async () => {
    const s = await login('partner');
    const first = await refresh('partner', `${RT.partner}=${s.rt}`);
    expect(first.statusCode).toBe(204);
    // 응답을 잃었다: 같은 토큰으로 다시
    clock.advance(10_000);
    const again = await refresh('partner', `${RT.partner}=${s.rt}`);
    expect(again.statusCode).toBe(204);
    const latest = valueOf(cookiesOf(again), RT.partner)!;
    expect(sessionOf('partner', s.sessionId).terminatedAt).toBeNull();
    // 먼저 준(받지 못한) 토큰은 이제 쓸 수 없다: 지금 토큰은 다시 받은 것이다
    expect((await refresh('partner', `${RT.partner}=${latest}`)).statusCode).toBe(204);
    // 30초가 지난 뒤 처음 토큰이 다시 오면 탈취로 본다
    clock.advance(31_000);
    const reused = await refresh('partner', `${RT.partner}=${s.rt}`);
    expect(reused.statusCode).toBe(401);
    expect(JSON.parse(reused.payload)).toMatchObject({ type: 'https://peaket.example/problems/refresh-token-invalid' });
    expect(reused.headers['www-authenticate']).toBe('Cookie realm="peaket"');
    expect(cookiesOf(reused)).toEqual([
      `${AT.partner}=; Domain=peaket.example; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`,
      `${RT.partner}=; Domain=peaket.example; Path=/v1/partner/auth/access-tokens; Max-Age=0; Secure; HttpOnly; SameSite=Strict`,
    ]);
    expect(sessionOf('partner', s.sessionId)).toMatchObject({ terminationReason: 'REFRESH_REUSE' });
    expect(store.terminatedEvents()).toContainEqual({ accountId: PARTNER, sessionId: s.sessionId, reason: 'REFRESH_REUSE' });
    expect(refreshResults).toContain('partner:reused');
  });

  test('I-T46③_유휴만료(1시간)뒤나절대만료뒤의갱신은401이고_모양이틀리거나없거나다른콘솔쿠키도401이다 [ASVS v5.0.0-7.3.1]', async () => {
    const s = await login('ops');
    clock.advance(61 * M);
    expect((await refresh('ops', `${RT.ops}=${s.rt}`)).statusCode).toBe(401);
    const p = await login('partner');
    // 파트너 토큰을 관제 쿠키 이름으로 관제 경로에 보낸다
    expect((await refresh('ops', `${RT.ops}=${p.rt}`)).statusCode).toBe(401);
    expect((await refresh('partner', `${RT.partner}=short`)).statusCode).toBe(401);
    expect((await refresh('partner', undefined)).statusCode).toBe(401);
    // 관제 쿠키 이름의 값은 파트너 경로가 읽지 않는다
    expect((await refresh('partner', `${RT.ops}=${p.rt}`)).statusCode).toBe(401);
    // 그 사이 세션은 그대로다(다른 콘솔 쿠키로 끝내지 않는다)
    expect(sessionOf('partner', p.sessionId).terminatedAt).toBeNull();
    // 절대 만료(24시간): 50분마다 갱신해 유휴 만료를 피해도 24시간이 지나면 끝
    let rt = p.rt;
    for (let k = 0; k < 30; k++) {
      clock.advance(50 * M);
      const r = await refresh('partner', `${RT.partner}=${rt}`);
      if (r.statusCode !== 204) {
        expect(clock.now()).toBeGreaterThanOrEqual(sessionOf('partner', p.sessionId).absoluteExpiresAt);
        expect(r.statusCode).toBe(401);
        return;
      }
      rt = valueOf(cookiesOf(r), RT.partner)!;
      expect(sessionOf('partner', p.sessionId).idleExpiresAt).toBeLessThanOrEqual(sessionOf('partner', p.sessionId).absoluteExpiresAt);
    }
    throw new Error('절대 만료가 지나도 갱신됐다');
  });

  test('비밀번호바꾸기필요계정의갱신은password_change스코프를다시붙인다(auth-controls §3.5, BOT-123이 넘긴 것)', async () => {
    const s = await login('partner');
    store.setPasswordChangeRequired(PARTNER, true);
    const r = await refresh('partner', `${RT.partner}=${s.rt}`);
    expect(r.statusCode).toBe(204);
    expect(decodeJwt(valueOf(cookiesOf(r), AT.partner)!)).toMatchObject({ scope: 'password:change' });
    store.setPasswordChangeRequired(PARTNER, false);
  });
});

describe('관리 로그아웃(DELETE /v1/{콘솔}/auth/sessions/me)', () => {
  test('지금세션을끝내고LOGOUT사건을적으며그콘솔쿠키둘만Max-Age0으로지우고_그뒤갱신은401이다_비밀번호바꾸기필요세션도로그아웃할수있다 [ASVS v5.0.0-7.4.1]', async () => {
    const s = await login('partner');
    const headers = { 'x-user-id': PARTNER, 'x-session-id': s.sessionId, 'x-user-aud': 'partner', 'x-user-scope': 'password:change' };
    const r = await svc.http.inject({ method: 'DELETE', url: '/v1/partner/auth/sessions/me', headers });
    expect(r.statusCode).toBe(204);
    expect(r.headers['clear-site-data']).toBeUndefined();
    expect(cookiesOf(r)).toEqual([
      `${AT.partner}=; Domain=peaket.example; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`,
      `${RT.partner}=; Domain=peaket.example; Path=/v1/partner/auth/access-tokens; Max-Age=0; Secure; HttpOnly; SameSite=Strict`,
    ]);
    expect(sessionOf('partner', s.sessionId)).toMatchObject({ terminationReason: 'LOGOUT' });
    expect(store.terminatedEvents()).toContainEqual({ accountId: PARTNER, sessionId: s.sessionId, reason: 'LOGOUT' });
    expect((await refresh('partner', `${RT.partner}=${s.rt}`)).statusCode).toBe(401);
    // 끝난 세션으로 다시 부르면 가드가 401(가드의 역할 캐시 5초가 지난 뒤, ADR-0172)
    clock.advance(6_000);
    expect((await svc.http.inject({ method: 'DELETE', url: '/v1/partner/auth/sessions/me', headers })).statusCode).toBe(401);
    // 관제 로그아웃도 같다(쿠키는 __Host-, Domain 없음)
    const o = await login('ops');
    const ro = await svc.http.inject({ method: 'DELETE', url: '/v1/ops/auth/sessions/me', headers: { 'x-user-id': OPS, 'x-session-id': o.sessionId, 'x-user-aud': 'ops' } });
    expect(ro.statusCode).toBe(204);
    expect(cookiesOf(ro)).toEqual([`${AT.ops}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`, `${RT.ops}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`]);
  });
});

describe('계정이 바뀐 세션의 갱신', () => {
  // 이 파일의 마지막 시험이다(관제 계정을 지운다)
  test('지운계정의갱신은401이고그세션을끝낸다(DELETE) [ASVS v5.0.0-7.4.2]', async () => {
    const o = await login('ops');
    store.remove(OPS);
    expect((await refresh('ops', `${RT.ops}=${o.rt}`)).statusCode).toBe(401);
    expect(sessionOf('ops', o.sessionId)).toMatchObject({ terminationReason: 'DELETE' });
    expect(store.terminatedEvents()).toContainEqual({ accountId: OPS, sessionId: o.sessionId, reason: 'DELETE' });
  });
});
