// 인증 가드·종료 세션 목록·역할 가드(openspec 변경 add-service-structure-and-request-checks 결정 7·8).
// 소유자 결정 2026-10-31(ADR-0172): 역할은 토큰에 없고 요청마다 identity에서 받는다. 시험 AZ-T1·AZ-T16(일부)·I-T48(일부).
import 'reflect-metadata';
import { Controller, Get, Module, Post, Query } from '@nestjs/common';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CurrentPrincipal,
  Roles,
  createService,
  fakeClock,
  type AdminAuthz,
  type AdminAuthzPort,
  type FakeClock,
  type Principal,
} from '../src/index.js';
import { collector, type LogLine } from './fixture.js';

@Controller('v1/a')
class AuthController {
  @Get('public')
  @Roles(['public'])
  open(@CurrentPrincipal() p: Principal | undefined) {
    return { principal: p ?? null };
  }

  @Get('fan')
  @Roles(['fan'])
  fan(@CurrentPrincipal() p: Principal) {
    return { principal: p };
  }

  @Get('buy')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  buy() {
    return { ok: true };
  }

  @Get('ops')
  @Roles(['operator', 'commander'])
  ops(@CurrentPrincipal() p: Principal) {
    return { role: p.role };
  }

  @Post('ops/risky')
  @Roles(['operator', 'commander'], { fresh: true })
  risky() {
    return { ok: true };
  }

  @Get('partner')
  @Roles(['partner_admin', 'partner_member'])
  partner(@CurrentPrincipal() p: Principal, @Query('promoterId') _ignored?: string) {
    return { tenantId: p.tenantId, role: p.role };
  }

  @Post('partner/password-changes')
  @Roles(['partner_admin', 'partner_member'], { passwordChangeSession: true })
  changePassword() {
    return { ok: true };
  }
}

@Module({ controllers: [AuthController] })
class AuthModule {}

/** identity GetAdminAuthz 대역: (계정, 세션)마다 답을 정하고 부른 수를 센다 */
class FakeIdentity implements AdminAuthzPort {
  answers = new Map<string, AdminAuthz>();
  calls = 0;
  fail = false;
  /** 답하지 않고 멈춘다(코드 리뷰 2026-11-01: 시간 한도가 없어 관리 요청이 매달렸다) */
  hang = false;
  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    this.calls += 1;
    if (this.hang) return new Promise<AdminAuthz>(() => {});
    if (this.fail) throw new Error('UNAVAILABLE: identity');
    return this.answers.get(`${q.adminAccountId}/${q.sessionId}`) ?? { valid: false, role: '' };
  }
}

const started: Awaited<ReturnType<typeof createService>>[] = [];
afterEach(async () => {
  while (started.length) await started.pop()!.close();
});

async function boot(module: unknown = AuthModule) {
  const clock: FakeClock = fakeClock();
  const identity = new FakeIdentity();
  const logs = collector();
  const svc = await createService({ name: 'auth-svc', module: module as never, env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' }, clock, logDestination: logs.stream, adminAuthz: identity });
  started.push(svc);
  const get = (url: string, headers: Record<string, string> = {}, method = 'GET') => svc.http.inject({ method: method as 'GET', url, headers });
  const requests = () => logs.lines.filter((l: LogLine) => l.msg === 'request');
  return { svc, clock, identity, get, requests };
}

const fan = (sid = 's-fan', extra: Record<string, string> = {}) => ({ 'x-user-id': 'acc-fan', 'x-session-id': sid, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy openid', ...extra });
const ops = (sid = 's-ops', extra: Record<string, string> = {}) => ({ 'x-user-id': 'acc-ops', 'x-session-id': sid, 'x-user-aud': 'ops', ...extra });

describe('허용 역할 적기(AZ-T1)', () => {
  test('AZ_T1_허용역할을적지않은처리기가있으면_시작이실패하고_그이름이나온다', async () => {
    @Controller('v1/x')
    class Missing {
      @Get('a')
      @Roles(['public'])
      a() {
        return 1;
      }

      @Get('b')
      forgotten() {
        return 2;
      }
    }
    @Module({ controllers: [Missing] })
    class M {}
    await expect(boot(M)).rejects.toThrow(/Missing\.forgotten/);
  });

  test('AZ_T1_표에없는값과_빈목록은_시작이실패한다', async () => {
    @Controller('v1/y')
    class Bad {
      @Get('a')
      @Roles(['superuser' as never])
      a() {
        return 1;
      }
    }
    @Module({ controllers: [Bad] })
    class M {}
    await expect(boot(M)).rejects.toThrow(/superuser/);
    expect(() => Roles([])).toThrow();
  });

  test('FND070_현장스태프역할은_GAT170전까지_시작이실패한다', async () => {
    @Controller('v1/z')
    class Scanner {
      @Get('a')
      @Roles(['gate_staff'])
      a() {
        return 1;
      }
    }
    @Module({ controllers: [Scanner] })
    class M {}
    await expect(boot(M)).rejects.toThrow(/gate_staff/);
  });
});

describe('신원과 종료 세션 목록', () => {
  test('FND070_공개경로는_신원없이통과하고_공개가아닌경로는401이다', async () => {
    const { get } = await boot();
    const open = await get('/v1/a/public');
    expect(open.statusCode).toBe(200);
    expect(JSON.parse(open.payload)).toEqual({ principal: null });
    const r = await get('/v1/a/fan');
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'about:blank', title: 'Unauthorized', status: 401 });
  });

  test('FND070_팬경로는_게이트웨이머리의신원을받고_정규로그줄에가명만남긴다', async () => {
    const { get, requests } = await boot();
    const r = await get('/v1/a/fan', fan('s-1', { 'x-user-pid': 'pid-1' }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).principal).toEqual({ accountId: 'acc-fan', sessionId: 's-1', aud: 'fan', scopes: ['ticket:buy', 'openid'], pid: 'pid-1' });
    const line = requests().at(-1)!;
    expect(line.sidRef).toEqual(expect.any(String));
    expect(line.accountRef).toEqual(expect.any(String));
    expect(line.pidRef).toEqual(expect.any(String));
    expect(JSON.stringify(line)).not.toMatch(/acc-fan|s-1|pid-1/);
  });

  test('FND070_대상이맞지않거나_스코프가없으면_거절한다', async () => {
    const { get } = await boot();
    expect((await get('/v1/a/fan', ops())).statusCode).toBe(401);
    expect((await get('/v1/a/ops', fan())).statusCode).toBe(401);
    expect((await get('/v1/a/buy', fan())).statusCode).toBe(200);
    const noScope = await get('/v1/a/buy', fan('s-1', { 'x-user-scope': 'openid' }));
    expect(noScope.statusCode).toBe(403);
    expect(JSON.parse(noScope.payload)).toMatchObject({ type: 'about:blank', title: 'Forbidden', status: 403 });
  });

  test('ASVS_7_4_1_I_T48_끝난세션은_401이고_종료시각15분뒤목록에서지운다 [ASVS v5.0.0-7.4.1]', async () => {
    const { svc, clock, get } = await boot();
    svc.auth.terminateSession({ sessionId: 's-1', terminatedAt: new Date(clock.now()).toISOString() });
    const r = await get('/v1/a/fan', fan('s-1'));
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
    expect((await get('/v1/a/fan', fan('s-2'))).statusCode).toBe(200);
    clock.advance(15 * 60_000 - 1);
    expect(svc.auth.isTerminated('s-1')).toBe(true);
    clock.advance(1);
    expect(svc.auth.isTerminated('s-1')).toBe(false);
  });

  test('I_T48_되감아읽은옛종료사건은_종료시각기준으로남은시간만둔다', async () => {
    const { svc, clock } = await boot();
    svc.auth.terminateSession({ sessionId: 's-old', terminatedAt: new Date(clock.now() - 14 * 60_000).toISOString() });
    svc.auth.terminateSession({ sessionId: 's-gone', terminatedAt: new Date(clock.now() - 16 * 60_000).toISOString() });
    expect(svc.auth.isTerminated('s-old')).toBe(true);
    expect(svc.auth.isTerminated('s-gone')).toBe(false);
    clock.advance(60_000);
    expect(svc.auth.isTerminated('s-old')).toBe(false);
  });
});

describe('역할 판정(ADR-0172)', () => {
  test('AZ_T16_역할은_identity의지금역할로판정하고_바깥X_User_Role은보지않는다 [ASVS v5.0.0-8.2.1]', async () => {
    const { get, identity } = await boot();
    identity.answers.set('acc-ops/s-ops', { valid: true, role: 'viewer' });
    const r = await get('/v1/a/ops', ops('s-ops', { 'x-user-role': 'commander', 'x-tenant-id': 't-x' }));
    expect(r.statusCode).toBe(403);
    identity.answers.set('acc-ops/s-2', { valid: true, role: 'operator' });
    const ok = await get('/v1/a/ops', ops('s-2'));
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.payload)).toEqual({ role: 'operator' });
  });

  test('AZ_T16_5초캐시로통과하고_위험작업은다시물으며_6초뒤에는새역할이다', async () => {
    const { get, identity, clock } = await boot();
    identity.answers.set('acc-ops/s-ops', { valid: true, role: 'operator' });
    expect((await get('/v1/a/ops', ops())).statusCode).toBe(200);
    expect(identity.calls).toBe(1);
    identity.answers.set('acc-ops/s-ops', { valid: true, role: 'viewer' });
    clock.advance(2000);
    expect((await get('/v1/a/ops', ops())).statusCode).toBe(200);
    expect(identity.calls).toBe(1);
    expect((await get('/v1/a/ops/risky', ops(), 'POST')).statusCode).toBe(403);
    expect(identity.calls).toBe(2);
    clock.advance(4000);
    expect((await get('/v1/a/ops', ops())).statusCode).toBe(403);
    expect(identity.calls).toBe(3);
  });

  test('AZ_T16_identity가답하지않고캐시도없으면_503_authz_unavailable로닫는다', async () => {
    const { get, identity, clock } = await boot();
    identity.fail = true;
    const r = await get('/v1/a/ops', ops());
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('1');
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/authz-unavailable', status: 503 });
    // 5초 안의 캐시가 있으면 그 값으로 판정하고, 지난 캐시로는 통과시키지 않는다
    identity.fail = false;
    identity.answers.set('acc-ops/s-ops', { valid: true, role: 'operator' });
    expect((await get('/v1/a/ops', ops())).statusCode).toBe(200);
    identity.fail = true;
    clock.advance(3000);
    expect((await get('/v1/a/ops', ops())).statusCode).toBe(200);
    expect((await get('/v1/a/ops/risky', ops(), 'POST')).statusCode).toBe(503);
    clock.advance(3000);
    expect((await get('/v1/a/ops', ops())).statusCode).toBe(503);
  });

  test('AZ_T16_identity가답하지않고멈추면_남은시간안에_503으로닫는다', async () => {
    const { get, identity } = await boot();
    identity.hang = true;
    const t0 = performance.now();
    const r = await get('/v1/a/ops', ops('s-ops', { 'x-peaket-deadline-ms': '80' }));
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/authz-unavailable' });
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  test('FND070_identity가세션을유효하지않다고하면_401이고_캐시하지않는다', async () => {
    const { get, identity } = await boot();
    expect((await get('/v1/a/ops', ops())).statusCode).toBe(401);
    expect((await get('/v1/a/ops', ops())).statusCode).toBe(401);
    expect(identity.calls).toBe(2);
  });

  test('FND070_세션종료를받으면_그세션의역할캐시도지운다', async () => {
    const { svc, get, identity } = await boot();
    identity.answers.set('acc-ops/s-ops', { valid: true, role: 'operator' });
    expect((await get('/v1/a/ops', ops())).statusCode).toBe(200);
    svc.auth.terminateSession({ sessionId: 's-ops' });
    expect((await get('/v1/a/ops', ops())).statusCode).toBe(401);
    expect(identity.calls).toBe(1);
  });

  test('FND070_파트너테넌트는_identity가준값이고_쿼리의promoterId는쓰지않는다', async () => {
    const { get, identity } = await boot();
    identity.answers.set('acc-p/s-p', { valid: true, role: 'partner_member', tenantId: 'promoter-1' });
    const h = { 'x-user-id': 'acc-p', 'x-session-id': 's-p', 'x-user-aud': 'partner' };
    const r = await get('/v1/a/partner?promoterId=promoter-2', h);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ tenantId: 'promoter-1', role: 'partner_member' });
    identity.answers.set('acc-p/s-q', { valid: true, role: 'operator' });
    expect((await get('/v1/a/partner', { ...h, 'x-session-id': 's-q' })).statusCode).toBe(403);
  });

  test('FND070_관리역할처리기가있는데_identity조회를주지않으면_시작이실패한다', async () => {
    const logs = collector();
    await expect(createService({ name: 'x', module: AuthModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: logs.stream })).rejects.toThrow(/adminAuthz/);
  });
});

// 비밀번호 바꾸기 필요 세션(docs/features/identity.md §6 '관리 계정 비밀번호만 맞은 로그인 알림과 비밀번호 바꾸기의 첫 구현', BUILD_ORDER BOT-123)
describe('비밀번호 바꾸기 필요 세션(AC-T4)', () => {
  const partner = (scope: string) => ({ 'x-user-id': 'acc-p', 'x-session-id': 's-p', 'x-user-aud': 'partner', 'x-user-scope': scope });
  test('AC_T4_password_change스코프의관리세션은_연처리기말고는403_password_change_required이고_보통세션은그대로다 [ASVS v5.0.0-6.3.1]', async () => {
    const { get, identity } = await boot();
    identity.answers.set('acc-p/s-p', { valid: true, role: 'partner_admin', tenantId: 't-1' });
    const blocked = await get('/v1/a/partner', partner('password:change'));
    expect(blocked.statusCode).toBe(403);
    expect(JSON.parse(blocked.payload)).toMatchObject({ type: 'https://peaket.example/problems/password-change-required' });
    expect((await get('/v1/a/partner/password-changes', partner('password:change'), 'POST')).statusCode).toBe(201);
    expect((await get('/v1/a/partner', partner(''))).statusCode).toBe(200);
    expect((await get('/v1/a/partner/password-changes', partner(''), 'POST')).statusCode).toBe(201);
  });

  test('AC_T4_세션판정이valid가아니면password_change스코프여도403이아니라401이고_운영자콘솔도같이막으며_관리신원의스코프머리를읽지못하면401이다', async () => {
    const { get, identity } = await boot();
    // 끝난 세션(판정 valid 아님)은 스코프와 관계없이 401
    expect((await get('/v1/a/partner', partner('password:change'))).statusCode).toBe(401);
    identity.answers.set('acc-ops/s-ops', { valid: true, role: 'operator' });
    const blocked = await get('/v1/a/ops', ops('s-ops', { 'x-user-scope': 'password:change' }));
    expect(blocked.statusCode).toBe(403);
    expect(JSON.parse(blocked.payload)).toMatchObject({ type: 'https://peaket.example/problems/password-change-required' });
    // 읽지 못하는 스코프 머리: 제한 스코프가 빠져 보통 세션처럼 통과하지 않는다
    expect((await get('/v1/a/ops', ops('s-ops', { 'x-user-scope': `password:change ${'x'.repeat(1024)}` }))).statusCode).toBe(401);
    expect((await get('/v1/a/ops', ops('s-ops', { 'x-user-scope': 'password:change,openid' }))).statusCode).toBe(401);
    expect((await get('/v1/a/ops', ops('s-ops', { 'x-user-scope': '' }))).statusCode).toBe(200);
    expect((await get('/v1/a/ops', ops('s-ops'))).statusCode).toBe(200);
    // 팬 신원은 지금과 같다(스코프 머리를 읽지 못하면 스코프 없음)
    expect((await get('/v1/a/fan', fan('s-fan', { 'x-user-scope': 'x'.repeat(1025) }))).statusCode).not.toBe(401);
  });
});
