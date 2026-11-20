// 관리 계정 쓰기의 재인증(I-T53 ②③, ASVS 7.5.1·9.2.2, BUILD_ORDER BOT-152, ADR-0206·0322).
// 제품 JwksApprovalVerifier를 ES256 시험 키·JWKS 대역·jti 저장소 대역에 물려, 토큰의 aud·act·sid·factors(passkey)·exp·jti를 본다.
// 막히면 403 reauth-required이고 identity 쓰기 호출·감사 기록이 0이며, 확인기·jti 저장소 장애는 503 reauth-unavailable(Retry-After 5초)이다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { FakeAdminIdentity, reauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-20T05:00:00.000Z');
const TARGET = '0194b045-0000-7000-8000-00000000a001';
const PARTNER = '0194b045-0000-7000-8000-00000000a002';
const identity = new FakeIdentity();
const admin = new FakeAdminIdentity();
const clock = fakeClock({ now: NOW });
const kit = reauthKit(() => clock.now());
const audit = new MemoryAuditChain();
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  admin.seed({ adminAccountId: TARGET, role: 'viewer', status: 'ACTIVE' });
  admin.seed({ adminAccountId: PARTNER, role: 'partner_admin', status: 'ACTIVE', promoterId: '0194b045-0000-7000-8000-00000000f001' });
  svc = await createService({
    name: 'ops-svc',
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
beforeEach(() => {
  kit.jti.failNext = false;
});

const post = (url: string, headers: Record<string, string>, body: unknown) => svc.http.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const put = (url: string, headers: Record<string, string>, body: unknown) => svc.http.inject({ method: 'PUT', url, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
interface TokenOptions {
  act?: 'APPROVAL' | 'OPS_COMMAND' | 'PERMISSION_CHANGE';
  factors?: readonly string[];
  jti?: string;
  exp?: number;
  aud?: string;
  typ?: string;
  sessionOverride?: string;
}
const token = (who: Record<string, string>, o: TokenOptions = {}) =>
  kit.token({
    accountId: who['x-user-id']!,
    sessionId: o.sessionOverride ?? who['x-session-id']!,
    ...(o.act ? { act: o.act } : {}),
    ...(o.factors ? { factors: o.factors } : {}),
    ...(o.jti ? { jti: o.jti } : {}),
    ...(o.exp ? { exp: o.exp } : {}),
    ...(o.aud ? { aud: o.aud } : {}),
    ...(o.typ ? { typ: o.typ } : {}),
  });
const withToken = (who: Record<string, string>, t: string, extra: Record<string, string> = {}) => ({ ...who, 'x-reauth-token': t, ...extra });

const auditOf = (type: string) => audit.entries.filter((e) => e.recordType === type);
const invitedAudit = () => auditOf('ADMIN_ACCOUNT_INVITED');

const INVITE = { email: 'new@stella.example', displayName: '새 담당자', role: 'partner_admin', promoterId: '0194b045-0000-7000-8000-00000000f001' };

describe('관리 계정 쓰기의 재인증(I-T53 ②③)', () => {
  test('I-T53 ② [ASVS v5.0.0-7.5.1] [ASVS v5.0.0-9.2.2] 비밀번호·TOTP만 거친 토큰(factors에 passkey 없음)이면 403 reauth-required이고 identity 쓰기·감사 기록이 0이다', async () => {
    const op = identity.ops('operator');
    const weak = token(op, { factors: ['password', 'totp'] });
    const before = { invite: admin.callsOf('invite'), audit: invitedAudit().length };
    const r = await post('/v1/ops/admin-accounts', withToken(op, weak), INVITE);
    expect(r.statusCode).toBe(403);
    expect(String(json(r).type)).toMatch(/reauth-required$/);
    expect(admin.callsOf('invite')).toBe(before.invite);
    expect(invitedAudit()).toHaveLength(before.audit);
  });

  test('I-T53 ② 토큰이 없거나 act가 APPROVAL이거나 다른 세션·다른 aud·만료면 503이 아니라 403이고 identity를 부르지 않는다', async () => {
    const op = identity.ops('operator');
    const target = { ...op };
    const otherSession = token(op, { sessionOverride: '0194b045-0000-7000-8000-0000000000ff' });
    const cases: Array<[string, string | undefined]> = [
      ['없음', undefined],
      ['act APPROVAL', token(op, { act: 'APPROVAL' })],
      ['다른 세션', otherSession],
      ['다른 aud', token(op, { aud: 'partner' })],
      ['만료', token(op, { exp: Math.floor(NOW / 1000) - 1 })],
      ['typ이 액세스 토큰', token(op, { typ: 'at+jwt' })],
    ];
    const before = { invite: admin.callsOf('invite'), audit: invitedAudit().length };
    for (const [label, t] of cases) {
      const r = await post('/v1/ops/admin-accounts', t === undefined ? target : withToken(target, t), INVITE);
      expect(r.statusCode, label).toBe(403);
      expect(String(json(r).type), label).toMatch(/reauth-required$/);
    }
    expect(admin.callsOf('invite')).toBe(before.invite);
    expect(invitedAudit()).toHaveLength(before.audit);
  });

  test('I-T53 ③ [ASVS v5.0.0-7.5.1] [ASVS v5.0.0-9.2.2] 패스키까지 거친 토큰이면 초대가 201이고 identity 초대 1·감사 REQUESTED→SUCCEEDED 1이며, 같은 jti 두 번째는 403이고 두 번째 호출 0이다', async () => {
    const op = identity.ops('operator');
    const jti = 'jti-single-use-1';
    const t = token(op, { jti });
    const before = { invite: admin.callsOf('invite'), requested: invitedAudit().filter((e) => e.record.payload.status === 'REQUESTED').length, succeeded: invitedAudit().filter((e) => e.record.payload.status === 'SUCCEEDED').length };
    const ok = await post('/v1/ops/admin-accounts', withToken(op, t), INVITE);
    expect(ok.statusCode, ok.payload).toBe(201);
    expect(admin.callsOf('invite')).toBe(before.invite + 1);
    expect(invitedAudit().filter((e) => e.record.payload.status === 'REQUESTED')).toHaveLength(before.requested + 1);
    expect(invitedAudit().filter((e) => e.record.payload.status === 'SUCCEEDED')).toHaveLength(before.succeeded + 1);
    const replay = await post('/v1/ops/admin-accounts', withToken(op, t), { ...INVITE, email: 'second@stella.example' });
    expect(replay.statusCode).toBe(403);
    expect(String(json(replay).type)).toMatch(/reauth-required$/);
    expect(admin.callsOf('invite')).toBe(before.invite + 1);
    expect(invitedAudit().filter((e) => e.record.payload.status === 'SUCCEEDED')).toHaveLength(before.succeeded + 1);
  });

  test('I-T53 ③ 확인기·jti 저장소에 닿지 못하면 403이 아니라 503 reauth-unavailable(Retry-After 5초)이고 행·감사를 쓰지 않는다', async () => {
    const op = identity.ops('operator');
    const t = token(op);
    kit.jti.failNext = true;
    const before = { invite: admin.callsOf('invite'), audit: invitedAudit().length };
    const r = await post('/v1/ops/admin-accounts', withToken(op, t), INVITE);
    expect(r.statusCode).toBe(503);
    expect(String(json(r).type)).toMatch(/reauth-unavailable$/);
    expect(r.headers['retry-after']).toBe('5');
    expect(admin.callsOf('invite')).toBe(before.invite);
    expect(invitedAudit()).toHaveLength(before.audit);
  });

  test('I-T53 ③ 역할 변경·재초대·삭제·지정도 같은 재인증 규칙을 쓴다(토큰 없이 403이고 identity 쓰기 0)', async () => {
    const commander = identity.ops('commander');
    const op = identity.ops('operator');
    const before = { changeRole: admin.callsOf('changeRole'), reinvite: admin.callsOf('reinvite'), remove: admin.callsOf('remove'), designate: admin.callsOf('designate') };
    // 파트너 계정 역할 변경: 판이 맞아도 토큰이 없으면 403
    expect((await put(`/v1/ops/admin-accounts/${PARTNER}/role`, { ...op, 'if-match': '"1"' }, { role: 'partner_member', reason: '직무 변경' })).statusCode).toBe(403);
    // 재초대
    expect((await post(`/v1/ops/admin-accounts/${PARTNER}/invitation`, op, { reasonCode: 'RESEND', reason: '재발송' })).statusCode).toBe(403);
    // 삭제(commander 계정이 아닌 파트너 계정)
    expect((await post(`/v1/ops/admin-accounts/${PARTNER}/removal`, op, { reason: '퇴사' })).statusCode).toBe(403);
    // 지정(commander가 자기 자신이 아닌 대상에게)
    expect((await post(`/v1/ops/admin-accounts/${TARGET}/designations`, commander, { kind: 'ACCESS_REVIEWER', basis: '지정서' })).statusCode).toBe(403);
    expect(admin.callsOf('changeRole')).toBe(before.changeRole);
    expect(admin.callsOf('reinvite')).toBe(before.reinvite);
    expect(admin.callsOf('remove')).toBe(before.remove);
    expect(admin.callsOf('designate')).toBe(before.designate);
    // 유효 토큰 + 맞는 판이면 identity 역할 변경까지 간다
    const ok = await put(`/v1/ops/admin-accounts/${PARTNER}/role`, withToken(op, token(op), { 'if-match': '"1"' }), { role: 'partner_member', reason: '직무 변경' });
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(admin.callsOf('changeRole')).toBe(before.changeRole + 1);
  });
});
