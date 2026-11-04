// 관리 계정 로그인 1단계의 REST 꼴(openapi POST /v1/partner/auth/sessions·/v1/ops/auth/sessions)과 사람 확인 검증 어댑터(Turnstile siteverify 흉내 서버)
// (docs/features/identity.md §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', BUILD_ORDER BOT-111).
import 'reflect-metadata';
import { createServer } from 'node:http';
import { type AdminAuthzPort, createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { JoseAdminTokenSigner } from '../src/modules/admin/adapters/jose-admin-token-signer.js';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { LocalTotpSeedCipher } from '../src/modules/admin/adapters/local-totp-seed-cipher.js';
import { MemoryAdminMailer } from '../src/modules/admin/adapters/memory-admin-mailer.js';
import { DispatchAdminNotices } from '../src/modules/admin/application/dispatch-admin-notices.js';
import { GetAdminAuthz } from '../src/modules/admin/application/get-admin-authz.js';
import type { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { Pbkdf2AdminPasswords } from '../src/modules/admin/adapters/pbkdf2-admin-passwords.js';
import { TurnstileHumanCheck } from '../src/modules/admin/adapters/turnstile-human-check.js';
import { loadPolicyLists } from '../src/modules/admin/adapters/word-list-files.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { BeginTotpEnrollment, ConfirmTotpEnrollment } from '../src/modules/admin/application/totp-enrollment.js';
import { ADMIN_LOGIN_STORE } from '../src/modules/admin/domain/ports.js';
import { base32Decode, totpAt } from '../src/modules/admin/domain/totp.js';
import { JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { fanKey, ISSUER, recordingSignals, testAgency, testDeviceRefs } from './support.js';

const PARTNER = '0190f3a1-7c2e-7a00-8000-0000000002a1';
const OPS = '0190f3a1-7c2e-7a00-8000-0000000002a2';
let seeds: Record<string, Buffer> = {};
const mailer = new MemoryAdminMailer();
const PW = '봄비내리는월요일아침의커피한잔';
const clock = fakeClock({ now: Date.parse('2026-11-05T02:00:00Z') });
const pepper = new LocalPepper(new Map([[1, Buffer.alloc(32, 8)]]), 1);
let svc: Awaited<ReturnType<typeof createService>>;
// identity 자신의 관리 경로 역할 판정: 앱이 선 뒤에 잇는다(main.ts와 같다, BOT-123)
const authzHolder: { port?: AdminAuthzPort } = {};

beforeAll(async () => {
  const fan = await fanKey();
  const admin = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk), PEAKET_ADMIN_TOKEN_KEY: JSON.stringify({ ...admin.privateJwk, kid: 'admin-http' }) });
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
        signals: { failure: () => {}, alert: () => {} },
        totpCipher: new LocalTotpSeedCipher(Buffer.alloc(32, 6)),
        signer: new JoseAdminTokenSigner(keys, ISSUER),
        cookieDomain: 'peaket.example',
        mailer,
      },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    adminAuthz: { getAdminAuthz: (q, o) => authzHolder.port!.getAdminAuthz(q, o) },
  });
  authzHolder.port = svc.app.get(GetAdminAuthz);
  const store = svc.app.get<MemoryAdminAccountStore>(ADMIN_LOGIN_STORE);
  store.create({ id: PARTNER, role: 'partner_admin', email: 'minji.kim@haeoreum.example', status: 'ACTIVE', promoterId: '0190f3a1-7c2e-7a00-8000-000000000001', now: clock.now() });
  await store.setPassword({ id: PARTNER, phc: await new Pbkdf2AdminPasswords(pepper, { iterations: 1_000 }).hash(PARTNER, PW), breachCheckedAt: clock.now(), now: clock.now() });
  store.create({ id: OPS, role: 'operator', email: 'ops.http@peaket.example', status: 'ACTIVE', now: clock.now() });
  await store.setPassword({ id: OPS, phc: await new Pbkdf2AdminPasswords(pepper, { iterations: 1_000 }).hash(OPS, PW), breachCheckedAt: clock.now(), now: clock.now() });
  // TOTP 등록(받는 경로는 BOT-150): 유스케이스를 바로 부른다
  for (const id of [PARTNER, OPS]) {
    const { otpauthUri } = await svc.app.get(BeginTotpEnrollment).run({ accountId: id });
    seeds[id] = base32Decode(new URL(otpauthUri).searchParams.get('secret')!);
    await svc.app.get(ConfirmTotpEnrollment).run({ accountId: id, code: totpAt(seeds[id]!, Math.floor(clock.now() / 30_000)) });
  }
  clock.advance(30_000);
});
afterAll(async () => {
  await svc?.close();
});

const post = (path: string, body: object, ip = '203.0.113.10') =>
  svc.http.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, payload: JSON.stringify(body) });

describe('REST 꼴(openapi AdminLoginPasswordStep·AdminLoginStep)', () => {
  test('맞으면200과loginStep·next·expiresInSeconds이고캐시하지않는다', async () => {
    const r = await post('/v1/partner/auth/sessions', { email: 'Minji.Kim@haeoreum.example', password: PW, deviceId: 'dev-1' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const b = JSON.parse(r.payload) as { next: string; loginStep: string; expiresInSeconds: number };
    expect(b).toEqual({ next: 'TOTP', loginStep: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresInSeconds: 300 });
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  test('틀리면401admin-login-failed와남은수·사람확인표시이고_5번째는423과Retry-After·lock이다 [ASVS v5.0.0-6.3.1]', async () => {
    const ip = '198.51.100.21';
    const r1 = await post('/v1/partner/auth/sessions', { email: 'minji.kim@haeoreum.example', password: 'nope-1' }, ip);
    expect(r1.statusCode).toBe(401);
    expect(r1.headers['www-authenticate']).toBeTruthy();
    expect(JSON.parse(r1.payload)).toMatchObject({ type: 'https://peaket.example/problems/admin-login-failed', title: '이메일이나 비밀번호가 맞지 않습니다', remainingAttempts: 4, humanCheckRequired: false });
    await post('/v1/partner/auth/sessions', { email: 'minji.kim@haeoreum.example', password: 'nope-2' }, ip);
    await post('/v1/partner/auth/sessions', { email: 'minji.kim@haeoreum.example', password: 'nope-3' }, ip);
    const r4 = await post('/v1/partner/auth/sessions', { email: 'minji.kim@haeoreum.example', password: 'nope-4' }, ip);
    expect(r4.statusCode).toBe(428);
    expect(JSON.parse(r4.payload)).toMatchObject({ type: 'https://peaket.example/problems/human-check-required' });
    await post('/v1/partner/auth/sessions', { email: 'minji.kim@haeoreum.example', password: 'nope-4', humanCheckToken: 'ok' }, ip);
    const r5 = await post('/v1/partner/auth/sessions', { email: 'minji.kim@haeoreum.example', password: 'nope-5', humanCheckToken: 'ok' }, ip);
    expect(r5.statusCode).toBe(423);
    expect(r5.headers['retry-after']).toBe('900');
    expect(JSON.parse(r5.payload)).toMatchObject({ type: 'https://peaket.example/problems/admin-account-locked', lock: 'TIMED', retryAfterSeconds: 900 });
    // 없는 이메일도 같은 꼴이다
    const g = await post('/v1/partner/auth/sessions', { email: 'nobody@haeoreum.example', password: 'nope' }, '198.51.100.22');
    expect(g.statusCode).toBe(401);
    expect(JSON.parse(g.payload)).toMatchObject({ remainingAttempts: 4, humanCheckRequired: false });
    clock.advance(16 * 60_000);
  });

  test('본문꼴이틀리면400이고_관제경로에서는파트너계정이없는계정과같다', async () => {
    expect((await post('/v1/partner/auth/sessions', { email: 'minji.kim@haeoreum.example' })).statusCode).toBe(400);
    expect((await post('/v1/partner/auth/sessions', { email: 'minji.kim@haeoreum.example', password: PW, role: 'commander' })).statusCode).toBe(400);
    expect((await post('/v1/partner/auth/sessions', { email: 'not-an-email', password: PW })).statusCode).toBe(400);
    const r = await post('/v1/ops/auth/sessions', { email: 'minji.kim@haeoreum.example', password: PW }, '198.51.100.23');
    expect(r.statusCode).toBe(401);
  });

  test('AC-T1_출발지는게이트웨이가쓴x-forwarded-for로센다', async () => {
    const ip = '192.0.2.50';
    for (let i = 0; i < 5; i++) await post('/v1/partner/auth/sessions', { email: `src${i}@haeoreum.example`, password: 'x' }, ip);
    expect((await post('/v1/partner/auth/sessions', { email: 'src9@haeoreum.example', password: 'x' }, ip)).statusCode).toBe(428);
    expect((await post('/v1/partner/auth/sessions', { email: 'src9@haeoreum.example', password: 'x' }, '192.0.2.51')).statusCode).toBe(401);
  });
});

describe('사람 확인 검증(Turnstile siteverify 흉내 서버, auth-controls §2.3)', () => {
  type Seen = Record<string, string>;
  async function fakeSiteverify(reply: (form: Seen, n: number) => object | 'HANG') {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += String(c)));
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(raw)) as Seen;
        seen.push(form);
        const out = reply(form, seen.length);
        if (out === 'HANG') return;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/siteverify`;
    return {
      url,
      seen,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    };
  }
  const hostnames = { partner: 'partner.peaket.example', ops: 'console.peaket.example' };

  test('성공·hostname·action이모두맞아야OK이고_비밀·토큰·IP·멱등키를보낸다', async () => {
    const s = await fakeSiteverify((f) => ({ success: f.response === 'good', hostname: f.response === 'good' ? 'partner.peaket.example' : 'x', action: 'login' }));
    const h = new TurnstileHumanCheck({ url: s.url, secret: 'test-secret', hostnames });
    expect(await h.verify('good', { aud: 'partner', remoteIp: '203.0.113.5' })).toBe('OK');
    expect(s.seen[0]).toMatchObject({ secret: 'test-secret', response: 'good', remoteip: '203.0.113.5', idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    // 다른 콘솔의 hostname이면 실패(토큰을 옮겨 쓰지 못한다)
    expect(await h.verify('good', { aud: 'ops', remoteIp: '203.0.113.5' })).toBe('FAILED');
    expect(await h.verify('bad', { aud: 'partner', remoteIp: '203.0.113.5' })).toBe('FAILED');
    await s.close();
    const wrongAction = await fakeSiteverify(() => ({ success: true, hostname: 'partner.peaket.example', action: 'signup' }));
    expect(await new TurnstileHumanCheck({ url: wrongAction.url, secret: 'test-secret', hostnames }).verify('t', { aud: 'partner', remoteIp: '203.0.113.5' })).toBe('FAILED');
    await wrongAction.close();
  });

  test('답이늦으면같은멱등키로한번더묻고_두번다늦으면UNAVAILABLE이며_비밀이없으면늘UNAVAILABLE이다', async () => {
    const s = await fakeSiteverify((_f, n) => (n === 1 ? 'HANG' : { success: true, hostname: 'console.peaket.example', action: 'login' }));
    const h = new TurnstileHumanCheck({ url: s.url, secret: 'test-secret', hostnames, timeoutMs: 200 });
    expect(await h.verify('t', { aud: 'ops', remoteIp: '198.51.100.1' })).toBe('OK');
    expect(s.seen).toHaveLength(2);
    expect(s.seen[1]!.idempotency_key).toBe(s.seen[0]!.idempotency_key);
    await s.close();
    const dead = await fakeSiteverify(() => 'HANG');
    expect(await new TurnstileHumanCheck({ url: dead.url, secret: 'test-secret', hostnames, timeoutMs: 150 }).verify('t', { aud: 'ops', remoteIp: '198.51.100.1' })).toBe('UNAVAILABLE');
    await dead.close();
    expect(await new TurnstileHumanCheck({ url: 'http://127.0.0.1:9', secret: undefined, hostnames }).verify('t', { aud: 'ops', remoteIp: '198.51.100.1' })).toBe('UNAVAILABLE');
  });
});

describe('로그인 2단계 REST(openapi AdminLoginSecondStep·AdminLoginDone, BOT-120)', () => {
  const cookieMap = (sc: string | string[] | undefined) => Object.fromEntries((Array.isArray(sc) ? sc : sc ? [sc] : []).map((c) => [c.split('=')[0]!, c]));

  test('I-T10_2단계가맞으면200next DONE과파트너쿠키둘(Domain·Path·Max-Age·Strict)이고본문에토큰이없다', async () => {
    clock.advance(16 * 60_000);
    const r1 = await post('/v1/partner/auth/sessions', { email: 'minji.kim@haeoreum.example', password: PW, humanCheckToken: 'ok' }, '198.51.100.140');
    expect(r1.statusCode).toBe(200);
    const { loginStep } = JSON.parse(r1.payload) as { loginStep: string };
    const r2 = await post('/v1/partner/auth/sessions', { loginStep, code: totpAt(seeds[PARTNER]!, Math.floor(clock.now() / 30_000)) }, '198.51.100.140');
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.payload)).toEqual({ next: 'DONE' });
    const c = cookieMap(r2.headers['set-cookie']);
    expect(c['__Secure-peaket_partner_at']).toMatch(/; Domain=peaket\.example; Path=\/; Max-Age=86400; Secure; HttpOnly; SameSite=Strict$/);
    expect(c['__Secure-peaket_partner_rt']).toMatch(/; Domain=peaket\.example; Path=\/v1\/partner\/auth\/access-tokens; Max-Age=86400; Secure; HttpOnly; SameSite=Strict$/);
    expect(r2.payload).not.toContain(c['__Secure-peaket_partner_at']!.split(';')[0]!.split('=')[1]!);
    // 같은 loginStep은 다시 못 쓴다
    const again = await post('/v1/partner/auth/sessions', { loginStep, code: '000000' }, '198.51.100.140');
    expect(again.statusCode).toBe(401);
    expect(JSON.parse(again.payload)).toMatchObject({ type: 'https://peaket.example/problems/admin-login-step-invalid' });
  });

  test('관제는__Host-쿠키둘(Domain없음·Path=/)이고_틀린코드는401admin-login-code-invalid와남은수다', async () => {
    clock.advance(30_000);
    const r1 = await post('/v1/ops/auth/sessions', { email: 'ops.http@peaket.example', password: PW }, '198.51.100.141');
    const { loginStep } = JSON.parse(r1.payload) as { loginStep: string };
    const bad = await post('/v1/ops/auth/sessions', { loginStep, code: totpAt(seeds[OPS]!, Math.floor(clock.now() / 30_000)) === '123456' ? '654321' : '123456' }, '198.51.100.141');
    expect(bad.statusCode).toBe(401);
    expect(JSON.parse(bad.payload)).toMatchObject({ type: 'https://peaket.example/problems/admin-login-code-invalid', remainingAttempts: 4 });
    const ok = await post('/v1/ops/auth/sessions', { loginStep, code: totpAt(seeds[OPS]!, Math.floor(clock.now() / 30_000)) }, '198.51.100.141');
    expect(ok.statusCode).toBe(200);
    const c = cookieMap(ok.headers['set-cookie']);
    expect(c['__Host-peaket_ops_at']).toMatch(/^__Host-peaket_ops_at=[^;]+; Path=\/; Max-Age=86400; Secure; HttpOnly; SameSite=Strict$/);
    expect(c['__Host-peaket_ops_rt']).toMatch(/^__Host-peaket_ops_rt=[^;]+; Path=\/; Max-Age=86400; Secure; HttpOnly; SameSite=Strict$/);
  });

  test('두단계꼴을섞은본문은400이다', async () => {
    expect((await post('/v1/partner/auth/sessions', { email: 'minji.kim@haeoreum.example', password: PW, loginStep: 'A'.repeat(43), code: '123456' })).statusCode).toBe(400);
    expect((await post('/v1/partner/auth/sessions', { loginStep: 'short', code: '123456' })).statusCode).toBe(400);
  });
});

describe('본인 해제 REST(openapi /unlocks·/unlock-links, BOT-121)', () => {
  test('AC-T5_해제링크로풀면204이고_틀린코드는422와남은수·쓴링크는410이며_다시받기는202·넷째는429와Retry-After다', async () => {
    clock.advance(2 * 60 * 60_000);
    const ip = '198.51.100.160';
    for (let i = 0; i < 5; i++) await post('/v1/ops/auth/sessions', { email: 'ops.http@peaket.example', password: `x${i}`, humanCheckToken: 'ok' }, ip);
    await svc.app.get(DispatchAdminNotices).run();
    const mail = mailer.sent.filter((m) => m.to === 'ops.http@peaket.example' && m.link).at(-1)!;
    expect(mail.link).toMatch(/^https:\/\/console\.peaket\.example\/unlock#token=/);
    const unlockToken = new URL(mail.link!).hash.slice('#token='.length);
    const code = () => totpAt(seeds[OPS]!, Math.floor(clock.now() / 30_000));
    const bad = await post('/v1/ops/auth/unlocks', { unlockToken, code: code() === '000000' ? '111111' : '000000' }, ip);
    expect(bad.statusCode).toBe(422);
    expect(JSON.parse(bad.payload)).toMatchObject({ type: 'https://peaket.example/problems/unlock-code-invalid', remainingAttempts: 2 });
    clock.advance(30_000);
    const ok = await post('/v1/ops/auth/unlocks', { unlockToken, code: code() }, ip);
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['cache-control']).toBe('no-store');
    const again = await post('/v1/ops/auth/unlocks', { unlockToken, code: code() }, ip);
    expect(again.statusCode).toBe(410);
    expect(JSON.parse(again.payload)).toMatchObject({ type: 'https://peaket.example/problems/unlock-link-invalid' });
    for (let i = 0; i < 3; i++) expect((await post('/v1/ops/auth/unlock-links', { email: 'someone@peaket.example' }, ip)).statusCode).toBe(202);
    const limited = await post('/v1/ops/auth/unlock-links', { email: 'someone@peaket.example' }, ip);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.parse(limited.payload)).toMatchObject({ type: 'https://peaket.example/problems/unlock-link-resend-limit' });
    expect((await post('/v1/ops/auth/unlocks', { unlockToken: 'short', code: '123456' }, ip)).statusCode).toBe(400);
  });
});

describe('비밀번호 바꾸기 REST(openapi /password-changes, BOT-123)', () => {
  test('AC-T4_password_change세션은다른관리경로가403이고_비밀번호바꾸기는204와제한을푼새쿠키이며_다른세션은끝난다 [ASVS v5.0.0-6.3.1]', async () => {
    clock.advance(3 * 60 * 60_000);
    const store = svc.app.get<MemoryAdminAccountStore>(ADMIN_LOGIN_STORE);
    // 보통 세션 하나
    clock.advance(30_000);
    const a1 = JSON.parse((await post('/v1/ops/auth/sessions', { email: 'ops.http@peaket.example', password: PW, humanCheckToken: 'ok' }, '198.51.100.170')).payload) as { loginStep: string };
    const first = await post('/v1/ops/auth/sessions', { loginStep: a1.loginStep, code: totpAt(seeds[OPS]!, Math.floor(clock.now() / 30_000)) }, '198.51.100.170');
    expect(first.statusCode).toBe(200);
    const firstSession = store.sessions(OPS).at(-1)!.id;
    // 비밀번호 바꾸기 필요 세션
    store.setPasswordChangeRequired(OPS, true);
    clock.advance(30_000);
    const a2 = JSON.parse((await post('/v1/ops/auth/sessions', { email: 'ops.http@peaket.example', password: PW, humanCheckToken: 'ok' }, '198.51.100.171')).payload) as { loginStep: string };
    await post('/v1/ops/auth/sessions', { loginStep: a2.loginStep, code: totpAt(seeds[OPS]!, Math.floor(clock.now() / 30_000)) }, '198.51.100.171');
    const restricted = store.sessions(OPS).at(-1)!.id;
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.171', 'x-user-id': OPS, 'x-session-id': restricted, 'x-user-aud': 'ops', 'x-user-scope': 'password:change' };
    const bad = await svc.http.inject({ method: 'POST', url: '/v1/ops/auth/password-changes', headers, payload: JSON.stringify({ currentPassword: 'nope', newPassword: '바다건너온편지를천천히읽는저녁' }) });
    expect(bad.statusCode).toBe(422);
    expect(JSON.parse(bad.payload)).toMatchObject({ type: 'https://peaket.example/problems/current-password-invalid' });
    const weak = await svc.http.inject({ method: 'POST', url: '/v1/ops/auth/password-changes', headers, payload: JSON.stringify({ currentPassword: PW, newPassword: 'Peaket2026!!!!!!' }) });
    expect(weak.statusCode).toBe(422);
    // 제목은 하나이고(guidelines §2) 이유 문구는 detail에 싣는다
    expect(JSON.parse(weak.payload)).toMatchObject({ type: 'https://peaket.example/problems/password-rejected', title: '쓸 수 없는 비밀번호입니다', detail: expect.any(String), reason: 'CONTEXT', advice: expect.any(String) });
    const same = await svc.http.inject({ method: 'POST', url: '/v1/ops/auth/password-changes', headers, payload: JSON.stringify({ currentPassword: PW, newPassword: PW }) });
    expect(JSON.parse(same.payload)).toMatchObject({ type: 'https://peaket.example/problems/password-rejected', reason: 'SAME_AS_CURRENT', detail: '지금 비밀번호와 다른 비밀번호를 정해 주세요' });
    const ok = await svc.http.inject({ method: 'POST', url: '/v1/ops/auth/password-changes', headers, payload: JSON.stringify({ currentPassword: PW, newPassword: '바다건너온편지를천천히읽는저녁' }) });
    expect(ok.statusCode).toBe(204);
    expect(String(ok.headers['set-cookie'])).toMatch(/^__Host-peaket_ops_at=[^;]+; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Strict$/);
    expect(store.sessions(OPS).find((x) => x.id === firstSession)!.terminationReason).toBe('PASSWORD_CHANGED');
    // 로그인되지 않은 요청은 401
    expect((await svc.http.inject({ method: 'POST', url: '/v1/ops/auth/password-changes', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ currentPassword: PW, newPassword: '바다건너온편지를천천히읽는저녁' }) })).statusCode).toBe(401);
  });
});
