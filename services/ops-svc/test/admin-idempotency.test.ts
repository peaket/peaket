// RV-04: 관리 계정 쓰기의 Idempotency-Key 계약(docs/api/guidelines.md §4, 계획 B17, openapi IdempotencyKey).
// 키는 필수 UUID v4이고(없거나 틀리면 400 idempotency-key-invalid), 같은 키·같은 본문은 같은 답·감사 1회,
// 같은 키·다른 본문은 422 idempotency-key-reused이며 identity를 부르지 않는다. invite·reinvite·designate 셋 다 같다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { FakeAdminIdentity, reauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const COMMANDER = '0194b045-0000-7000-8000-000000003001';
const TARGET = '0194b045-0000-7000-8000-000000003002';
const PARTNER = '0194b045-0000-7000-8000-000000003003';
const PROMOTER = '0194b045-0000-7000-8000-00000000f001';
const V1_KEY = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const identity = new FakeIdentity();
const admin = new FakeAdminIdentity();
const clock = fakeClock({ now: NOW });
const kit = reauthKit(() => clock.now());
const audit = new MemoryAuditChain();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  admin.seed({ adminAccountId: COMMANDER, role: 'commander', status: 'ACTIVE' });
  admin.seed({ adminAccountId: TARGET, role: 'commander', status: 'ACTIVE' });
  admin.seed({ adminAccountId: PARTNER, role: 'partner_admin', status: 'ACTIVE', promoterId: PROMOTER });
  svc = await createService({
    name: 'ops-svc-admin-idempotency',
    module: AppModule.register({ memory: true, auditChain: audit, adminAccounts: { identity: admin, reauth: kit.verifier } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

const who = identity.ops('commander');
const token = () => kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'PERMISSION_CHANGE' });
const send = (method: 'POST' | 'PUT' | 'DELETE', url: string, key: string | undefined, body?: unknown) =>
  svc.http.inject({
    method,
    url,
    headers: { ...who, ...(key === undefined ? {} : { 'idempotency-key': key }), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'DELETE' ? {} : { 'x-reauth-token': token() }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const typeOf = (r: { payload: string }) => String(json(r).type ?? '');
const succeeded = (type: string) => audit.entries.filter((e) => e.recordType === type && e.record.payload.status === 'SUCCEEDED').length;

const inviteBody = (email = 'idem@peaket.example') => ({ email, displayName: '멱등 담당자', role: 'viewer' });
const reinviteBody = (reason = '재발송') => ({ reasonCode: 'RESEND', reason });
const designateBody = (basis = '지정서') => ({ kind: 'ACCESS_REVIEWER', basis });

describe('RV-04 Idempotency-Key', () => {
  test('RV-04 키가 없거나 UUID v4가 아니면 초대·재초대·지정이 400 idempotency-key-invalid이고 identity를 부르지 않는다', async () => {
    const before = { invite: admin.callsOf('invite'), reinvite: admin.callsOf('reinvite'), designate: admin.callsOf('designate') };
    for (const key of [undefined, 'not-a-uuid', V1_KEY]) {
      const invite = await send('POST', '/v1/ops/admin-accounts', key, inviteBody());
      expect(invite.statusCode, `${key} 초대`).toBe(400);
      expect(typeOf(invite), `${key} 초대 type`).toMatch(/idempotency-key-invalid$/);
    }
    expect((await send('POST', `/v1/ops/admin-accounts/${PARTNER}/invitation`, undefined, reinviteBody())).statusCode).toBe(400);
    expect((await send('POST', `/v1/ops/admin-accounts/${PARTNER}/invitation`, V1_KEY, reinviteBody())).statusCode).toBe(400);
    expect((await send('POST', `/v1/ops/admin-accounts/${TARGET}/designations`, undefined, designateBody())).statusCode).toBe(400);
    expect((await send('POST', `/v1/ops/admin-accounts/${TARGET}/designations`, V1_KEY, designateBody())).statusCode).toBe(400);
    expect(admin.callsOf('invite')).toBe(before.invite);
    expect(admin.callsOf('reinvite')).toBe(before.reinvite);
    expect(admin.callsOf('designate')).toBe(before.designate);
  });

  test('RV-04 같은 키·같은 본문은 같은 초대를 돌려주고 identity·감사 SUCCEEDED가 한 번이다', async () => {
    const key = randomUUID();
    const before = { invite: admin.callsOf('invite'), audit: succeeded('ADMIN_ACCOUNT_INVITED') };
    const a = await send('POST', '/v1/ops/admin-accounts', key, inviteBody('same@peaket.example'));
    expect(a.statusCode, a.payload).toBe(201);
    const b = await send('POST', '/v1/ops/admin-accounts', key, inviteBody('same@peaket.example'));
    expect(b.statusCode, b.payload).toBe(201);
    expect(json(b).adminAccountId).toBe(json(a).adminAccountId);
    expect(admin.callsOf('invite')).toBe(before.invite + 1);
    expect(succeeded('ADMIN_ACCOUNT_INVITED')).toBe(before.audit + 1);
  });

  test('RV-04 같은 키·다른 본문은 422 idempotency-key-reused이고 identity·감사를 더 쓰지 않는다', async () => {
    const key = randomUUID();
    expect((await send('POST', '/v1/ops/admin-accounts', key, inviteBody('first@peaket.example'))).statusCode).toBe(201);
    const before = { invite: admin.callsOf('invite'), audit: succeeded('ADMIN_ACCOUNT_INVITED') };
    const diff = await send('POST', '/v1/ops/admin-accounts', key, inviteBody('other@peaket.example'));
    expect(diff.statusCode, diff.payload).toBe(422);
    expect(typeOf(diff)).toMatch(/idempotency-key-reused$/);
    expect(admin.callsOf('invite')).toBe(before.invite);
    expect(succeeded('ADMIN_ACCOUNT_INVITED')).toBe(before.audit);
  });

  test('RV-04 재초대·지정도 같은 키 재전송이 감사를 겹치지 않고 다른 본문은 422다', async () => {
    // 재초대
    const reKey = randomUUID();
    const beforeRe = { calls: admin.callsOf('reinvite'), audit: succeeded('ADMIN_ACCOUNT_REINVITED') };
    expect((await send('POST', `/v1/ops/admin-accounts/${PARTNER}/invitation`, reKey, reinviteBody())).statusCode).toBe(200);
    expect((await send('POST', `/v1/ops/admin-accounts/${PARTNER}/invitation`, reKey, reinviteBody())).statusCode).toBe(200);
    expect(admin.callsOf('reinvite')).toBe(beforeRe.calls + 1);
    expect(succeeded('ADMIN_ACCOUNT_REINVITED')).toBe(beforeRe.audit + 1);
    const reDiff = await send('POST', `/v1/ops/admin-accounts/${PARTNER}/invitation`, reKey, reinviteBody('다른 사유'));
    expect(reDiff.statusCode, reDiff.payload).toBe(422);
    expect(typeOf(reDiff)).toMatch(/idempotency-key-reused$/);
    expect(admin.callsOf('reinvite')).toBe(beforeRe.calls + 1);
    // 지정
    const dsKey = randomUUID();
    const beforeDs = { calls: admin.callsOf('designate'), audit: succeeded('ADMIN_ACCOUNT_DESIGNATED') };
    expect((await send('POST', `/v1/ops/admin-accounts/${TARGET}/designations`, dsKey, designateBody())).statusCode).toBe(201);
    expect((await send('POST', `/v1/ops/admin-accounts/${TARGET}/designations`, dsKey, designateBody())).statusCode).toBe(201);
    expect(admin.callsOf('designate')).toBe(beforeDs.calls + 1);
    expect(succeeded('ADMIN_ACCOUNT_DESIGNATED')).toBe(beforeDs.audit + 1);
    const dsDiff = await send('POST', `/v1/ops/admin-accounts/${TARGET}/designations`, dsKey, designateBody('다른 근거'));
    expect(dsDiff.statusCode, dsDiff.payload).toBe(422);
    expect(typeOf(dsDiff)).toMatch(/idempotency-key-reused$/);
    expect(admin.callsOf('designate')).toBe(beforeDs.calls + 1);
  });
});
