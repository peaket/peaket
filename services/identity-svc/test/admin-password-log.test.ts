// 관리 계정 비밀번호의 유출 목록 대조가 남기는 로그(docs/security/auth-controls.md §6 AC-T7 ④ '로그·트레이스에 SHA-1과 그 앞 5자가 0건',
// §4.3 10, docs/security/asvs/delivery.md 16.2.5, BUILD_ORDER OPS-020 '요청 로그 줄에도 0건인지 본다', BAT-215).
// 서비스 전체(createService + AppModule)를 띄우고 유출 목록 조회는 진짜 어댑터(HibpBreachList)로 흉내 HIBP 서버에 보낸다. 서비스가 쓴 글 전부
// (정규 로그 줄·서비스 로거·NestJS 자체 기록, trace 수준까지)를 모아 비밀번호 셋의 SHA-1(40자, 대·소문자)과 앞 5자가 한 번도 없는지 본다.
// 추적(span)의 0건은 test/outbound-trace.test.ts가 본다.
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Writable } from 'node:stream';
import { type AdminAuthzPort, createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { HibpBreachList } from '../src/modules/admin/adapters/hibp-breach-list.js';
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

const OPS = '0190f3a1-7c2e-7a00-8000-0000000002b7';
const EMAIL = 'ops.leak-log@peaket.example';
/** 지금 비밀번호(유출 목록에 있다: 로그인 때 다시 보면 걸린다) */
const PW_OLD = '창가에앉은고양이가졸던오후세시';
/** 바꾸려다 거절되는 새 비밀번호(유출 목록에 있다) */
const PW_BREACHED = '겨울바다위를낮게나는갈매기의노래';
/** 받아들여지는 새 비밀번호(유출 목록에 없다) */
const PW_NEW = '바다건너온편지를천천히읽는저녁';
const sha1 = (pw: string) => createHash('sha1').update(pw.normalize('NFC'), 'utf8').digest('hex').toUpperCase();
const LISTED = new Map([PW_OLD, PW_BREACHED].map((pw) => [sha1(pw), 31]));

const clock = fakeClock({ now: Date.parse('2026-12-01T01:00:00Z') });
const pepper = new LocalPepper(new Map([[1, Buffer.alloc(32, 8)]]), 1);
const raw: string[] = [];
const asked: string[] = [];
// real-time: 진짜 유출 목록 어댑터(플랫폼 바깥 호출 클라이언트, 전역 fetch)가 실제로 보내는 요청을 받는 흉내 HIBP 서버(빈 포트 0, 127.0.0.1) BAT-215
const hibp = createServer((req, res) => {
  const prefix = (req.url ?? '').replace(/^\/range\//, '');
  asked.push(prefix);
  const lines = [...LISTED].filter(([h]) => h.startsWith(prefix)).map(([h, n]) => `${h.slice(5)}:${n}`);
  // 채움 줄(횟수 0)
  lines.push('0000000000000000000000000000000000A:0', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0');
  res.setHeader('content-type', 'text/plain');
  res.end(lines.join('\r\n'));
});
let svc: Awaited<ReturnType<typeof createService>>;
let seed: Buffer;
const authzHolder: { port?: AdminAuthzPort } = {};

beforeAll(async () => {
  await new Promise<void>((r) => hibp.listen(0, '127.0.0.1', r));
  const hibpUrl = `http://127.0.0.1:${(hibp.address() as { port: number }).port}`;
  const fan = await fanKey();
  const admin = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk), PEAKET_ADMIN_TOKEN_KEY: JSON.stringify({ ...admin.privateJwk, kid: 'admin-leak-log' }) });
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
        breaches: new HibpBreachList({ baseUrl: hibpUrl, timeoutMs: 2_000 }),
        humanCheck: { verify: async (t) => (t === 'ok' ? 'OK' : 'FAILED') },
        signals: { failure: () => {}, alert: () => {} },
        totpCipher: new LocalTotpSeedCipher(Buffer.alloc(32, 6)),
        signer: new JoseAdminTokenSigner(keys, ISSUER),
        cookieDomain: 'peaket.example',
        mailer: new MemoryAdminMailer(),
      },
    }),
    // 정상 줄도 모두 남기고(표본 1) 서비스 로거는 trace 수준까지 낸다: 남는 글이 가장 많은 설정에서 본다
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1', PEAKET_LOG_LEVEL: 'trace' },
    clock,
    logDestination: new Writable({
      write(chunk, _enc, cb) {
        raw.push(String(chunk));
        cb();
      },
    }),
    adminAuthz: { getAdminAuthz: (q, o) => authzHolder.port!.getAdminAuthz(q, o) },
  });
  authzHolder.port = svc.app.get(GetAdminAuthz);
  const store = svc.app.get<MemoryAdminAccountStore>(ADMIN_LOGIN_STORE);
  store.create({ id: OPS, role: 'operator', email: EMAIL, status: 'ACTIVE', now: clock.now() });
  // 마지막 유출 대조가 31일 전이라 로그인 때 다시 본다(password.breach_recheck_interval 30일)
  await store.setPassword({ id: OPS, phc: await new Pbkdf2AdminPasswords(pepper, { iterations: 1_000 }).hash(OPS, PW_OLD), breachCheckedAt: clock.now() - 31 * 24 * 60 * 60_000, now: clock.now() });
  const { otpauthUri } = await svc.app.get(BeginTotpEnrollment).run({ accountId: OPS });
  seed = base32Decode(new URL(otpauthUri).searchParams.get('secret')!);
  await svc.app.get(ConfirmTotpEnrollment).run({ accountId: OPS, code: totpAt(seed, Math.floor(clock.now() / 30_000)) });
  clock.advance(30_000);
}, 60_000);

afterAll(async () => {
  await svc?.close();
  hibp.closeAllConnections();
  await new Promise<void>((r) => hibp.close(() => r()));
});

const post = (path: string, body: object, headers: Record<string, string> = {}) =>
  svc.http.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.77', ...headers }, payload: JSON.stringify(body) });

test('AC-T7 ④ [ASVS v5.0.0-16.2.5] 로그인 때 다시 본 유출 대조·걸린 새 비밀번호 거절·바꾸기 성공의 로그 글 전체(정규 로그 줄·서비스 로거, trace 수준)에 세 비밀번호의 SHA-1과 그 앞 5자가 한 번도 없다', async () => {
  const store = svc.app.get<MemoryAdminAccountStore>(ADMIN_LOGIN_STORE);
  const step = await post('/v1/ops/auth/sessions', { email: EMAIL, password: PW_OLD, humanCheckToken: 'ok' });
  expect(step.statusCode).toBe(200);
  const { loginStep } = JSON.parse(step.payload) as { loginStep: string };
  const second = await post('/v1/ops/auth/sessions', { loginStep, code: totpAt(seed, Math.floor(clock.now() / 30_000)) });
  expect(second.statusCode).toBe(200);
  // 로그인 때 다시 본 결과 목록에 있어 비밀번호 바꾸기가 필요하다(§3.5)
  expect(store.peek(OPS)!.passwordChangeRequired).toBe(true);
  const session = store.sessions(OPS).at(-1)!.id;
  const headers = { 'x-user-id': OPS, 'x-session-id': session, 'x-user-aud': 'ops', 'x-user-scope': 'password:change' };
  const rejected = await post('/v1/ops/auth/password-changes', { currentPassword: PW_OLD, newPassword: PW_BREACHED }, headers);
  expect(rejected.statusCode).toBe(422);
  expect(JSON.parse(rejected.payload)).toMatchObject({ type: 'https://peaket.example/problems/password-rejected', reason: 'BREACHED' });
  const ok = await post('/v1/ops/auth/password-changes', { currentPassword: PW_OLD, newPassword: PW_NEW }, headers);
  expect(ok.statusCode).toBe(204);
  expect(store.peek(OPS)!.passwordChangeRequired).toBe(false);

  // 유출 목록에는 세 비밀번호의 앞 5자로 실제로 물었다(빈 결과가 통과로 새지 않게)
  expect([...asked].sort()).toEqual([PW_OLD, PW_BREACHED, PW_NEW].map((pw) => sha1(pw).slice(0, 5)).sort());
  // 로그 글이 실제로 쌓였다: 세 요청 줄과 그 밖의 줄
  const text = raw.join('');
  const requestLines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { msg?: string; route?: string });
  expect(requestLines.filter((l) => l.msg === 'request' && l.route === '/v1/ops/auth/password-changes')).toHaveLength(2);
  expect(requestLines.filter((l) => l.msg === 'request' && l.route === '/v1/ops/auth/sessions')).toHaveLength(2);

  for (const pw of [PW_OLD, PW_BREACHED, PW_NEW]) {
    const h = sha1(pw);
    const prefix = h.slice(0, 5);
    expect(text, `${pw} SHA-1`).not.toContain(h);
    expect(text, `${pw} SHA-1 소문자`).not.toContain(h.toLowerCase());
    // 앞 5자: HIBP 꼴(대문자)은 어디에도 없다. 소문자·대문자 모두 홀로 선 조각(앞뒤가 16진 글자가 아닌 것)으로도 없다.
    // 홀로 선 조각으로 보는 까닭: 무작위 traceId(소문자 16진 32자) 안에 같은 5자가 우연히 들 수 있다
    expect(text, `${pw} 앞 5자`).not.toContain(prefix);
    expect(text, `${pw} 앞 5자(홀로 선 조각)`).not.toMatch(new RegExp(`(?<![0-9a-f])${prefix}(?![0-9a-f])`, 'i'));
    expect(text, `${pw} 원문`).not.toContain(pw);
  }
}, 60_000);
