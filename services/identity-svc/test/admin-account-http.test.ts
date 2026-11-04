// 관리 계정 관리의 받는 층(docs/features/identity.md §6 '관리 계정 관리 gRPC의 첫 구현', BUILD_ORDER BOT-150):
// gRPC AdminAccountService를 실제 서버·클라이언트로 왕복하고(필드·열거 이름을 직렬화가 본다), 파트너 팀 계정 REST(openapi GET /v1/partner/team-accounts)를 본다.
import 'reflect-metadata';
import * as grpc from '@grpc/grpc-js';
import { type AdminAuthz, createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { startGrpcServer } from '../src/grpc-server.js';
import { JoseAdminTokenSigner } from '../src/modules/admin/adapters/jose-admin-token-signer.js';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { LocalTotpSeedCipher } from '../src/modules/admin/adapters/local-totp-seed-cipher.js';
import type { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { MemoryAdminMailer } from '../src/modules/admin/adapters/memory-admin-mailer.js';
import { loadPolicyLists } from '../src/modules/admin/adapters/word-list-files.js';
import { ManageAdminAccounts } from '../src/modules/admin/application/manage-admin-accounts.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { ADMIN_LOGIN_STORE } from '../src/modules/admin/domain/ports.js';
import { adminAccountHandlers } from '../src/modules/admin/inbound/admin-account.grpc.js';
import { identityPackage } from '../src/modules/session/inbound/session.grpc.js';
import { JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { fanKey, ISSUER, recordingSignals, testAgency, testDeviceRefs } from './support.js';

const CMD = '0190f3a1-7c2e-7a00-8000-00000000e101';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const OTHER = '0190f3a1-7c2e-7a00-8000-0000000000e2';
const clock = fakeClock({ now: Date.parse('2026-11-05T14:00:00Z') });
const authz = new Map<string, AdminAuthz>();
let svc: Awaited<ReturnType<typeof createService>>;
let store: MemoryAdminAccountStore;
let server: Awaited<ReturnType<typeof startGrpcServer>>;
// biome-ignore lint: 시험용 동적 클라이언트
let client: any;

beforeAll(async () => {
  const fan = await fanKey();
  const admin = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk), PEAKET_ADMIN_TOKEN_KEY: JSON.stringify({ ...admin.privateJwk, kid: 'admin-acc' }) });
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
        mailer: new MemoryAdminMailer(),
      },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    // 가드의 관리 역할 판정 대역: 세션 ID별 답(파트너사는 tenantId)
    adminAuthz: { getAdminAuthz: async (q) => authz.get(q.sessionId) ?? { valid: false, role: '' } },
  });
  store = svc.app.get<MemoryAdminAccountStore>(ADMIN_LOGIN_STORE);
  store.create({ id: CMD, role: 'commander', email: 'cmd.http@peaket.example', status: 'ACTIVE', now: clock.now() });
  server = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: identityPackage().AdminAccountService.service, handlers: adminAccountHandlers({ manage: svc.app.get(ManageAdminAccounts) }, () => {}) }] });
  client = new (identityPackage().AdminAccountService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure());
});

afterAll(async () => {
  client?.close();
  await server?.close();
  await svc?.close();
});

const call = (method: string, req: object) =>
  new Promise<{ err: grpc.ServiceError | null; res: Record<string, unknown> }>((resolve) => client[method](req, (err: grpc.ServiceError | null, res: Record<string, unknown>) => resolve({ err, res })));

describe('gRPC AdminAccountService(BOT-150)', () => {
  test('초대·목록·상세·역할변경·삭제가실제직렬화로왕복하고_입력꼴오류는INVALID_ARGUMENT·없는계정은NOT_FOUND·지정은UNIMPLEMENTED다', async () => {
    const inv = await call('InviteAdminAccount', { request_id: 'g-1', acted_by: CMD, email: 'lead.g@stella.example', role: 'ADMIN_ROLE_PARTNER_ADMIN', display_name: '파트너 담당', promoter_id: PROMOTER });
    expect(inv.err).toBeNull();
    expect(inv.res).toMatchObject({ result: 'ADMIN_ACCOUNT_RESULT_OK', already_done: false, account: { role: 'ADMIN_ROLE_PARTNER_ADMIN', status: 'ADMIN_ACCOUNT_STATUS_INVITED', group: 'ADMIN_ACCOUNT_GROUP_PARTNER', email_masked: 'le***@stella.example', promoter_id: PROMOTER, version: 1, lock_kind: 'ADMIN_LOCK_KIND_NONE' } });
    const id = (inv.res.account as { admin_account_id: string }).admin_account_id;
    const again = await call('InviteAdminAccount', { request_id: 'g-1', acted_by: CMD, email: 'lead.g@stella.example', role: 'ADMIN_ROLE_PARTNER_ADMIN', display_name: '파트너 담당', promoter_id: PROMOTER });
    expect(again.res).toMatchObject({ result: 'ADMIN_ACCOUNT_RESULT_OK', already_done: true });
    const member = await call('InviteAdminAccount', { request_id: 'g-2', acted_by: CMD, email: 'm.g@other.example', role: 'ADMIN_ROLE_PARTNER_MEMBER', display_name: '실무', promoter_id: OTHER });
    expect(member.res).toMatchObject({ result: 'ADMIN_ACCOUNT_RESULT_FIRST_PARTNER_ACCOUNT_MUST_BE_ADMIN' });
    expect(member.res.account).toBeFalsy();
    const list = await call('ListAdminAccounts', { group: 'ADMIN_ACCOUNT_GROUP_PARTNER', promoter_id: PROMOTER, page_size: 10 });
    expect(list.err).toBeNull();
    expect((list.res.accounts as { admin_account_id: string }[]).map((a) => a.admin_account_id)).toEqual([id]);
    expect(list.res.next_page_token).toBe('');
    const got = await call('GetAdminAccount', { admin_account_id: id });
    expect(got.res).toMatchObject({ account: { admin_account_id: id, invite_expires_at_ms: 0 }, sessions: [] });
    expect((await call('GetAdminAccount', { admin_account_id: '0190f3a1-7c2e-7a00-8000-00000000e1ff' })).err?.code).toBe(grpc.status.NOT_FOUND);
    expect((await call('ListAdminAccounts', {})).err?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect((await call('InviteAdminAccount', { request_id: 'g-3', acted_by: CMD, email: 'x', role: 'ADMIN_ROLE_VIEWER', display_name: '이름' })).err?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect((await call('ChangeAdminRole', { request_id: 'g-4', acted_by: CMD, admin_account_id: id, role: 'ADMIN_ROLE_VIEWER', expected_version: 1 })).res).toMatchObject({ result: 'ADMIN_ACCOUNT_RESULT_ROLE_GROUP_MISMATCH' });
    // 판 비교와 OK 경로도 직렬화를 거친다
    const ops = await call('InviteAdminAccount', { request_id: 'g-8', acted_by: CMD, email: 'cs.g@peaket.example', role: 'ADMIN_ROLE_CS_AGENT', display_name: 'CS' });
    const opsId = (ops.res.account as { admin_account_id: string }).admin_account_id;
    expect((await call('ChangeAdminRole', { request_id: 'g-9', acted_by: CMD, admin_account_id: opsId, role: 'ADMIN_ROLE_CS_LEAD', expected_version: 9 })).res).toMatchObject({ result: 'ADMIN_ACCOUNT_RESULT_VERSION_MISMATCH' });
    expect((await call('ChangeAdminRole', { request_id: 'g-10', acted_by: CMD, admin_account_id: opsId, role: 'ADMIN_ROLE_CS_LEAD', expected_version: 1 })).res).toMatchObject({ result: 'ADMIN_ACCOUNT_RESULT_OK', account: { role: 'ADMIN_ROLE_CS_LEAD', version: 2 } });
    expect((await call('RemoveAdminAccount', { request_id: 'g-11', acted_by: CMD, admin_account_id: '0190f3a1-7c2e-7a00-8000-00000000e1fe' })).err?.code).toBe(grpc.status.NOT_FOUND);
    expect((await call('ReinviteAdminAccount', { request_id: 'g-5', acted_by: CMD, admin_account_id: id, reason: 'REINVITE_REASON_RESEND' })).res).toMatchObject({ result: 'ADMIN_ACCOUNT_RESULT_OK', account: { version: 2 } });
    // 초대 중인 관리자는 활성이 아니라 마지막 관리자 판정에 들지 않는다: 지울 수 있다
    expect((await call('RemoveAdminAccount', { request_id: 'g-6', acted_by: CMD, admin_account_id: id })).res).toMatchObject({ result: 'ADMIN_ACCOUNT_RESULT_OK', account: { status: 'ADMIN_ACCOUNT_STATUS_REMOVED', email_masked: '', display_name: '' } });
    expect((await call('SetAdminDesignation', { request_id: 'g-7', acted_by: CMD, admin_account_id: CMD, kind: 'DESIGNATION_KIND_ACCESS_REVIEWER', basis: '지정서 1' })).err?.code).toBe(grpc.status.UNIMPLEMENTED);
  });
});

describe('파트너 팀 계정 REST(GET /v1/partner/team-accounts)', () => {
  test('partner_admin은자기파트너사의지우지않은계정만가린이메일로받고계정ID는없으며캐시하지않고_partner_member는403·틀린커서는400이다', async () => {
    const pa = '0190f3a1-7c2e-7a00-8000-00000000e110';
    const pm = '0190f3a1-7c2e-7a00-8000-00000000e111';
    store.create({ id: pa, role: 'partner_admin', email: 'boss@stella.example', status: 'ACTIVE', promoterId: PROMOTER, displayName: '대표 담당', now: clock.now() });
    store.create({ id: pm, role: 'partner_member', email: 'staff@stella.example', status: 'ACTIVE', promoterId: PROMOTER, displayName: '실무 담당', now: clock.now() });
    store.create({ id: '0190f3a1-7c2e-7a00-8000-00000000e112', role: 'partner_admin', email: 'x@other.example', status: 'ACTIVE', promoterId: OTHER, now: clock.now() });
    await store.recordLoginSuccess(pm, clock.now());
    await store.updateLoginState(pa, clock.now(), (cur) => ({ next: { ...cur, lockKind: 'PROTECT' }, notices: [] }));
    authz.set('s-pa', { valid: true, role: 'partner_admin', tenantId: PROMOTER });
    authz.set('s-pm', { valid: true, role: 'partner_member', tenantId: PROMOTER });
    const get = (sid: string, account: string, q = '') => svc.http.inject({ method: 'GET', url: `/v1/partner/team-accounts${q}`, headers: { 'x-user-id': account, 'x-session-id': sid, 'x-user-aud': 'partner' } });
    const r = await get('s-pa', pa);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.payload) as { items: Record<string, unknown>[]; nextCursor: string | null };
    expect(body).toEqual({
      items: [
        { displayName: '실무 담당', emailMasked: 'st***@stella.example', role: 'partner_member', status: 'ACTIVE', locked: false, lastLoginAt: new Date(clock.now()).toISOString() },
        { displayName: '대표 담당', emailMasked: 'bo***@stella.example', role: 'partner_admin', status: 'ACTIVE', locked: true },
      ],
      nextCursor: null,
    });
    expect(r.payload).not.toContain(pa);
    const one = JSON.parse((await get('s-pa', pa, '?limit=1')).payload) as { items: unknown[]; nextCursor: string };
    expect(one.items).toHaveLength(1);
    // 커서는 불투명하고 계정 ID를 싣지 않는다(openapi '계정 ID는 싣지 않는다')
    expect(Buffer.from(one.nextCursor, 'base64url').toString('utf8')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    const two = JSON.parse((await get('s-pa', pa, `?limit=1&cursor=${encodeURIComponent(one.nextCursor)}`)).payload) as { items: { displayName: string }[]; nextCursor: string | null };
    expect(two.items.map((x) => x.displayName)).toEqual(['대표 담당']);
    expect(two.nextCursor).toBeNull();
    expect((await get('s-pm', pm)).statusCode).toBe(403);
    expect((await get('s-pa', pa, '?cursor=bad')).statusCode).toBe(400);
  });
});
