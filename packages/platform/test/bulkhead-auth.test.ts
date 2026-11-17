// W9-fix3 F5(HOT-240 '큰 본문 칸막이를 인증 가드보다 먼저…', 시험 담당 w9f3-test 2026-11-17): 칸막이를 단 경로의 서비스 안 차례.
// 정본: docs/api/guidelines.md §7 '본문을 읽기 전의 차례'(① 신원 → ② 칸막이 자리 → ③ 본문 → ④ 공용 가드 전체, ①에서 막히면 가드와 같은
// 401·403·503이고 자리를 잡지 않고 본문을 읽지 않는다, public 경로는 ① 없음, 칸막이 경로의 허용 역할은 처리기에 단다)와
// 같은 §7 '본문을 다 읽기 전에 답하면 연결을 닫는다', docs/architecture.md §5 'REST 포트' 행(내부 HTTP 호출자는 게이트웨이를 거치지 않는다).
// 실제 소켓으로 머리만 보내(본문은 보내지 않음) '본문을 기다리지 않고 바로 답하는지'를 본다. 자리를 쥐는지는 자리를 먼저 붙잡아 둔 뒤
// 거절 요청이 429가 아니라 제 거절(401·403·503)을 받는지로 본다(옛 차례면 자리가 차 429다).
import 'reflect-metadata';
import { Body, Controller, HttpCode, Module, Post, Put } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  type AdminAuthz,
  type AdminAuthzPort,
  BodyLimit,
  Bulkhead,
  CurrentPrincipal,
  DEFAULT_BODY_LIMIT_BYTES,
  type Principal,
  Roles,
  createService,
  fakeClock,
} from '../src/index.js';
import { collector } from './fixture.js';
import { RawClient, type RawResponse, closedWithin, sleep, trackConnections } from './raw-http.js';

const SAVE = { name: 'bh-save', limit: 1, retryAfterSeconds: 3 };
const ADMIN_ONLY = { name: 'bh-admin-only', limit: 1, retryAfterSeconds: 3 };
const BUY = { name: 'bh-buy', limit: 1, retryAfterSeconds: 3 };
const MIXED = { name: 'bh-mixed', limit: 1, retryAfterSeconds: 3 };
const OPEN = { name: 'bh-open', limit: 1, retryAfterSeconds: 3 };
/** 처리기에 닿은 수와 그때의 요청자 */
const hits = { save: 0, adminOnly: 0, buy: 0, mixed: 0, open: 0 };
const principals: Principal[] = [];

@Controller('v1/bh')
class BulkheadAuthController {
  @HttpCode(200)
  @Put('save')
  @Roles(['partner_admin', 'partner_member'])
  @BodyLimit(DEFAULT_BODY_LIMIT_BYTES * 2, { bulkhead: SAVE })
  save(@Body() body: unknown, @CurrentPrincipal() me: Principal) {
    hits.save++;
    principals.push(me);
    return { ok: true, length: JSON.stringify(body ?? null).length };
  }

  @HttpCode(200)
  @Put('admin-only')
  @Roles(['partner_admin'])
  @Bulkhead(ADMIN_ONLY)
  adminOnly(@CurrentPrincipal() me: Principal) {
    hits.adminOnly++;
    principals.push(me);
    return { ok: true };
  }

  @HttpCode(200)
  @Post('buy')
  @Roles(['fan'], { scopes: ['ticket:buy'] })
  @Bulkhead(BUY)
  buy(@CurrentPrincipal() me: Principal) {
    hits.buy++;
    principals.push(me);
    return { ok: true };
  }

  /** 허용 역할이 [public, fan]: 신원이 없으면 익명으로 통과하지만 신원이 있으면 ①이 대상을 본다 */
  @HttpCode(200)
  @Post('mixed')
  @Roles(['public', 'fan'])
  @Bulkhead(MIXED)
  mixed() {
    hits.mixed++;
    return { ok: true };
  }

  /** 허용 역할이 public뿐: ①이 없다(신원 머리를 보지 않는다) */
  @HttpCode(200)
  @Post('open')
  @Roles(['public'])
  @Bulkhead(OPEN)
  open() {
    hits.open++;
    return { ok: true };
  }
}

@Module({ controllers: [BulkheadAuthController] })
class BulkheadAuthModule {}

type Answer = AdminAuthz | 'throw' | 'hang';

/** 가짜 identity GetAdminAuthz. 계정·세션마다 답을 정하고 부른 수를 센다 */
class FakeAdminAuthz implements AdminAuthzPort {
  calls = 0;
  readonly answers = new Map<string, Answer>();
  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }, opts?: { timeoutMs: number; signal: AbortSignal }): Promise<AdminAuthz> {
    this.calls++;
    const a = this.answers.get(`${q.adminAccountId}/${q.sessionId}`);
    if (a === 'throw') throw new Error('identity 장애(시험 주입)');
    if (a === 'hang') return new Promise<AdminAuthz>((_resolve, reject) => opts?.signal.addEventListener('abort', () => reject(new Error('끊김'))));
    return a ?? { valid: false, role: '' };
  }
}

let seq = 0;
const id = (p: string) => `${p}-${String(++seq).padStart(4, '0')}-w9f3`;
const authz = new FakeAdminAuthz();
const TENANT = '0194d000-0000-7000-8000-00000000f5f5';

/** 파트너 신원 머리. answer로 identity 답을 정한다 */
function partner(answer: Answer = { valid: true, role: 'partner_admin', tenantId: TENANT }, aud = 'partner', scope = ''): Record<string, string> {
  const accountId = id('acc');
  const sessionId = id('sid');
  authz.answers.set(`${accountId}/${sessionId}`, answer);
  return { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': aud, 'x-user-scope': scope };
}
const fan = (scope: string): Record<string, string> => ({ 'x-user-id': id('fan'), 'x-session-id': id('fsid'), 'x-user-aud': 'fan', 'x-user-scope': scope });

let svc: Awaited<ReturnType<typeof createService>>;
let port: number;
let tracker: ReturnType<typeof trackConnections>;
beforeAll(async () => {
  svc = await createService({ name: 'bh-svc', module: BulkheadAuthModule, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream, adminAuthz: authz, requestTimeoutMs: 10_000 });
  await svc.http.listen({ port: 0, host: '127.0.0.1' });
  port = (svc.http.server.address() as { port: number }).port;
  tracker = trackConnections(svc.http.server);
});
afterAll(async () => {
  await svc?.close();
});

const ROUTES = {
  save: { method: 'PUT', path: '/v1/bh/save' },
  adminOnly: { method: 'PUT', path: '/v1/bh/admin-only' },
  buy: { method: 'POST', path: '/v1/bh/buy' },
  mixed: { method: 'POST', path: '/v1/bh/mixed' },
  open: { method: 'POST', path: '/v1/bh/open' },
} as const;
type RouteName = keyof typeof ROUTES;

/** 본문 없이 머리만 보낸 요청(선언 길이 100). 연결은 열어 둔다 */
async function headOnly(route: RouteName, headers: Record<string, string>): Promise<RawClient> {
  const c = await RawClient.open(port);
  c.head(ROUTES[route].method, ROUTES[route].path, { ...headers, 'Content-Type': 'application/json', 'Content-Length': 100 });
  return c;
}

/** 옳은 신원으로 본문까지 보낸 요청(inject) */
const full = (route: RouteName, headers: Record<string, string>) =>
  svc.http.inject({ method: ROUTES[route].method, url: ROUTES[route].path, headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ a: 1 }) });

/** 옳은 신원으로 머리만 보내 그 경로의 자리를 붙잡는다(본문을 기다리는 동안 자리를 쥔다). 찼는지 먼저 단언한다 */
async function holdSlot(route: RouteName, headers: Record<string, string>): Promise<{ release(): Promise<void> }> {
  const holder = await headOnly(route, headers);
  let full429 = 0;
  for (let i = 0; i < 100; i++) {
    if ((await full(route, headers)).statusCode === 429) {
      full429++;
      break;
    }
    await sleep(10);
  }
  expect(full429, `${route}: 자리를 붙잡지 못했다(시험 준비)`).toBe(1);
  return {
    async release() {
      holder.destroy();
      // 자리를 놓았는지(뒤 요청이 바로 들어가는지) 본다
      for (let i = 0; i < 100; i++) {
        const r = await full(route, headers);
        if (r.statusCode !== 429) return;
        await sleep(20);
      }
      throw new Error(`${route}: 붙잡은 연결을 끊었는데 자리를 놓지 않았다(시험 준비)`);
    },
  };
}

const problemType = (r: RawResponse | undefined) => (JSON.parse(r?.body || '{}') as { type?: string }).type;

describe('W9F3 F5 칸막이 경로는 신원을 먼저 본다', () => {
  test('W9F3 F5 신원 없는 요청은 칸막이 자리를 쥐지 못하고 본문을 기다리지 않는다 [ASVS v5.0.0-8.3.1] [ASVS v5.0.0-15.2.2]', async () => {
    const before = hits.save;
    // 신원 머리 없이 머리만 보낸 요청 둘: 본문 없이도 바로 401·WWW-Authenticate·Connection: close, 서버가 닫는다
    const anon = [await headOnly('save', {}), await headOnly('save', {})];
    try {
      for (const [i, c] of anon.entries()) {
        const side = await tracker.of(c.localPort);
        const r = await c.response(0, 1_500);
        expect(r?.status, `신원 없음 ${i + 1}: 본문 없이 바로 답해야 한다`).toBe(401);
        expect(r?.headers['www-authenticate'], `신원 없음 ${i + 1}: WWW-Authenticate`).toBeTruthy();
        expect(r?.headers.connection?.toLowerCase(), `신원 없음 ${i + 1}: Connection`).toBe('close');
        expect(await closedWithin(side, 2_000), `신원 없음 ${i + 1}: 서버가 닫지 않았다`).toBe(true);
      }
      expect(hits.save - before, '처리기에 닿았다').toBe(0);
      // 그 뒤 옳은 partner 요청은 429 없이 200
      const ok = await full('save', partner());
      expect(ok.statusCode).toBe(200);
    } finally {
      for (const c of anon) c.destroy();
    }

    // 옳은 요청이 자리를 쥐고 있어도 신원 없는 요청은 429가 아니라 401이다(자리 잡기 전에 신원을 본다)
    const hold = await holdSlot('save', partner());
    const anon2 = await headOnly('save', {});
    try {
      const r = await anon2.response(0, 1_500);
      expect(r?.status, '자리가 찬 때의 신원 없는 요청').toBe(401);
    } finally {
      anon2.destroy();
      await hold.release();
    }
  }, 20_000);

  test('W9F3 F5 앞 판정은 가드와 같은 거절을 자리 잡기 전에 낸다 [ASVS v5.0.0-8.3.1] [ASVS v5.0.0-8.2.1]', async () => {
    const terminatedHeaders = partner();
    svc.auth.terminateSession({ sessionId: terminatedHeaders['x-session-id']! });
    const cases: Array<{ what: string; route: RouteName; holder: Record<string, string>; headers: Record<string, string>; status: number; type?: string; waitMs?: number }> = [
      { what: '대상 틀림(x-user-aud: fan)', route: 'save', holder: partner(), headers: partner(undefined, 'fan'), status: 401 },
      { what: '종료 세션', route: 'save', holder: partner(), headers: terminatedHeaders, status: 401 },
      { what: 'identity valid: false', route: 'save', holder: partner(), headers: partner({ valid: false, role: '' }), status: 401 },
      { what: 'identity 던짐', route: 'save', holder: partner(), headers: partner('throw'), status: 503, type: 'https://peaket.example/problems/authz-unavailable' },
      { what: 'identity 시간 초과', route: 'save', holder: partner(), headers: partner('hang'), status: 503, type: 'https://peaket.example/problems/authz-unavailable', waitMs: 3_000 },
      { what: '역할 밖(partner_admin만 허용에 partner_member)', route: 'adminOnly', holder: partner(), headers: partner({ valid: true, role: 'partner_member', tenantId: TENANT }), status: 403 },
      // V-F5g: 비밀번호 바꾸기 필요 세션은 연 처리기(비밀번호 바꾸기·로그아웃)만 쓴다. 가드와 같은 403이고 자리 잡기 전이다(guidelines §7 ①)
      { what: '비밀번호 바꾸기 필요 세션(password:change 스코프)', route: 'save', holder: partner(), headers: partner(undefined, 'partner', 'password:change'), status: 403, type: 'https://peaket.example/problems/password-change-required' },
      { what: '스코프 없음(팬 ticket:buy 경로)', route: 'buy', holder: fan('openid ticket:buy'), headers: fan('openid'), status: 403 },
    ];
    for (const c of cases) {
      const hold = await holdSlot(c.route, c.holder);
      const rejected = await headOnly(c.route, c.headers);
      try {
        const side = await tracker.of(rejected.localPort);
        const r = await rejected.response(0, c.waitMs ?? 1_500);
        // 옛 차례면 자리가 차 429이거나, 본문을 기다려 답이 없다
        expect(r?.status, `${c.what}: 본문 없이 자리 잡기 전에 제 거절이어야 한다`).toBe(c.status);
        if (c.type) expect(problemType(r), `${c.what}: Problem`).toBe(c.type);
        if (c.status === 401) expect(r?.headers['www-authenticate'], `${c.what}: WWW-Authenticate`).toBeTruthy();
        expect(r?.headers.connection?.toLowerCase(), `${c.what}: Connection`).toBe('close');
        expect(await closedWithin(side, 2_000), `${c.what}: 서버가 닫지 않았다`).toBe(true);
      } finally {
        rejected.destroy();
        await hold.release();
      }
      // 거절 요청은 처리기에 닿지 않았다(자리를 붙잡고 놓는 옳은 요청은 다른 계정이라 계정으로 가른다)
      expect(principals.filter((p) => p.accountId === c.headers['x-user-id']), `${c.what}: 처리기에 닿았다`).toEqual([]);
    }
  }, 60_000);

  test('W9F3 V-F5f 허용 역할이 public뿐이면 ①이 없고 [public, fan]이면 ①이 있다(신원이 있을 때만) [ASVS v5.0.0-8.3.1]', async () => {
    // [public, fan]: 신원 없는 익명 요청은 통과해 자리를 쥘 수 있다(자리를 붙잡는 요청)
    const hold = await holdSlot('mixed', {});
    try {
      // 자리가 찬 때, 대상이 틀린 신원(partner)은 429가 아니라 ①의 401이다(본문 없이, 자리 잡기 전에)
      const wrongAud = await headOnly('mixed', partner());
      try {
        const side = await tracker.of(wrongAud.localPort);
        const r = await wrongAud.response(0, 1_500);
        expect(r?.status, '[public, fan] 대상 틀린 신원: ①이 자리 잡기 전에 401').toBe(401);
        expect(r?.headers['www-authenticate'], 'WWW-Authenticate').toBeTruthy();
        expect(r?.headers.connection?.toLowerCase(), 'Connection').toBe('close');
        expect(await closedWithin(side, 2_000), '서버가 닫지 않았다').toBe(true);
      } finally {
        wrongAud.destroy();
      }
      // 같은 때, 신원 없는 익명 요청은 ①을 지나 ②에서 자리가 차 429다(익명 통과는 ① 건너뛰기가 아니라 ①의 판정 결과)
      const anon = await headOnly('mixed', {});
      try {
        expect((await anon.response(0, 1_500))?.status, '[public, fan] 익명').toBe(429);
      } finally {
        anon.destroy();
      }
    } finally {
      await hold.release();
    }

    // public뿐: 대상이 틀린 신원 머리가 있어도 ①이 없어 자리를 잡고 본문을 기다린다(401이 아니다). identity도 묻지 않는다
    authz.calls = 0;
    const holder = await headOnly('open', partner());
    try {
      expect(await holder.response(0, 400), 'public뿐 경로의 머리만 요청은 본문을 기다린다(①로 거절되지 않는다)').toBeUndefined();
      const ok = await full('open', partner(undefined, 'fan'));
      expect(ok.statusCode, '자리가 찬 때 public뿐 경로: 신원이 틀려도 ①이 없어 자리 판정(429)만 있다').toBe(429);
    } finally {
      holder.destroy();
    }
    expect(authz.calls, 'public뿐 경로는 identity를 묻지 않는다').toBe(0);
  }, 20_000);

  test('W9F3 F5 옳은 신원은 지금처럼 처리되고 identity는 캐시로 한 번만 묻는다 [ASVS v5.0.0-8.3.1]', async () => {
    const headers = partner({ valid: true, role: 'partner_member', tenantId: TENANT });
    authz.calls = 0;
    principals.length = 0;
    const r = await full('save', headers);
    expect(r.statusCode).toBe(200);
    expect(authz.calls, 'identity를 부른 수(앞 판정 + 가드, 역할 캐시)').toBe(1);
    expect(principals).toHaveLength(1);
    expect(principals[0]).toMatchObject({ accountId: headers['x-user-id'], sessionId: headers['x-session-id'], aud: 'partner', role: 'partner_member', tenantId: TENANT });
  });

  test('W9F3 F5 칸막이 경로의 허용 역할이 클래스에만 있으면 서비스가 시작하지 않는다 [ASVS v5.0.0-8.3.1]', async () => {
    @Controller('v1/bh-class')
    @Roles(['partner_admin'])
    class ClassOnlyBulkheadController {
      @HttpCode(200)
      @Put('bulkhead')
      @Bulkhead({ name: 'bh-class-bulkhead', limit: 1, retryAfterSeconds: 1 })
      bulkhead() {
        return { ok: true };
      }
    }
    @Module({ controllers: [ClassOnlyBulkheadController] })
    class ClassOnlyBulkheadModule {}

    @Controller('v1/bh-class')
    @Roles(['partner_admin'])
    class ClassOnlyBodyLimitController {
      @HttpCode(200)
      @Put('body-limit')
      @BodyLimit(DEFAULT_BODY_LIMIT_BYTES * 2, { bulkhead: { name: 'bh-class-body', limit: 1, retryAfterSeconds: 1 } })
      bodyLimit() {
        return { ok: true };
      }
    }
    @Module({ controllers: [ClassOnlyBodyLimitController] })
    class ClassOnlyBodyLimitModule {}

    for (const [module, path] of [
      [ClassOnlyBulkheadModule, 'v1/bh-class/bulkhead'],
      [ClassOnlyBodyLimitModule, 'v1/bh-class/body-limit'],
    ] as const) {
      const started = await createService({ name: 'bh-class-svc', module, env: { PEAKET_ENV: 'ci' }, clock: fakeClock(), logDestination: collector().stream, adminAuthz: new FakeAdminAuthz() }).then(
        (s) => ({ s }),
        (err: Error) => ({ err }),
      );
      if ('s' in started) {
        await started.s.close();
        throw new Error(`${path}: 허용 역할이 클래스에만 있는 칸막이 경로인데 서비스가 시작했다`);
      }
      expect(started.err.message, path).toContain(path);
    }
  });
});
