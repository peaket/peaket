// RV-02: identity 관리 계정 gRPC 오류를 Problem으로 바꾼다(ops-svc 관리 계정 REST, AZ-T14·I-T61, ASVS 8.2.2).
// 받는 쪽은 계약 설명자(@peaket/contracts/proto)로 만든 시험 gRPC 서버다(Docker 없음).
// NOT_FOUND는 404(세션은 session-not-found), INVALID_ARGUMENT는 400 invalid-query, UNAVAILABLE·DEADLINE_EXCEEDED는
// 503 admin-account-unavailable(Retry-After)이다. 어떤 길도 500으로 새지 않는다.
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AdminAccountProblem, GrpcIdentityAdminAccounts } from '../src/modules/admin-accounts/index.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { reauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const MISSING = '0194b045-0000-7000-8000-000000001001';
const BAD = '0194b045-0000-7000-8000-000000001002';
const DOWN = '0194b045-0000-7000-8000-000000001003';
const ACCOUNT = '0194b045-0000-7000-8000-000000001004';
const SESSION = '0194b045-0000-7000-8000-000000001011';
const GONE_SESSION = '0194b045-0000-7000-8000-000000001012';
const NOW = Date.parse('2026-11-20T10:00:00.000Z');

let server: grpc.Server;
let address = '';
let adapter: GrpcIdentityAdminAccounts;
const clock = fakeClock({ now: NOW });
const kit = reauthKit(() => clock.now());
const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>>;

const fail = (code: grpc.status, details: string): grpc.ServiceError => Object.assign(new Error(details), { code, details, metadata: new grpc.Metadata() }) as grpc.ServiceError;
const account = (id: string) => ({ admin_account_id: id, email_masked: 'ad***@peaket.example', display_name: '담당자', group: 'ADMIN_ACCOUNT_GROUP_OPS', role: 'ADMIN_ROLE_COMMANDER', status: 'ADMIN_ACCOUNT_STATUS_ACTIVE', lock_kind: 'ADMIN_LOCK_KIND_NONE', totp_enrolled: true, passkey_count: 1, designations: [], version: 1 });

beforeAll(async () => {
  const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, grpc.ServiceClientConstructor> } } }).peaket.identity.v1;
  server = new grpc.Server();
  server.addService(pkg.AdminAccountService!.service, {
    GetAdminAccount: (call: { request: Record<string, unknown> }, cb: (e: grpc.ServiceError | null, v?: unknown) => void) => {
      const id = String(call.request.admin_account_id);
      if (id === MISSING) return cb(fail(grpc.status.NOT_FOUND, '없는 계정'));
      if (id === BAD) return cb(fail(grpc.status.INVALID_ARGUMENT, '꼴이 틀렸다'));
      if (id === DOWN) return cb(fail(grpc.status.UNAVAILABLE, 'identity가 닿지 않는다'));
      cb(null, { account: account(id), sessions: [] });
    },
    ListAdminAccounts: (_call: unknown, cb: (e: null, v?: unknown) => void) => cb(null, { accounts: [], next_page_token: '' }),
    InviteAdminAccount: (_call: unknown, cb: (e: null, v?: unknown) => void) => cb(null, { result: 'ADMIN_ACCOUNT_RESULT_OK' }),
    ChangeAdminRole: (_call: unknown, cb: (e: null, v?: unknown) => void) => cb(null, { result: 'ADMIN_ACCOUNT_RESULT_OK' }),
    ReinviteAdminAccount: (_call: unknown, cb: (e: null, v?: unknown) => void) => cb(null, { result: 'ADMIN_ACCOUNT_RESULT_OK' }),
    RemoveAdminAccount: (_call: unknown, cb: (e: null, v?: unknown) => void) => cb(null, { result: 'ADMIN_ACCOUNT_RESULT_OK' }),
    SetAdminDesignation: (call: { request: Record<string, unknown> }, cb: (e: grpc.ServiceError | null, v?: unknown) => void) => {
      const id = String(call.request.admin_account_id);
      if (id === MISSING) return cb(fail(grpc.status.NOT_FOUND, '없는 계정'));
      if (id === BAD) return cb(fail(grpc.status.INVALID_ARGUMENT, '꼴이 틀렸다'));
      if (id === DOWN) return cb(fail(grpc.status.UNAVAILABLE, 'identity가 닿지 않는다'));
      cb(null, { result: 'ADMIN_ACCOUNT_RESULT_OK' });
    },
    RevokeAdminDesignation: (call: { request: Record<string, unknown> }, cb: (e: grpc.ServiceError | null, v?: unknown) => void) => {
      const id = String(call.request.admin_account_id);
      if (id === MISSING) return cb(fail(grpc.status.NOT_FOUND, '없는 계정'));
      cb(null, { result: 'ADMIN_ACCOUNT_RESULT_OK' });
    },
  });
  server.addService(pkg.AdminDesignationService!.service, {
    GetAdminDesignations: (_call: unknown, cb: (e: null, v?: unknown) => void) => cb(null, { kinds: [] }),
  });
  server.addService(pkg.AdminSessionService!.service, {
    TerminateAdminSessions: (call: { request: Record<string, unknown> }, cb: (e: grpc.ServiceError | null, v?: unknown) => void) => {
      const id = String(call.request.admin_account_id);
      const sessionId = String(call.request.session_id ?? '');
      if (id === MISSING || sessionId === GONE_SESSION) return cb(fail(grpc.status.NOT_FOUND, '없는 세션'));
      if (id === BAD || (sessionId !== '' && !/^[0-9a-f-]{36}$/.test(sessionId))) return cb(fail(grpc.status.INVALID_ARGUMENT, '꼴이 틀렸다'));
      if (id === DOWN) return cb(fail(grpc.status.UNAVAILABLE, 'identity가 닿지 않는다'));
      cb(null, { ended_count: 1, already_done: false });
    },
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
  address = `127.0.0.1:${port}`;
  adapter = new GrpcIdentityAdminAccounts(address);
  svc = await createService({
    name: 'ops-svc-admin-grpc-problems',
    module: AppModule.register({ memory: true, auditChain: new MemoryAuditChain(), adminAccounts: { identity: adapter, reauth: kit.verifier } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 30_000);

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  adapter?.close();
  server?.forceShutdown();
});

const send = (method: 'GET' | 'POST' | 'DELETE', url: string, headers: Record<string, string>) => svc.http.inject({ method, url, headers });
const postJson = (url: string, headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const designation = { kind: 'ACCESS_REVIEWER', basis: '지정서' };
const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const typeOf = (r: { payload: string }) => String(json(r).type ?? '');
const commander = identity.ops('commander');
const auth = () => ({ ...commander, 'x-reauth-token': kit.token({ accountId: commander['x-user-id']!, sessionId: commander['x-session-id']!, act: 'PERMISSION_CHANGE' }) });

describe('RV-02 identity gRPC 오류 → Problem', () => {
  test('RV-02 gRPC 어댑터: NOT_FOUND는 404, INVALID_ARGUMENT는 400, UNAVAILABLE은 503이다', async () => {
    const expectProblem = async (p: Promise<unknown>, status: number, type: string) => {
      const e = await p.then(
        () => undefined,
        (err: unknown) => err,
      );
      if (!(e instanceof AdminAccountProblem)) throw e;
      expect(e).toMatchObject({ status, type });
    };
    await expectProblem(adapter.designate({ requestId: 'rv02-1', actedBy: ACCOUNT, adminAccountId: MISSING, kind: 'ACCESS_REVIEWER', basis: '지정서' }), 404, 'not-found');
    await expectProblem(adapter.revokeDesignation({ requestId: 'rv02-2', actedBy: ACCOUNT, adminAccountId: MISSING, kind: 'ACCESS_REVIEWER' }), 404, 'not-found');
    await expectProblem(adapter.terminateSessions({ requestId: 'rv02-3', actedBy: ACCOUNT, adminAccountId: ACCOUNT, sessionId: GONE_SESSION }), 404, 'session-not-found');
    await expectProblem(adapter.terminateSessions({ requestId: 'rv02-4', actedBy: ACCOUNT, adminAccountId: ACCOUNT, sessionId: 'not-a-uuid' }), 400, 'invalid-query');
    await expectProblem(adapter.designate({ requestId: 'rv02-5', actedBy: ACCOUNT, adminAccountId: DOWN, kind: 'ACCESS_REVIEWER', basis: '지정서' }), 503, 'admin-account-unavailable');
  });

  test('RV-02 HTTP: 없는 계정 지정·지정 거두기·세션은 500이 아니라 404 Problem이고 잘못된 ID는 400이다', async () => {
    const designate = await postJson(`/v1/ops/admin-accounts/${MISSING}/designations`, auth(), designation);
    expect(designate.statusCode, designate.payload).toBe(404);
    expect(typeOf(designate)).toMatch(/not-found$/);
    const revoke = await send('DELETE', `/v1/ops/admin-accounts/${MISSING}/designations/ACCESS_REVIEWER`, auth());
    expect(revoke.statusCode, revoke.payload).toBe(404);
    const sessions = await send('DELETE', `/v1/ops/admin-accounts/${ACCOUNT}/sessions/${GONE_SESSION}`, auth());
    expect(sessions.statusCode, sessions.payload).toBe(404);
    expect(typeOf(sessions)).toMatch(/session-not-found$/);
    const badId = await postJson('/v1/ops/admin-accounts/not-a-uuid/designations', auth(), designation);
    expect(badId.statusCode, badId.payload).toBe(400);
    const bad = await postJson(`/v1/ops/admin-accounts/${BAD}/designations`, auth(), designation);
    expect(bad.statusCode, bad.payload).toBe(400);
    expect(typeOf(bad)).toMatch(/invalid-query$/);
  });

  test('RV-02 HTTP: identity가 닿지 않으면 503 admin-account-unavailable과 Retry-After다', async () => {
    const r = await send('GET', `/v1/ops/admin-accounts/${DOWN}`, commander);
    expect(r.statusCode, r.payload).toBe(503);
    expect(typeOf(r)).toMatch(/admin-account-unavailable$/);
    expect(r.headers['retry-after']).toBeDefined();
  });
});
