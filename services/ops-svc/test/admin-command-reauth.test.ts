// 위험 운영 명령의 재인증(I-T53 ⑤, ASVS 9.2.2, BUILD_ORDER BOT-140·BOT-152, ADR-0095·0206·0322).
// 위험 명령 = 2인 승인 명령과 멈추는 쪽 명령 3·11(KILL_SWITCH·AUTOMATION_STOP). 접수·승인·재시도 세 길 모두
// X-Reauth-Token(act OPS_COMMAND, aud ops, 그 세션, factors에 passkey, jti 1회용)을 요구하고, 막히면 명령 행·감사를 쓰지 않는다.
// LOG_LEVEL 같은 비위험 명령은 지금처럼 토큰 없이 받는다. 제품 JwksApprovalVerifier를 시험 키·jti 대역에 물린다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { CommandExecutor } from '../src/modules/commands/index.js';
import { FakeAdminIdentity, reauthKit } from './admin-support.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-20T06:00:00.000Z');
const identity = new FakeIdentity();
const admin = new FakeAdminIdentity();
const clock = fakeClock({ now: NOW });
const kit = reauthKit(() => clock.now());
let failNext = false;
const executed: string[] = [];
const executor: CommandExecutor = {
  execute: async (c) => {
    executed.push(c.commandId);
    if (failNext) {
      failNext = false;
      return { status: 'FAILED', error: 'core-svc 409' };
    }
    return { status: 'SUCCEEDED' };
  },
};
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, executor, nowMs: NOW, adminAccounts: { identity: admin, reauth: kit.verifier } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
});

/** 접수(POST /v1/ops/commands)는 Idempotency-Key가 필요하다(ADR-0340 결정 7). 키는 요청마다 새로 만든다 */
const post = (url: string, headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, ...(url === '/v1/ops/commands' ? { 'idempotency-key': randomUUID() } : {}), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
/** 명령 3·4의 params(openapi Command.params). 명령 4는 ASN이 있어 2인·위험 명령이다(ADR-0339 결정 1) */
const KILL = { scope: 'PLATFORM' };
const BLOCK_ASN = { asns: [64500], expiresAt: new Date(NOW + 60 * 60_000).toISOString() };
const get = (url: string, headers: Record<string, string>) => svc.http.inject({ method: 'GET', url, headers });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const token = (who: Record<string, string>, o: { act?: 'OPS_COMMAND'; factors?: readonly string[]; jti?: string; sessionOverride?: string } = {}) =>
  kit.token({ accountId: who['x-user-id']!, sessionId: o.sessionOverride ?? who['x-session-id']!, act: o.act ?? 'OPS_COMMAND', ...(o.factors ? { factors: o.factors } : {}), ...(o.jti ? { jti: o.jti } : {}) });
const withToken = (who: Record<string, string>, t: string) => ({ ...who, 'x-reauth-token': t });
const commandCount = async (who: Record<string, string>) => (json(await get('/v1/ops/commands?limit=100', who)).items as unknown[]).length;

describe('위험 명령 재인증(I-T53 ⑤)', () => {
  test('I-T53 ⑤ [ASVS v5.0.0-9.2.2] 킬스위치·BLOCK_ASN_IP·SALE_STOP을 토큰 없이 만들면 403 reauth-required이고 명령 행이 늘지 않는다', async () => {
    const commander = identity.ops('commander');
    const before = await commandCount(commander);
    for (const body of [
      { type: 'KILL_SWITCH', reason: '긴급 정지', params: KILL },
      { type: 'BLOCK_ASN_IP', reason: '대역 차단', params: BLOCK_ASN },
      { type: 'SALE_STOP', reason: '판매 중지', params: { eventId: randomUUID(), reasonCode: 'LEGAL_REQUEST' } },
    ]) {
      const r = await post('/v1/ops/commands', commander, body);
      expect(r.statusCode, body.type).toBe(403);
      expect(String(json(r).type), body.type).toMatch(/reauth-required$/);
    }
    expect(await commandCount(commander)).toBe(before);
    expect(executed).toHaveLength(0);
  });

  test('I-T53 ⑤ [ASVS v5.0.0-9.2.2] 패스키가 없는 토큰·act가 OPS_COMMAND가 아닌 토큰·다른 세션 토큰은 403이고, 맞는 토큰이면 201이다', async () => {
    const commander = identity.ops('commander');
    const before = await commandCount(commander);
    for (const [label, t] of [
      ['passkey 없음', token(commander, { factors: ['password', 'totp'] })],
      ['act APPROVAL', kit.token({ accountId: commander['x-user-id']!, sessionId: commander['x-session-id']!, act: 'APPROVAL' })],
      ['다른 세션', token(commander, { sessionOverride: '0194b045-0000-7000-8000-0000000000ff' })],
    ] as const) {
      const r = await post('/v1/ops/commands', withToken(commander, t), { type: 'KILL_SWITCH', reason: `차단 ${label}`, params: KILL });
      expect(r.statusCode, label).toBe(403);
      expect(String(json(r).type), label).toMatch(/reauth-required$/);
    }
    expect(await commandCount(commander)).toBe(before);
    const ok = await post('/v1/ops/commands', withToken(commander, token(commander)), { type: 'KILL_SWITCH', reason: '긴급 정지', params: KILL });
    expect(ok.statusCode, ok.payload).toBe(201);
    expect(await commandCount(commander)).toBe(before + 1);
  });

  test('I-T53 ⑤ 같은 jti를 두 번째 명령에 쓰면 403이고 두 번째 행은 생기지 않는다', async () => {
    const commander = identity.ops('commander');
    const jti = 'jti-command-single-use';
    const t = token(commander, { jti });
    expect((await post('/v1/ops/commands', withToken(commander, t), { type: 'KILL_SWITCH', reason: '첫 번째', params: KILL })).statusCode).toBe(201);
    const before = await commandCount(commander);
    const replay = await post('/v1/ops/commands', withToken(commander, t), { type: 'KILL_SWITCH', reason: '두 번째', params: KILL });
    expect(replay.statusCode).toBe(403);
    expect(String(json(replay).type)).toMatch(/reauth-required$/);
    expect(await commandCount(commander)).toBe(before);
  });

  test('I-T53 ⑤ 비위험 명령(LOG_LEVEL)은 토큰 없이 201이고, 위험 명령의 승인·재시도도 토큰을 요구한다', async () => {
    const requester = identity.ops('commander');
    const approver = identity.ops('commander');
    const log = await post('/v1/ops/commands', requester, { type: 'LOG_LEVEL', reason: '로그 단계', params: { level: 'DEBUG' } });
    expect(log.statusCode, log.payload).toBe(201);

    const created = await post('/v1/ops/commands', withToken(requester, token(requester)), { type: 'SALE_STOP', reason: '판매 중지', params: { eventId: randomUUID(), reasonCode: 'LEGAL_REQUEST' } });
    expect(created.statusCode, created.payload).toBe(201);
    const commandId = json(created).commandId as string;

    // 승인: 토큰 없이 403, 행은 PENDING_APPROVAL 그대로
    expect((await post(`/v1/ops/commands/${commandId}/approvals`, approver, {})).statusCode).toBe(403);
    expect(json(await get(`/v1/ops/commands/${commandId}`, approver)).state).toBe('PENDING_APPROVAL');

    // 승인: 맞는 토큰이면 실행기가 실패해 FAILED까지 간다
    failNext = true;
    const approved = await post(`/v1/ops/commands/${commandId}/approvals`, withToken(approver, token(approver)), {});
    expect(approved.statusCode, approved.payload).toBe(200);
    expect(json(approved).state).toBe('FAILED');

    // 재시도: 토큰 없이 403, 맞는 토큰이면 실행기가 성공해 SUCCEEDED
    expect((await post(`/v1/ops/commands/${commandId}/retries`, approver, {})).statusCode).toBe(403);
    const retried = await post(`/v1/ops/commands/${commandId}/retries`, withToken(approver, token(approver)), {});
    expect(retried.statusCode, retried.payload).toBe(200);
    expect(json(retried).state).toBe('SUCCEEDED');
  });
});
