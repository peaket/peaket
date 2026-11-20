// 관리 계정 REST의 PostgreSQL 18 통합 시험(AZ-T14 ⑤, ASVS 8.2.1·8.2.2, BUILD_ORDER BOT-152, ADR-0322).
// 실제 ops DB에 감사 기록·승인 업무를 남기고, 역할 변경·세션 종료가 늦게 보이더라도 identity 판정(요청마다 다시 읽기)이
// 같은 액세스 토큰의 다음 요청을 403으로 막는지 본다. 지연 반영은 시험 대역 identity의 답을 바꿔 흉내 낸다.
import 'reflect-metadata';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { FakeAdminIdentity, reauthKit } from '../test/admin-support.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-20T08:00:00.000Z');
const identity = new FakeIdentity();
const admin = new FakeAdminIdentity();
const clock = fakeClock({ now: NOW });
const kit = reauthKit(() => clock.now());
const PROMOTER = '0194b045-0000-7000-8000-00000000f001';
let container: PostgresContainer | undefined;
let db: Database;
let adminDb: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-admin-accounts-it' });
  adminDb = new pg.Client({ connectionString: container.url });
  await adminDb.connect();
  svc = await createService({
    name: 'ops-svc-admin-accounts',
    module: AppModule.register({ database: db, nowMs: NOW, adminAccounts: { identity: admin, reauth: kit.verifier } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close().catch(() => undefined);
  await adminDb?.end().catch(() => undefined);
  await db?.close().catch(() => undefined);
  container?.stop();
});

const post = (url: string, headers: Record<string, string>, body: unknown) => svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (url: string, headers: Record<string, string>) => svc.http.inject({ method: 'GET', url, headers });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const withToken = (who: Record<string, string>, extra: Record<string, string> = {}) => ({
  ...who,
  'x-reauth-token': kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'PERMISSION_CHANGE' }),
  ...extra,
});
const INVITE = (email: string) => ({ email, displayName: '파트너 담당자', role: 'partner_admin', promoterId: PROMOTER });

describe('관리 계정 REST(PostgreSQL)', () => {
  test('AZ-T14 ⑤ [ASVS v5.0.0-8.2.1] [ASVS v5.0.0-8.2.2] operator→viewer로 바뀌거나 세션이 끝나면 같은 액세스 토큰의 다음 초대는 401/403이고 identity 호출·감사가 늘지 않는다', async () => {
    const operator = identity.ops('operator');
    admin.actor(operator['x-user-id']!, 'operator');
    const ok = await post('/v1/ops/admin-accounts', withToken(operator), INVITE('first@stella.example'));
    expect(ok.statusCode, ok.payload).toBe(201);
    expect(admin.callsOf('invite')).toBe(1);
    const [row] = (await adminDb.query("select record_type, record_json from audit_chain where record_type = $1 and record_json->'payload'->>'status' = 'SUCCEEDED'", ['ADMIN_ACCOUNT_INVITED'])).rows as Array<{ record_type: string; record_json: { payload: { status?: string } } }>;
    expect(row.record_type).toBe('ADMIN_ACCOUNT_INVITED');
    expect(row.record_json.payload.status).toBe('SUCCEEDED');

    // 역할 변경이 늦게 보이거나(캐시) 세션이 끝난 경우: identity 판정은 요청마다 다시 읽는다
    const key = `${operator['x-user-id']}/${operator['x-session-id']}`;
    identity.answers.set(key, { valid: true, role: 'viewer' });
    // 역할 판정 캐시(5초 [가정])가 지난 뒤 같은 액세스 토큰으로 다시 부른다
    clock.advance(6_000);
    const asViewer = await post('/v1/ops/admin-accounts', withToken(operator), INVITE('second@stella.example'));
    expect(asViewer.statusCode).toBe(403);
    expect(admin.callsOf('invite')).toBe(1);

    identity.answers.set(key, { valid: false, role: '' });
    clock.advance(6_000);
    const ended = await post('/v1/ops/admin-accounts', withToken(operator), INVITE('third@stella.example'));
    expect(ended.statusCode).toBe(401);
    expect(admin.callsOf('invite')).toBe(1);
    const auditCount = (await adminDb.query("select count(*)::int as n from audit_chain where record_type = 'ADMIN_ACCOUNT_INVITED'")).rows[0] as { n: number };
    expect(auditCount.n).toBe(2); // 첫 요청의 REQUESTED·SUCCEEDED만
  });

  test('AZ-T14 ⑤ 역할 변경 승인 업무와 감사 기록이 ops DB에 남고, 판이 맞지 않으면 412로 identity를 부르지 않는다', async () => {
    const commander = identity.ops('commander');
    admin.actor(commander['x-user-id']!, 'commander');
    const target = '0194b045-0000-7000-8000-00000000b001';
    admin.seed({ adminAccountId: target, role: 'operator', status: 'ACTIVE' });
    // 판 불일치: 412, identity 역할 변경 0
    const before = admin.callsOf('changeRole');
    const stale = await svc.http.inject({ method: 'PUT', url: `/v1/ops/admin-accounts/${target}/role`, headers: { ...withToken(commander), 'content-type': 'application/json', 'if-match': '"9"' }, payload: JSON.stringify({ role: 'commander', reason: '승진' }) });
    expect(stale.statusCode).toBe(412);
    expect(admin.callsOf('changeRole')).toBe(before);
    // 맞는 판: 202 승인 업무가 DB(approval_request)에 남는다
    const created = await svc.http.inject({ method: 'PUT', url: `/v1/ops/admin-accounts/${target}/role`, headers: { ...withToken(commander), 'content-type': 'application/json', 'if-match': '"1"' }, payload: JSON.stringify({ role: 'commander', reason: '승진' }) });
    expect(created.statusCode, created.payload).toBe(202);
    const approvalId = json(created).approvalId as string;
    const [approval] = (await adminDb.query('select kind, status, target_ref from approval_request where id = $1', [approvalId])).rows as Array<{ kind: string; status: string; target_ref: string }>;
    expect(approval).toEqual({ kind: 'COMMANDER_ROLE_CHANGE', status: 'PENDING_APPROVAL', target_ref: target });
    const [requested] = (await adminDb.query("select record_json from audit_chain where record_type = 'ADMIN_ACCOUNT_ROLE_CHANGED' and record_id = $1 order by seq desc limit 1", [target])).rows as Array<{ record_json: { payload: { status?: string; approvalId?: string } } }>;
    expect(requested.record_json.payload).toMatchObject({ status: 'REQUESTED', approvalId });
  });

  test('AZ-T14 ⑤ 목록·권한 내역은 DB 감사 기록에서 읽고, 다른 계정·없는 계정은 같은 404다', async () => {
    const commander = identity.ops('commander');
    const list = await get('/v1/ops/admin-accounts?group=PARTNER&limit=10', commander);
    expect(list.statusCode, list.payload).toBe(200);
    expect((json(list).items as unknown[]).length).toBeGreaterThan(0);
    for (const id of ['0194b045-0000-7000-8000-00000000b0ff', '0194b045-0000-7000-8000-00000000b0fe']) {
      const r = await get(`/v1/ops/admin-accounts/${id}`, commander);
      expect(r.statusCode).toBe(404);
      expect(String(json(r).type)).toMatch(/not-found$/);
    }
    const changes = await get('/v1/ops/admin-accounts/0194b045-0000-7000-8000-00000000b001/permission-changes', commander);
    expect(changes.statusCode, changes.payload).toBe(200);
    // SUCCEEDED만 준다(위 202는 REQUESTED뿐이라 빈 목록)
    expect(json(changes).items).toEqual([]);
  });
});
