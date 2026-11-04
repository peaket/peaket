// identity AdminAuthzService 클라이언트: 로컬 grpc-js 서버로 칸 이름·답 바꾸기·기한을 본다(ADR-0172, ADR-0198 결정 6, BUILD_ORDER HOT-171)
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { identityV1Identity } from '@peaket/contracts/proto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GrpcAdminAuthz, toAdminAuthz } from '../src/modules/catalog/adapters/identity-admin-authz.js';

let server: grpc.Server;
let port = 0;
const seen: Record<string, unknown>[] = [];

beforeAll(async () => {
  const def = protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { identity: { v1: Record<string, grpc.ServiceClientConstructor> } } }).peaket.identity.v1;
  server = new grpc.Server();
  server.addService(pkg.AdminAuthzService!.service, {
    GetAdminAuthz: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      seen.push(call.request);
      if (call.request.admin_account_id === 'slow') return void setTimeout(() => cb(null, { valid: true, role: 'partner_admin', tenant_id: 't' }), 500);
      cb(null, call.request.session_id === 's-ok' ? { valid: true, role: 'partner_member', tenant_id: 'tenant-1' } : { valid: false, role: '', tenant_id: '' });
    },
  });
  port = await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
});
afterAll(() => {
  server?.forceShutdown();
});

describe('GetAdminAuthz 클라이언트', () => {
  test('계정·세션을 proto 칸 이름으로 보내고 역할·테넌트를 받는다', async () => {
    const c = new GrpcAdminAuthz(`127.0.0.1:${port}`);
    try {
      expect(await c.getAdminAuthz({ adminAccountId: 'acc-1', sessionId: 's-ok' })).toEqual({ valid: true, role: 'partner_member', tenantId: 'tenant-1' });
      expect(seen.at(-1)).toEqual({ admin_account_id: 'acc-1', session_id: 's-ok' });
      expect(await c.getAdminAuthz({ adminAccountId: 'acc-1', sessionId: 's-ended' })).toEqual({ valid: false, role: '' });
    } finally {
      c.close();
    }
  });

  test('가드가 넘긴 남은 시간 안에 답하지 않으면 실패한다(가드가 503으로 닫는다)', async () => {
    const c = new GrpcAdminAuthz(`127.0.0.1:${port}`);
    try {
      await expect(c.getAdminAuthz({ adminAccountId: 'slow', sessionId: 's' }, { timeoutMs: 100, signal: new AbortController().signal })).rejects.toThrow();
    } finally {
      c.close();
    }
  });

  test('valid가 true가 아닌 답은 모두 닫는 쪽이고, 빈 테넌트는 싣지 않는다', () => {
    expect(toAdminAuthz({})).toEqual({ valid: false, role: '' });
    expect(toAdminAuthz({ valid: 'true', role: 'partner_admin', tenant_id: '' })).toEqual({ valid: false, role: 'partner_admin' });
  });

  test('주소가 host:port가 아니면 만들 때 실패한다', () => {
    expect(() => new GrpcAdminAuthz('identity-svc')).toThrow(/host:port/);
  });
});
