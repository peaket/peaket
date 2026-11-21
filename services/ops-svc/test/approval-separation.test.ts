// 2인 승인 분리(AZ-T10, docs/security/authz-matrix.md §6 '승인 업무'·'권한·역할 변경' 행)의 승인 업무(approval_request) 쪽.
// 운영 명령 쪽은 command-lifecycle-http.test.ts(AZ-T10)와 test-int/command-lifecycle.int.test.ts가 본다.
// commander 역할 변경 승인 업무(COMMANDER_ROLE_CHANGE, ADR-0322)에서 요청자 본인 403, 필요한 역할보다 낮은 역할 403, 같은 사람 두 번 409이고
// 막힌 쪽은 승인자로 남지 않으며 identity를 부르지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { FakeAdminIdentity, reauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-22T06:00:00.000Z');
const identity = new FakeIdentity();
const admin = new FakeAdminIdentity();
const clock = fakeClock({ now: NOW });
const kit = reauthKit(() => clock.now());
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, auditChain: new MemoryAuditChain(), adminAccounts: { identity: admin, reauth: kit.verifier } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

const send = (method: 'GET' | 'POST' | 'PUT', url: string, headers: Record<string, string>, body?: unknown) =>
  svc.http.inject({
    method,
    url,
    headers: { ...headers, ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const slug = (r: { payload: string }) => String(json(r).type ?? '');
const approvalToken = (who: Record<string, string>) => kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'APPROVAL' });

describe('AZ-T10 승인 업무의 2인 분리', () => {
  test('AZ-T10 역할 변경 승인 업무: 요청자 본인 403·낮은 역할(operator) 403·같은 사람 두 번 409이고 막힌 쪽은 승인자로 남지 않으며 identity를 한 번만 부른다', async () => {
    const requester = identity.ops('commander');
    const approver = identity.ops('commander');
    const operator = identity.ops('operator');
    admin.actor(requester['x-user-id']!, 'commander');
    admin.actor(approver['x-user-id']!, 'commander');
    const target = randomUUID();
    admin.seed({ adminAccountId: target, role: 'operator', status: 'ACTIVE' });
    const created = await send(
      'PUT',
      `/v1/ops/admin-accounts/${target}/role`,
      { ...requester, 'x-reauth-token': kit.token({ accountId: requester['x-user-id']!, sessionId: requester['x-session-id']!, act: 'PERMISSION_CHANGE' }), 'if-match': '"1"' },
      { role: 'commander', reason: '관제 책임자 승진' },
    );
    expect(created.statusCode, created.payload).toBe(202);
    const approvalId = json(created).approvalId as string;
    const url = `/v1/ops/approval-requests/${approvalId}/approvals`;
    const calls = admin.callsOf('changeRole');

    const self = await send('POST', url, { ...requester, 'x-reauth-token': approvalToken(requester) });
    expect([self.statusCode, slug(self)]).toEqual([403, expect.stringMatching(/approval-self-not-allowed$/)]);
    const low = await send('POST', url, { ...operator, 'x-reauth-token': approvalToken(operator) });
    expect(low.statusCode).toBe(403);
    expect(json(await send('GET', `/v1/ops/approval-requests/${approvalId}`, approver))).toMatchObject({ status: 'PENDING_APPROVAL', approvals: [] });
    expect(admin.callsOf('changeRole')).toBe(calls);

    const ok = await send('POST', url, { ...approver, 'x-reauth-token': approvalToken(approver) });
    expect([ok.statusCode, json(ok).status, json(ok).approvals]).toEqual([200, 'DONE', [approver['x-user-id']]]);
    const twice = await send('POST', url, { ...approver, 'x-reauth-token': approvalToken(approver) });
    expect(twice.statusCode).toBe(409);
    expect(json(await send('GET', `/v1/ops/approval-requests/${approvalId}`, approver))).toMatchObject({ status: 'DONE', approvals: [approver['x-user-id']] });
    expect(admin.callsOf('changeRole')).toBe(calls + 1);
  });
});
