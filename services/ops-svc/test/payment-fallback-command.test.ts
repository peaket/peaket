// 명령 6 결제 갈래(결제 감내 모드, mode PAYMENT_PG_FALLBACK)의 꼴·역할·재인증을 바깥 HTTP 경계에서 본다(BAT-360 OPS-290, ADR-0349 결정 6, 계획 6절 B18).
// 정본 값: {mode: PAYMENT_PG_FALLBACK, scope: EVENT|PLATFORM, eventIds, toPg?}, EVENT면 회차 1~100개 [가정], PLATFORM이면 회차 없음, toPg는 없을 수 있다.
// 요청은 commander, 승인은 요청자 아닌 operator 이상(control-tower §3 6행, payment §2.2), 둘 다 재인증이다(결정 6).
// 재인증은 제품 JwksApprovalVerifier를 시험 키·jti 대역에 물린다(admin-support.ts). 하위 결제사 판정은 다른 서비스 경계라 포트를 구현한 짝 가짜다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { UnavailableAdminIdentity } from '../src/modules/admin-accounts/index.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { pgAssignmentVerdictOf, type CommandExecutor, type OnsaleStartSource, type PgAssignmentCheck, type PgAssignmentVerdict, type PgName } from '../src/modules/commands/index.js';
import { reauthKit, type ReauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-23T02:00:00.000Z');
type Headers = Record<string, string>;

class FixedOnsale implements OnsaleStartSource {
  async saleStartMs(): Promise<number | undefined> {
    return undefined;
  }
}
class FakePgCheck implements PgAssignmentCheck {
  readonly calls: { eventId: string; primaryPg: PgName; fallbackPg?: PgName }[] = [];
  async check(q: { eventId: string; primaryPg: PgName; fallbackPg?: PgName }): Promise<PgAssignmentVerdict> {
    this.calls.push({ ...q });
    return pgAssignmentVerdictOf({ allowed: true, current_primary_pg: 'PG_PROVIDER_TOSS', current_fallback_pg: 'PG_PROVIDER_PORTONE', approval_limits: [{ pg: 'PG_PROVIDER_PORTONE', approvals_per_second: 30 }] });
  }
}

interface Harness {
  readonly svc: Awaited<ReturnType<typeof createService>>;
  readonly clock: FakeClock;
  readonly identity: FakeIdentity;
  readonly kit: ReauthKit;
  readonly executed: string[];
  post(url: string, who: Headers, body: unknown): Promise<{ statusCode: number; payload: string }>;
  get(url: string, who: Headers): Promise<{ statusCode: number; payload: string }>;
  withToken(who: Headers): Headers;
}

const opened: Harness[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.svc.close();
});

async function harness(): Promise<Harness> {
  const clock = fakeClock({ now: NOW });
  const identity = new FakeIdentity();
  const kit = reauthKit(() => clock.now());
  const executed: string[] = [];
  const executor: CommandExecutor = { execute: async (c) => (executed.push(c.commandId), { status: 'ACKED', ackedAtMs: clock.now() }) };
  const svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({
      memory: true,
      executor,
      auditChain: new MemoryAuditChain(),
      adminAccounts: { identity: new UnavailableAdminIdentity(), reauth: kit.verifier },
      commandExtras: { pgAssignment: { onsale: new FixedOnsale(), pgCheck: new FakePgCheck() } },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  const h: Harness = {
    svc,
    clock,
    identity,
    kit,
    executed,
    post: (url, who, body) =>
      svc.http.inject({ method: 'POST', url, headers: { ...(url === '/v1/ops/commands' ? { 'idempotency-key': randomUUID() } : {}), ...who, 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
    get: (url, who) => svc.http.inject({ method: 'GET', url, headers: who }),
    withToken: (who) => ({ ...who, 'x-reauth-token': kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'OPS_COMMAND' }) }),
  };
  opened.push(h);
  return h;
}

const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const slug = (r: { payload: string }) => String(json(r).type ?? '').split('/').pop();
const fallback = (params: Record<string, unknown>) => ({ type: 'DEGRADED_MODE', reason: '결제사 장애 대응', params: { mode: 'PAYMENT_PG_FALLBACK', ...params } });
const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
const commandCount = async (h: Harness, who: Headers) => (json(await h.get('/v1/ops/commands?limit=100', who)).items as unknown[]).length;

describe('B360-PGF 명령 6 결제 갈래 꼴(ADR-0349 결정 6, B18)', () => {
  test('B360-PGF ① 결제 갈래 꼴 밖(모르는 칸·범위·회차 0개·101개·PLATFORM에 회차·대문자 회차·겹친 회차·허용 밖 toPg)은 422이고 명령 행이 없다', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    const one = randomUUID();
    const bad: [string, Record<string, unknown>][] = [
      ['모르는 칸', { scope: 'EVENT', eventIds: [one], channel: 'B' }],
      ['범위 밖 값', { scope: 'REGION', eventIds: [one] }],
      ['EVENT에 회차 0개', { scope: 'EVENT', eventIds: [] }],
      ['EVENT에 회차 없음', { scope: 'EVENT' }],
      ['EVENT에 회차 101개', { scope: 'EVENT', eventIds: ids(101) }],
      ['PLATFORM에 회차', { scope: 'PLATFORM', eventIds: [one] }],
      ['대문자 회차', { scope: 'EVENT', eventIds: [one.toUpperCase()] }],
      ['겹친 회차', { scope: 'EVENT', eventIds: [one, one] }],
      ['허용 밖 toPg', { scope: 'EVENT', eventIds: [one], toPg: 'NAVERPAY' }],
    ];
    for (const [label, params] of bad) {
      const r = await h.post('/v1/ops/commands', h.withToken(commander), fallback(params));
      expect(r.statusCode, `${label} ${r.payload}`).toBe(422);
      expect(['invalid-command', 'command-out-of-range'], label).toContain(slug(r));
    }
    expect(await commandCount(h, commander)).toBe(0);
  });

  test('B360-PGF ② 경계: EVENT 회차 1개·100개, PLATFORM 회차 없음, toPg 없음은 받는다(승인 대기)', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    for (const [label, params] of [
      ['회차 1개', { scope: 'EVENT', eventIds: ids(1), toPg: 'PORTONE' }],
      ['회차 100개', { scope: 'EVENT', eventIds: ids(100) }],
      ['PLATFORM', { scope: 'PLATFORM' }],
    ] as const) {
      const r = await h.post('/v1/ops/commands', h.withToken(commander), fallback(params));
      expect(r.statusCode, `${label} ${r.payload}`).toBe(201);
      expect(json(r).state, label).toBe('PENDING_APPROVAL');
    }
    expect(await commandCount(h, commander)).toBe(3);
  });
});

describe('B360-PGF 명령 6 결제 갈래 역할·재인증(ADR-0349 결정 6, B18)', () => {
  test('B360-PGF ③ 요청은 commander만(operator 403 command-role-forbidden)이고 재인증 없는 요청은 403이며 명령 행이 없다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const commander = h.identity.ops('commander');
    const params = { scope: 'EVENT', eventIds: ids(1) };
    const byOperator = await h.post('/v1/ops/commands', h.withToken(op), fallback(params));
    expect(byOperator.statusCode).toBe(403);
    expect(slug(byOperator)).toBe('command-role-forbidden');
    const noReauth = await h.post('/v1/ops/commands', commander, fallback(params));
    expect(noReauth.statusCode).toBe(403);
    expect(slug(noReauth)).toMatch(/reauth-required$/);
    expect(await commandCount(h, commander)).toBe(0);
  });

  test('B360-PGF ④ 승인은 요청자 아닌 operator도 되고 둘 다 재인증이다: 요청자 본인 403, 재인증 없는 승인 403, 재인증한 operator 승인 → 실행', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    const op = h.identity.ops('operator');
    const created = await h.post('/v1/ops/commands', h.withToken(commander), fallback({ scope: 'EVENT', eventIds: ids(2), toPg: 'PORTONE' }));
    expect(created.statusCode, created.payload).toBe(201);
    const id = json(created).commandId as string;

    const self = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(commander), {});
    expect(self.statusCode).toBe(403);
    expect(slug(self)).toBe('command-requester-cannot-approve');

    const noToken = await h.post(`/v1/ops/commands/${id}/approvals`, op, {});
    expect(noToken.statusCode).toBe(403);
    expect(slug(noToken)).toMatch(/reauth-required$/);
    expect(json(await h.get(`/v1/ops/commands/${id}`, op)).state).toBe('PENDING_APPROVAL');
    expect(h.executed).toEqual([]);

    const ok = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(op), {});
    expect(ok.statusCode, ok.payload).toBe(200);
    expect(json(await h.get(`/v1/ops/commands/${id}`, op)).state).toBe('ACKED');
    expect(h.executed).toEqual([id]);
  });

  test('B360-PGF ⑤ viewer는 승인할 수 없다(403)', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    const viewer = h.identity.ops('viewer');
    const id = json(await h.post('/v1/ops/commands', h.withToken(commander), fallback({ scope: 'PLATFORM' }))).commandId as string;
    const r = await h.post(`/v1/ops/commands/${id}/approvals`, h.withToken(viewer), {});
    expect(r.statusCode).toBe(403);
    expect(json(await h.get(`/v1/ops/commands/${id}`, commander)).state).toBe('PENDING_APPROVAL');
  });
});
