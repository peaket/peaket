// 관리 계정 초대 수락 경로(openapi /v1/{partner,ops}/auth/invitation-*, identity §6·§13, BUILD_ORDER F-09-6/BOT-152, BAT-046에서 미뤄 둔 서버 몫).
// 실제 서비스 뼈대를 띄워 계약 본문·상태 코드·Problem type·단계 차례·만료·되돌림·패스키 필수를 본다. 메모리 저장소만 쓰고 Docker·kind는 쓰지 않는다.
import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type AdminAuthz, createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { JoseAdminTokenSigner } from '../src/modules/admin/adapters/jose-admin-token-signer.js';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { LocalTotpSeedCipher } from '../src/modules/admin/adapters/local-totp-seed-cipher.js';
import type { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { MemoryAdminMailer } from '../src/modules/admin/adapters/memory-admin-mailer.js';
import { loadPolicyLists } from '../src/modules/admin/adapters/word-list-files.js';
import { DispatchAdminNotices } from '../src/modules/admin/application/dispatch-admin-notices.js';
import { ManageAdminAccounts } from '../src/modules/admin/application/manage-admin-accounts.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { ADMIN_LOGIN_STORE } from '../src/modules/admin/domain/ports.js';
import { base32Decode, totpAt } from '../src/modules/admin/domain/totp.js';
import { JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { SoftAuthenticator } from './soft-authenticator.js';
import { fanKey, ISSUER, recordingSignals, testAgency, testDeviceRefs } from './support.js';

const CMD = '0190f3a1-7c2e-7a00-8000-00000000e001';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const PARTNER_PA = '0190f3a1-7c2e-7a00-8000-0000000000e2';
const PW = '가을바람부는저녁의따뜻한차한잔';
const clock = fakeClock({ now: Date.parse('2026-11-27T01:00:00Z') });
const mailer = new MemoryAdminMailer();
const authz = new Map<string, AdminAuthz>();
let svc: Awaited<ReturnType<typeof createService>>;
let store: MemoryAdminAccountStore;
let manage: ManageAdminAccounts;
let dispatch: DispatchAdminNotices;
let seq = 0;

beforeAll(async () => {
  const fan = await fanKey();
  const admin = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk), PEAKET_ADMIN_TOKEN_KEY: JSON.stringify({ ...admin.privateJwk, kid: 'invitation-acc' }) });
  svc = await createService({
    name: 'identity-svc',
    module: AppModule.register({
      memory: true,
      session: { signer: new JoseTokenSigner(keys, ISSUER), keys, deviceRefs: testDeviceRefs(), signals: recordingSignals() },
      verification: { provider: testAgency(clock), hashers: HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5)) },
      admin: {
        config: DEFAULT_ADMIN_AUTH_CONFIG,
        lists: loadPolicyLists({}),
        pepper: new LocalPepper(new Map([[1, Buffer.alloc(32, 8)]]), 1),
        iterations: 1_000,
        breaches: { isBreached: async () => false },
        humanCheck: { verify: async () => 'OK' },
        signals: { failure: () => {}, alert: () => {} },
        totpCipher: new LocalTotpSeedCipher(Buffer.alloc(32, 6)),
        signer: new JoseAdminTokenSigner(keys, ISSUER),
        cookieDomain: 'peaket.example',
        mailer,
      },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    adminAuthz: { getAdminAuthz: async (q) => authz.get(q.sessionId) ?? { valid: false, role: '' } },
  });
  store = svc.app.get<MemoryAdminAccountStore>(ADMIN_LOGIN_STORE);
  manage = svc.app.get(ManageAdminAccounts);
  dispatch = svc.app.get(DispatchAdminNotices);
  store.create({ id: CMD, role: 'commander', email: 'cmd.inv@peaket.example', status: 'ACTIVE', now: clock.now() });
  store.create({ id: PARTNER_PA, role: 'partner_admin', email: 'lead.inv@stella.example', status: 'ACTIVE', promoterId: PROMOTER, now: clock.now() });
});

afterAll(async () => {
  await svc?.close();
});

const post = (url: string, payload: object) => svc.http.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.50' }, payload: JSON.stringify(payload) });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown> & { type?: string };
const problemOf = (r: { statusCode: number; payload: string }) => ({ status: r.statusCode, type: String(json(r).type ?? '').replace(/^.*\//, '') });
const base = (aud: 'partner' | 'ops') => `/v1/${aud}/auth`;

async function invite(role: 'partner_admin' | 'partner_member' | 'viewer' | 'operator' | 'cs_agent' | 'cs_lead', over: { email?: string; displayName?: string; promoterId?: string; actedBy?: string } = {}) {
  const n = ++seq;
  const email = over.email ?? `invite-${n}@stella.example`;
  const displayName = over.displayName ?? '담당자';
  const promoterId = role === 'partner_admin' || role === 'partner_member' ? (over.promoterId ?? PROMOTER) : undefined;
  const r = await manage.invite({ requestId: randomUUID(), actedBy: over.actedBy ?? CMD, email, role, displayName, ...(promoterId ? { promoterId } : {}) });
  if (r.result !== 'OK' || !r.account) throw new Error(`초대 실패: ${r.result}`);
  await dispatch.run();
  const mail = [...mailer.sent].reverse().find((m) => m.to === email && m.kind === 'INVITATION');
  if (!mail?.link) throw new Error('초대 메일 링크가 없다');
  const token = /^https:\/\/(?:partner|console)\.peaket\.example\/invitation#token=([A-Za-z0-9_-]{43})$/.exec(mail.link)?.[1];
  if (!token) throw new Error(`초대 링크 꼴이 다르다: ${mail.link}`);
  return { id: r.account.adminAccountId, email, displayName, role, token };
}

/** commander는 초대 API로 만들 수 없어(역할 변경 승인으로만 준다) INVITED 행과 토큰을 직접 둔다 */
async function inviteCommander(email: string) {
  const id = randomUUID();
  store.create({ id, role: 'commander', email, status: 'INVITED', displayName: '사령관', now: clock.now() });
  const token = randomBytes(32).toString('base64url');
  if (!(await store.setInviteToken(id, createHash('sha256').update(token).digest(), clock.now() + 24 * 60 * 60_000, clock.now()))) throw new Error('사령관 초대 토큰을 두지 못했다');
  return { id, email, token };
}

const start = (aud: 'partner' | 'ops', token: string) => post(`${base(aud)}/invitation-acceptances`, { invitationToken: token });
const stepOf = (r: { statusCode: number; payload: string }) => {
  expect(r.statusCode).toBe(201);
  const b = json(r);
  expect(b.acceptanceStep).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return b.acceptanceStep as string;
};
const setPassword = (aud: 'partner' | 'ops', step: string, password = PW) => post(`${base(aud)}/invitation-passwords`, { acceptanceStep: step, password });
const enroll = (aud: 'partner' | 'ops', step: string) => post(`${base(aud)}/invitation-totp-enrollments`, { acceptanceStep: step });
const confirm = (aud: 'partner' | 'ops', step: string, code: string) => post(`${base(aud)}/invitation-totp-confirmations`, { acceptanceStep: step, code });
const seedOf = (r: { statusCode: number; payload: string; headers: Record<string, unknown> }) => {
  expect(r.statusCode).toBe(201);
  expect(r.headers['cache-control']).toBe('no-store');
  const uri = String(json(r).otpauthUri);
  return base32Decode(new URL(uri).searchParams.get('secret')!);
};
const codeAt = (seed: Buffer, offset = 0) => totpAt(seed, Math.floor(clock.now() / 30_000) + offset);
const wrongCode = (seed: Buffer) => String((Number(codeAt(seed)) + 1) % 1_000_000).padStart(6, '0');
const registerPasskey = async (aud: 'partner' | 'ops', step: string) => {
  const begin = await post(`${base(aud)}/invitation-passkey-registrations`, { acceptanceStep: step });
  expect(begin.statusCode).toBe(201);
  expect(begin.headers['cache-control']).toBe('no-store');
  const b = json(begin) as { registrationId: string; publicKey: { challenge: string; rp: { id: string } } };
  expect(b.publicKey.rp.id).toBe(aud === 'partner' ? 'partner.peaket.example' : 'console.peaket.example');
  const authn = new SoftAuthenticator();
  const created = await post(`${base(aud)}/invitation-passkeys`, { acceptanceStep: step, registrationId: b.registrationId, credential: authn.register(b.publicKey), name: '시험 기기' });
  expect(created.statusCode).toBe(201);
  expect(created.headers['cache-control']).toBe('no-store');
  return { authn, created };
};
const complete = (aud: 'partner' | 'ops', step: string, over: Record<string, unknown> = {}) => post(`${base(aud)}/invitation-completions`, { acceptanceStep: step, recoveryCodesSaved: true, ...over });

/** partner_admin 초대를 비밀번호·TOTP·패스키까지 끝내고 완료한다 */
async function completePartnerAdmin(email?: string, displayName = '담당자') {
  const a = await invite('partner_admin', { email, displayName });
  const step = stepOf(await start('partner', a.token));
  expect((await setPassword('partner', step)).statusCode).toBe(200);
  const seed = seedOf(await enroll('partner', step));
  const confirmed = await confirm('partner', step, codeAt(seed));
  expect(confirmed.statusCode).toBe(200);
  expect(confirmed.headers['cache-control']).toBe('no-store');
  await registerPasskey('partner', step);
  expect((await complete('partner', step)).statusCode).toBe(204);
  return { ...a, step, seed };
}

describe('관리 계정 초대 수락(BOT-152, BAT-046 서버 몫)', () => {
  test('BOT-152 ① 초대 수락 시작은 역할·가린 이메일·필수 패스키·30분 단계 토큰을 주고 본문에 비밀·시드를 싣지 않는다', async () => {
    const pa = await invite('partner_admin', { email: 'start-pa@stella.example', displayName: '대표 담당' });
    const r = await start('partner', pa.token);
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const b = json(r);
    expect(b).toMatchObject({ expiresInSeconds: 1800, emailMasked: 'st***@stella.example', displayName: '대표 담당', role: 'partner_admin', passkeyRequired: true, next: 'PASSWORD' });
    expect(b.acceptanceStep).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const forbidden of ['invitationToken', 'password', 'secret', 'totpSeed', 'sha256']) expect(r.payload).not.toContain(forbidden);

    const member = await invite('partner_member', { email: 'start-member@stella.example' });
    expect(json(await start('partner', member.token))).toMatchObject({ role: 'partner_member', passkeyRequired: false });

    const op = await invite('operator', { email: 'start-op@peaket.example' });
    expect(json(await start('ops', op.token))).toMatchObject({ role: 'operator', passkeyRequired: true });

    const viewer = await invite('viewer', { email: 'start-viewer@peaket.example' });
    expect(json(await start('ops', viewer.token))).toMatchObject({ role: 'viewer', passkeyRequired: false });

    // commander는 초대 API로 만들 수 없어 INVITED 행을 직접 둔다. 관제 역할 표를 모두 본다(RV096-05)
    const commander = await inviteCommander('start-commander@peaket.example');
    expect(json(await start('ops', commander.token))).toMatchObject({ role: 'commander', passkeyRequired: true });
    const csAgent = await invite('cs_agent', { email: 'start-cs-agent@peaket.example' });
    expect(json(await start('ops', csAgent.token))).toMatchObject({ role: 'cs_agent', passkeyRequired: false });
    const csLead = await invite('cs_lead', { email: 'start-cs-lead@peaket.example' });
    expect(json(await start('ops', csLead.token))).toMatchObject({ role: 'cs_lead', passkeyRequired: false });
    // promoterName은 identity가 채우지 않는다(계약상 nullable, RV096-13)
    expect(b.promoterName ?? null).toBeNull();
  });

  test('BOT-152 ② 없는·지난·활성·다른 콘솔 초대 토큰은 모두 같은 410 invitation-invalid다', async () => {
    expect(problemOf(await start('partner', 'A'.repeat(43)))).toEqual({ status: 410, type: 'invitation-invalid' });
    expect(problemOf(await post(`${base('partner')}/invitation-acceptances`, { invitationToken: 'short' }))).toEqual({ status: 400, type: 'invalid-body' });

    const expired = await invite('partner_admin', { email: 'expired@stella.example' });
    // peek()는 복사본이라 저장소에 닿지 않는다. 행 자체를 고친다(RV096-01)
    store.rowForTest(expired.id)!.inviteExpiresAt = clock.now() - 1;
    expect(problemOf(await start('partner', expired.token))).toEqual({ status: 410, type: 'invitation-invalid' });

    const removed = await invite('partner_admin', { email: 'removed@stella.example' });
    store.remove(removed.id);
    expect(problemOf(await start('partner', removed.token))).toEqual({ status: 410, type: 'invitation-invalid' });

    const active = await invite('partner_admin', { email: 'active-token@stella.example' });
    store.rowForTest(active.id)!.status = 'ACTIVE';
    expect(problemOf(await start('partner', active.token))).toEqual({ status: 410, type: 'invitation-invalid' });

    const cross = await invite('partner_admin', { email: 'cross@stella.example' });
    expect(problemOf(await start('ops', cross.token))).toEqual({ status: 410, type: 'invitation-invalid' });

    // 재초대된 옛 토큰은 무효이고 새 토큰만 201이다(RV096-02)
    const reinvited = await invite('partner_admin', { email: 'reinvited@stella.example' });
    const oldToken = reinvited.token;
    expect((await manage.reinvite({ requestId: randomUUID(), actedBy: CMD, accountId: reinvited.id, reason: 'RESEND' })).result).toBe('OK');
    expect(await dispatch.run()).toMatchObject({ failed: 0 });
    const newMail = [...mailer.sent].reverse().find((m) => m.to === 'reinvited@stella.example' && m.kind === 'INVITATION');
    const newToken = /#token=([A-Za-z0-9_-]{43})$/.exec(newMail?.link ?? '')?.[1];
    expect(newToken).toBeTruthy();
    expect(problemOf(await start('partner', oldToken))).toEqual({ status: 410, type: 'invitation-invalid' });
    expect((await start('partner', newToken!)).statusCode).toBe(201);
  });

  test('BOT-152 ③ 단계 토큰은 30분·한 초대에 하나이고 다른 초대·지난·모르는 단계 토큰은 410 invitation-step-invalid다', async () => {
    const a = await invite('partner_admin', { email: 'step-a@stella.example' });
    const b = await invite('partner_admin', { email: 'step-b@stella.example' });
    const step = stepOf(await start('partner', a.token));
    const stepB = stepOf(await start('partner', b.token));
    expect(problemOf(await setPassword('partner', 'B'.repeat(43)))).toEqual({ status: 410, type: 'invitation-step-invalid' });
    expect(problemOf(await setPassword('partner', step, 'short'))).toEqual({ status: 400, type: 'invalid-body' });
    expect((await setPassword('partner', step)).statusCode).toBe(200);
    // 단계 토큰은 그 초대에만 묶인다: B는 아직 비밀번호 전이라 TOTP 등록이 409다
    expect(problemOf(await enroll('partner', stepB))).toEqual({ status: 409, type: 'invitation-step-out-of-order' });

    const c1 = await invite('partner_admin', { email: 'step-expire-1799@stella.example' });
    const c2 = await invite('partner_admin', { email: 'step-expire-1801@stella.example' });
    const stepC1 = stepOf(await start('partner', c1.token));
    const stepC2 = stepOf(await start('partner', c2.token));
    clock.advance(1_799_000);
    expect((await setPassword('partner', stepC1)).statusCode).toBe(200);
    clock.advance(2_000);
    expect(problemOf(await setPassword('partner', stepC2))).toEqual({ status: 410, type: 'invitation-step-invalid' });

    const d = await invite('partner_admin', { email: 'step-restart@stella.example' });
    const stepD1 = stepOf(await start('partner', d.token));
    const stepD2 = stepOf(await start('partner', d.token));
    expect(stepD2).not.toBe(stepD1);
    expect(problemOf(await setPassword('partner', stepD1))).toEqual({ status: 410, type: 'invitation-step-invalid' });
    expect((await setPassword('partner', stepD2)).statusCode).toBe(200);
  });

  test('BOT-152 ④ 비밀번호는 15자 미만 400, 흔한·맥락 비밀번호 422 password-rejected(까닭), 통과는 next TOTP다', async () => {
    const a = await invite('partner_admin', { email: 'pwcheck@stella.example' });
    const step = stepOf(await start('partner', a.token));
    expect(problemOf(await setPassword('partner', step, 'short-14-chars'))).toEqual({ status: 400, type: 'invalid-body' });
    const context = await setPassword('partner', step, 'pwcheck-비밀번호-123456');
    expect(context.statusCode).toBe(422);
    expect(problemOf(context)).toEqual({ status: 422, type: 'password-rejected' });
    expect(json(context).reason).toBeTruthy();
    const ok = await setPassword('partner', step);
    expect(ok.statusCode).toBe(200);
    expect(json(ok)).toEqual({ next: 'TOTP' });
    expect(ok.payload).not.toContain(PW);
  });

  test('BOT-152 ⑤ 인증 앱 코드는 5번까지 422 reauth-code-invalid(남은 수)이고 그 뒤 단계가 무효(410)이며 맞으면 복구 코드 10개를 한 번만 준다 [ASVS v5.0.0-6.3.1]', async () => {
    const a = await invite('partner_admin', { email: 'totp@stella.example' });
    let step = stepOf(await start('partner', a.token));
    expect((await setPassword('partner', step)).statusCode).toBe(200);
    const seed = seedOf(await enroll('partner', step));
    const wrong = wrongCode(seed);
    for (const remaining of [4, 3, 2, 1, 0]) {
      const r = await confirm('partner', step, wrong);
      expect(problemOf(r)).toEqual({ status: 422, type: 'reauth-code-invalid' });
      expect(json(r).remainingAttempts).toBe(remaining);
    }
    // 단계 실패는 계정 로그인 실패·잠금을 건드리지 않는다(RV096-07)
    const afterAttempts = store.peek(a.id)!;
    expect(afterAttempts.lockKind).toBe('NONE');
    expect(afterAttempts.secondFactorFailures).toBe(0);
    expect(problemOf(await confirm('partner', step, wrong))).toEqual({ status: 410, type: 'invitation-step-invalid' });

    // 다시 시작하면 새 단계에서 처음부터 한다
    step = stepOf(await start('partner', a.token));
    expect(store.peek(a.id)!.lockKind).toBe('NONE');
    expect(store.peek(a.id)!.secondFactorFailures).toBe(0);
    expect((await setPassword('partner', step)).statusCode).toBe(200);
    const seed2 = seedOf(await enroll('partner', step));
    const ok = await confirm('partner', step, codeAt(seed2));
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const b = json(ok) as { recoveryCodes: string[]; next: string };
    expect(b.recoveryCodes).toHaveLength(10);
    expect(new Set(b.recoveryCodes).size).toBe(10);
    expect(b.next).toBe('PASSKEY');
    for (const c of b.recoveryCodes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    // 확인 뒤 다시 등록을 시작하면 409이고 복구 코드는 다시 나가지 않는다
    expect(problemOf(await enroll('partner', step))).toEqual({ status: 409, type: 'invitation-step-out-of-order' });
    expect(ok.payload).not.toContain('seed');
  });

  test('BOT-152 ⑥ partner_admin은 패스키 없이 활성화되지 않고(409), 패스키 등록 뒤 완료는 204이며 계정·토큰·단계가 정리되고 세션은 만들지 않는다 [ASVS v5.0.0-6.3.3]', async () => {
    const a = await invite('partner_admin', { email: 'complete-pa@stella.example' });
    const step = stepOf(await start('partner', a.token));
    // 비밀번호 전·TOTP 확인 전에는 완료할 수 없다(RV096-03)
    expect(problemOf(await complete('partner', step))).toEqual({ status: 409, type: 'invitation-step-out-of-order' });
    expect(store.peek(a.id)!.status).toBe('INVITED');
    expect(store.sessions(a.id)).toHaveLength(0);
    expect(store.listRecoveryCodes(a.id)).toHaveLength(0);
    expect((await setPassword('partner', step)).statusCode).toBe(200);
    expect(problemOf(await complete('partner', step))).toEqual({ status: 409, type: 'invitation-step-out-of-order' });
    const seed = seedOf(await enroll('partner', step));
    expect(problemOf(await complete('partner', step))).toEqual({ status: 409, type: 'invitation-step-out-of-order' });
    expect(problemOf(await post(`${base('partner')}/invitation-passkey-registrations`, { acceptanceStep: step }))).toEqual({ status: 409, type: 'invitation-step-out-of-order' });
    expect(store.peek(a.id)!.status).toBe('INVITED');
    const confirmed = await confirm('partner', step, codeAt(seed));
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.headers['cache-control']).toBe('no-store');
    expect(problemOf(await complete('partner', step))).toEqual({ status: 409, type: 'passkey-not-registered' });
    await registerPasskey('partner', step);
    expect(problemOf(await complete('partner', step, { recoveryCodesSaved: false }))).toEqual({ status: 400, type: 'invalid-body' });
    const done = await complete('partner', step);
    expect(done.statusCode).toBe(204);
    const row = store.peek(a.id) as unknown as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'ACTIVE', inviteTokenHash: null, inviteExpiresAt: null, totpPendingEnc: null });
    expect(row).toHaveProperty('inviteStepHash');
    expect(row.inviteStepHash).toBeNull();
    expect(store.sessions(a.id)).toHaveLength(0);
    expect(store.listPasskeys(a.id)).toHaveLength(1);
    expect(store.listRecoveryCodes(a.id)).toHaveLength(10);
    expect(problemOf(await complete('partner', step))).toEqual({ status: 410, type: 'invitation-step-invalid' });
    expect(problemOf(await start('partner', a.token))).toEqual({ status: 410, type: 'invitation-invalid' });
  });

  test('BOT-152 ⑦ partner_member·viewer는 next가 PASSKEY여도 패스키를 건너뛰고 완료할 수 있다', async () => {
    for (const [aud, role, email] of [
      ['partner', 'partner_member', 'skip-member@stella.example'],
      ['ops', 'viewer', 'skip-viewer@peaket.example'],
    ] as const) {
      const a = await invite(role, { email });
      const step = stepOf(await start(aud, a.token));
      expect((await setPassword(aud, step)).statusCode).toBe(200);
      const seed = seedOf(await enroll(aud, step));
      const confirmed = await confirm(aud, step, codeAt(seed));
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.headers['cache-control']).toBe('no-store');
      // 패스키가 필수가 아니어도 화면이 건너뛰기를 보이도록 PASSKEY로 알린다(openapi AdminInvitationTotpConfirmed)
      expect(json(confirmed).next).toBe('PASSKEY');
      expect((await complete(aud, step)).statusCode).toBe(204);
      expect(store.peek(a.id)!.status).toBe('ACTIVE');
    }
  });

  test('BOT-152 ⑧ 초대 링크로 다시 시작하면 앞서 넣은 비밀번호·대기 시드·복구 코드·패스키를 지우고 처음(비밀번호)부터 한다', async () => {
    const a = await invite('partner_admin', { email: 'restart@stella.example' });
    const step1 = stepOf(await start('partner', a.token));
    expect((await setPassword('partner', step1)).statusCode).toBe(200);
    const seed = seedOf(await enroll('partner', step1));
    const confirmed = await confirm('partner', step1, codeAt(seed));
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.headers['cache-control']).toBe('no-store');
    await registerPasskey('partner', step1);
    expect(store.listPasskeys(a.id)).toHaveLength(1);
    expect(store.listRecoveryCodes(a.id)).toHaveLength(10);

    const step2 = stepOf(await start('partner', a.token));
    expect(step2).not.toBe(step1);
    const row = store.peek(a.id)!;
    expect(row.passwordPhc).toBeNull();
    expect(row.totpPendingEnc).toBeNull();
    expect(row.totpSeedEnc).toBeNull();
    expect(store.listRecoveryCodes(a.id)).toHaveLength(0);
    expect(store.listPasskeys(a.id)).toHaveLength(0);
    expect(problemOf(await setPassword('partner', step1))).toEqual({ status: 410, type: 'invitation-step-invalid' });
    expect(problemOf(await enroll('partner', step2))).toEqual({ status: 409, type: 'invitation-step-out-of-order' });
    expect((await setPassword('partner', step2)).statusCode).toBe(200);
  });

  test('BOT-152 ⑨ 관제 경로는 관제 역할만, 파트너 경로는 파트너 역할만 받고 서로의 초대 토큰은 410이다', async () => {
    const pa = await invite('partner_admin', { email: 'console-pa@stella.example' });
    const op = await invite('operator', { email: 'console-op@peaket.example' });
    expect((await start('partner', pa.token)).statusCode).toBe(201);
    expect((await start('ops', op.token)).statusCode).toBe(201);
    expect(problemOf(await start('ops', pa.token))).toEqual({ status: 410, type: 'invitation-invalid' });
    expect(problemOf(await start('partner', op.token))).toEqual({ status: 410, type: 'invitation-invalid' });

    const opStep = stepOf(await start('ops', op.token));
    expect((await setPassword('ops', opStep)).statusCode).toBe(200);
    expect(problemOf(await enroll('partner', opStep))).toEqual({ status: 410, type: 'invitation-step-invalid' });
    // 관제 패스키 등록·마침·완료도 실제로 지나간다(콘솔 RP ID는 registerPasskey가 본다, RV096-05)
    const opSeed = seedOf(await enroll('ops', opStep));
    const opConfirmed = await confirm('ops', opStep, codeAt(opSeed));
    expect(opConfirmed.statusCode).toBe(200);
    await registerPasskey('ops', opStep);
    expect((await complete('ops', opStep)).statusCode).toBe(204);
    expect(store.rowForTest(op.id)!.status).toBe('ACTIVE');
  });

  test('BOT-152 ⑩ 완료한 계정은 새 비밀번호·TOTP로 로그인되고 옛 초대 토큰·단계 토큰은 410이며 응답에 비밀·시드·해시가 없다', async () => {
    const a = await completePartnerAdmin('login-after@stella.example');
    expect(store.peek(a.id)!.status).toBe('ACTIVE');
    expect(problemOf(await start('partner', a.token))).toEqual({ status: 410, type: 'invitation-invalid' });
    expect(problemOf(await setPassword('partner', a.step))).toEqual({ status: 410, type: 'invitation-step-invalid' });

    const first = await post('/v1/partner/auth/sessions', { email: a.email, password: PW, deviceId: 'dev-inv' });
    expect(first.statusCode).toBe(200);
    const loginStep = String(json(first).loginStep);
    clock.advance(30_000);
    const second = await post('/v1/partner/auth/sessions', { loginStep, code: codeAt(a.seed) });
    expect(second.statusCode).toBe(204);
    expect(String(second.headers['set-cookie'])).toContain('__Secure-peaket_partner_at');
    expect(store.sessions(a.id)).toHaveLength(1);
    for (const forbidden of [PW, a.seed.toString('base64url'), 'sha256']) expect(second.payload).not.toContain(forbidden);
  });
});
