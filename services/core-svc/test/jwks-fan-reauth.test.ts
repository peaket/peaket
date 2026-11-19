// 굿즈 취소 재인증 확인기(JwksShopReauthGate) 단위 시험(P-T63 ②, ADR-0293·ADR-0315).
// 정본: docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인', docs/data.md §3 `reauth:jti:{jti}`.
// 서명·typ·iss·aud·exp·sid·act·op를 모두 본 뒤 sub = 요청 계정과 남은 수명(5분 30초 이하)을 확인하고,
// 통과한 뒤에만 jti를 한 번 잡는다. 없음·틀림·만료·어긋남·이미 쓴 jti는 false(403), 키 묶음·저장소 장애는 ReauthUnavailable(503)이다.
// TICKET_CANCEL_REFUND_ACCOUNT 토큰은 op가 달라 거절한다(티켓과 굿즈가 같은 TokenVerifier를 쓰되 op로 가른다).
import { fakeClock, RedisReauthJtiStore } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { JwksShopReauthGate, ReauthUnavailable, type ShopReauthAct, type ShopReauthOp } from '../src/modules/shop/index.js';
import { ACT, fanKey, fakeJwksFetch, fakeSeatRedis, hs256Reauth, ISS, JWKS_URL, OP, reauthClaims, signReauth, unsignedReauth, type FanKey } from './shop-reauth-fixtures.js';

const NOW = Date.parse('2026-11-19T10:00:00+09:00');
const NOW_S = NOW / 1000;
const ACCOUNT = '0193a200-0000-7000-8000-000000000001';
const LOGIN = '0193a200-0000-7000-8000-000000000002';
const fan = fanKey('fan-k1');
/** 정본의 남은 수명 상한: 5분 + 시계 차이 30초(ADR-0293) */
const LIFETIME_CAP_MS = 330_000;

const q = (o: { act?: ShopReauthAct; op?: ShopReauthOp } = {}) => ({ accountId: ACCOUNT, sessionId: LOGIN, act: o.act ?? ACT, op: o.op ?? OP });

function gateAt(nowMs = NOW, keys: readonly FanKey[] = [fan]) {
  const clock = fakeClock({ now: nowMs });
  const redis = fakeSeatRedis();
  const jwks = fakeJwksFetch(keys);
  const gate = new JwksShopReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock, fetch: jwks.fetch });
  return { gate, redis, jwks, clock };
}

const token = (over: Record<string, unknown> = {}, o: { act?: string; op?: string; lifeS?: number } = {}) => {
  const c = reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN, act: o.act ?? ACT, op: o.op ?? OP, lifeS: o.lifeS ?? 180 }, over);
  return { jti: c.jti as string, exp: c.exp as number, t: signReauth(fan, c) };
};

describe('JwksShopReauthGate(P-T63 ②)', () => {
  test('P-T63 ② 확인을 마친 뒤에만 정확한 수명으로 jti를 잡고 팬 공개키 묶음 주소에서 키를 읽는다', async () => {
    const { gate, redis, jwks } = gateAt();
    const tk = token();
    expect(await gate.verify(tk.t, q())).toBe(true);
    expect(redis.commands).toEqual([['SET', `reauth:jti:${tk.jti}`, '1', 'NX', 'PX', '180000']]);
    expect(jwks.urls).toEqual([JWKS_URL]);
  });

  test('P-T63 ② 토큰이 없거나 빈 값이면 false이고 공개키도 jti도 건드리지 않는다', async () => {
    const { gate, redis, jwks } = gateAt();
    expect(await gate.verify(undefined, q())).toBe(false);
    expect(await gate.verify('   ', q())).toBe(false);
    expect(redis.commands).toHaveLength(0);
    expect(jwks.urls).toHaveLength(0);
  });

  test('P-T63 ② sid·sub·act·op가 어긋난 토큰은 거절하고 jti를 잡지 않는다', async () => {
    const cases: [string, string, ReturnType<typeof q>][] = [
      ['sid 다름', token({ sid: 'login-other' }).t, q()],
      ['sub 다름', token({ sub: '0193a200-0000-7000-8000-0000000000ff' }).t, q()],
      ['act 다름(토큰 FAN_SENSITIVE)', token({}, { act: 'FAN_SENSITIVE' }).t, q()],
      ['act 다름(요청 FAN_SENSITIVE)', token().t, q({ act: 'FAN_SENSITIVE' as ShopReauthAct })],
      ['op가 티켓 취소', token({ op: 'TICKET_CANCEL_REFUND_ACCOUNT' }).t, q()],
    ];
    for (const [what, t, query] of cases) {
      const { gate, redis } = gateAt();
      expect(await gate.verify(t, query), what).toBe(false);
      expect(redis.commands, what).toHaveLength(0);
    }
    // 대조: 굿즈 op·act가 맞으면 통과한다
    const ok = gateAt();
    expect(await ok.gate.verify(token().t, q())).toBe(true);
  });

  test('P-T63 ② exp 직전 1ms는 통과하고 정각에는 거절하며 jti를 잡지 않는다', async () => {
    {
      const tk = token();
      const { gate, redis } = gateAt(tk.exp * 1000 - 1);
      expect(await gate.verify(tk.t, q())).toBe(true);
      expect(redis.commands).toEqual([['SET', `reauth:jti:${tk.jti}`, '1', 'NX', 'PX', '1']]);
    }
    {
      const tk = token();
      const { gate, redis } = gateAt(tk.exp * 1000);
      expect(await gate.verify(tk.t, q())).toBe(false);
      expect(redis.commands).toHaveLength(0);
    }
  });

  test('P-T63 ② 남은 수명이 5분 30초를 넘는 토큰은 거절하고 jti를 잡지 않는다', async () => {
    {
      const tk = token({}, { lifeS: 400 });
      const { gate, redis } = gateAt(tk.exp * 1000 - LIFETIME_CAP_MS);
      expect(await gate.verify(tk.t, q()), '남은 330,000ms').toBe(true);
      expect(redis.commands).toEqual([['SET', `reauth:jti:${tk.jti}`, '1', 'NX', 'PX', '330000']]);
    }
    {
      const tk = token({}, { lifeS: 400 });
      const { gate, redis } = gateAt(tk.exp * 1000 - (LIFETIME_CAP_MS + 1));
      expect(await gate.verify(tk.t, q()), '남은 330,001ms').toBe(false);
      expect(redis.commands).toHaveLength(0);
    }
    {
      const { gate, redis } = gateAt();
      expect(await gate.verify(token({}, { lifeS: 600 }).t, q()), '600초').toBe(false);
      expect(redis.commands).toHaveLength(0);
    }
  });

  test('P-T63 ② alg none·HS256 토큰은 거절하고 jti를 잡지 않는다', async () => {
    {
      const { gate, redis, jwks } = gateAt();
      const c = reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN });
      expect(await gate.verify(unsignedReauth(fan.kid, c), q()), 'alg none').toBe(false);
      expect(redis.commands).toHaveLength(0);
      expect(jwks.urls, 'alg none: 공개키 읽기 0번').toHaveLength(0);
    }
    {
      const { gate, redis } = gateAt();
      const c = reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN });
      expect(await gate.verify(hs256Reauth(fan, c), q()), 'alg HS256').toBe(false);
      expect(redis.commands).toHaveLength(0);
    }
  });

  test('P-T63 ② 팬 공개키 묶음을 받지 못하면 false가 아니라 ReauthUnavailable을 던진다', async () => {
    for (const mode of ['throw', 'http500'] as const) {
      const { gate, redis, jwks } = gateAt();
      jwks.mode = mode;
      await expect(gate.verify(token().t, q()), mode).rejects.toBeInstanceOf(ReauthUnavailable);
      expect(jwks.urls.length, `${mode}: 장애가 실제로 끼어들었다`).toBeGreaterThanOrEqual(1);
      expect(redis.commands, mode).toHaveLength(0);
    }
  });

  test('P-T63 ② jti 저장소 오류는 ReauthUnavailable, 이미 있음은 false다(세 상태)', async () => {
    {
      const { gate, redis } = gateAt();
      redis.mode = 'throw';
      await expect(gate.verify(token().t, q())).rejects.toBeInstanceOf(ReauthUnavailable);
      expect(redis.commands).toHaveLength(1);
    }
    {
      const { gate, redis } = gateAt();
      redis.mode = 'exists';
      expect(await gate.verify(token().t, q())).toBe(false);
      expect(redis.commands).toHaveLength(1);
    }
    {
      const { gate } = gateAt();
      const tk = token();
      expect(await gate.verify(tk.t, q())).toBe(true);
      expect(await gate.verify(tk.t, q()), '같은 토큰 두 번째(이미 쓴 jti)').toBe(false);
    }
  });

  test('P-T63 ② 뜻밖의 오류(시계가 TypeError)를 ReauthUnavailable로 덮지 않는다', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'now')");
    const clock = {
      now(): number {
        throw bug;
      },
      monotonicMs(): number {
        throw bug;
      },
    };
    const redis = fakeSeatRedis();
    const jwks = fakeJwksFetch([fan]);
    const gate = new JwksShopReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock, fetch: jwks.fetch });
    const err = await gate.verify(token().t, q()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBe(bug);
    expect(redis.commands, 'jti를 잡지 않는다').toHaveLength(0);
  });
});
