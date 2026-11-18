// 팬 취소 재인증 확인기(JwksFanReauthGate) 단위 시험(R-T39 ②③⑤, BAT-415-reauth, 시험 담당 l3-b415r-test).
// 정본: docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인'('공개키 묶음 읽기'·'한 번 쓰기'·'답'), docs/data.md §3 `reauth:jti:{jti}`
// (서명·클레임 확인을 마친 뒤 잡고, 수명은 토큰의 남은 시간이며 5분 30초를 넘지 않는다. 넘는 토큰은 잡지 않고 거절한다).
// 가짜 시계로 경계(exp 직전 1ms·exp, 남은 수명 330,000ms·330,001ms)를 재고, 수명 값은 상수와 다르게(180초·600초) 고른다.
// 리뷰 반영 재현(RV-02·RV-05·RV-09, 검증 V8·대조 어긋남 둘)은 같은 시험 담당 세션이 더했다.
import { fakeClock, RedisReauthJtiStore } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { JwksFanReauthGate, ReauthUnavailable, type FanReauthAct } from '../src/modules/refund/index.js';
import { fakeJwksFetch, fakeSeatRedis, fanKey, hs256Reauth, ISS, JWKS_URL, reauthClaims, signReauth, unsignedReauth, type FanKey } from './fan-reauth-fixtures.js';

const NOW = Date.parse('2026-11-13T10:00:00+09:00');
const NOW_S = NOW / 1000;
const ACCOUNT = '0193a200-0000-7000-8000-000000000001';
const LOGIN = '0193a200-0000-7000-8000-000000000002';
const fan = fanKey('fan-k1');
const q = (act: FanReauthAct = 'FAN_SENSITIVE') => ({ accountId: ACCOUNT, sessionId: LOGIN, act });
/** 정본의 남은 수명 상한: 5분 + 시계 차이 30초(docs/features/transfer-refund.md §3.1 '한 번 쓰기') */
const LIFETIME_CAP_MS = 330_000;
/** 정본의 공개키 묶음 읽기 한 번의 시간 상한 1,000ms [가정](docs/features/transfer-refund.md §3.1 '공개키 묶음 읽기') */
const JWKS_READ_CAP_MS = 1_000;

function gateAt(nowMs = NOW, keys: readonly FanKey[] = [fan]) {
  const clock = fakeClock({ now: nowMs });
  const redis = fakeSeatRedis();
  const jwks = fakeJwksFetch(keys);
  const gate = new JwksFanReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock, fetch: jwks.fetch });
  return { gate, redis, jwks, clock };
}
const token = (over: Record<string, unknown> = {}, act = 'FAN_SENSITIVE', lifeS = 180) => {
  const c = reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN, act, lifeS }, over);
  return { jti: c.jti as string, exp: c.exp as number, t: signReauth(fan, c) };
};

describe('JwksFanReauthGate [BAT-415-reauth]', () => {
  test('R-T39 ③ 어댑터는 확인을 마친 뒤에만 정확한 수명으로 jti를 잡는다(한 번 쓰기)', async () => {
    // 180초 → PX 180000(남은 시간)
    {
      const { gate, redis, jwks } = gateAt();
      const tk = token();
      expect(await gate.verify(tk.t, q())).toBe(true);
      expect(redis.commands).toEqual([['SET', `reauth:jti:${tk.jti}`, '1', 'NX', 'PX', '180000']]);
      expect(jwks.urls, '팬 공개키 묶음 주소에서 읽는다').toEqual([JWKS_URL]);
    }
    // 경계: 지금 = exp×1000 − 1 → 통과, 남은 1ms
    {
      const tk = token({ exp: NOW_S + 180 });
      const { gate, redis } = gateAt(tk.exp * 1000 - 1);
      expect(await gate.verify(tk.t, q())).toBe(true);
      expect(redis.commands).toEqual([['SET', `reauth:jti:${tk.jti}`, '1', 'NX', 'PX', '1']]);
    }
    // 경계: 지금 = exp×1000 → 만료, 잡지 않는다
    {
      const tk = token({ exp: NOW_S + 180 });
      const { gate, redis } = gateAt(tk.exp * 1000);
      expect(await gate.verify(tk.t, q())).toBe(false);
      expect(redis.commands).toHaveLength(0);
    }
  });

  test('R-T39 ② 남은 수명이 5분 30초를 넘는 토큰은 거절하고 jti를 잡지 않는다', async () => {
    // 남은 수명 = 상한 그대로(330,000ms) → 통과이고 기록 수명도 그 값(공용 저장소 상한이 5분에서 자르지 않는다)
    {
      const tk = token({ exp: NOW_S + 400 });
      const { gate, redis } = gateAt(tk.exp * 1000 - LIFETIME_CAP_MS);
      expect(await gate.verify(tk.t, q()), '남은 330,000ms').toBe(true);
      expect(redis.commands).toEqual([['SET', `reauth:jti:${tk.jti}`, '1', 'NX', 'PX', '330000']]);
    }
    // 상한 + 1ms → 거절, 잡지 않는다
    {
      const tk = token({ exp: NOW_S + 400 });
      const { gate, redis } = gateAt(tk.exp * 1000 - (LIFETIME_CAP_MS + 1));
      expect(await gate.verify(tk.t, q()), '남은 330,001ms').toBe(false);
      expect(redis.commands).toHaveLength(0);
    }
    // 600초짜리(정본 상한보다 긴, 시험 키로 만든 토큰) → 거절
    {
      const { gate, redis } = gateAt();
      const tk = token({}, 'FAN_SENSITIVE', 600);
      expect(await gate.verify(tk.t, q()), '600초').toBe(false);
      expect(redis.commands).toHaveLength(0);
    }
    // 대조: 180초는 그대로 통과
    {
      const { gate, redis } = gateAt();
      const tk = token();
      expect(await gate.verify(tk.t, q())).toBe(true);
      expect(redis.commands).toEqual([['SET', `reauth:jti:${tk.jti}`, '1', 'NX', 'PX', '180000']]);
    }
  });

  test('R-T39 ② 어댑터는 act·sid·sub가 틀린 토큰을 거절하고 jti를 잡지 않는다', async () => {
    const cases: [string, string, FanReauthAct][] = [
      ['act 반대(FAN_HIGH_RISK 토큰을 FAN_SENSITIVE로)', token({}, 'FAN_HIGH_RISK').t, 'FAN_SENSITIVE'],
      ['act 반대(FAN_SENSITIVE 토큰을 FAN_HIGH_RISK로)', token({}, 'FAN_SENSITIVE').t, 'FAN_HIGH_RISK'],
      ['act 목록 밖(APPROVAL)', token({}, 'APPROVAL').t, 'FAN_SENSITIVE'],
      ['sid 다름', token({ sid: 'login-other' }).t, 'FAN_SENSITIVE'],
      ['sub 다름', token({ sub: '0193a200-0000-7000-8000-0000000000ff' }).t, 'FAN_SENSITIVE'],
    ];
    for (const [what, t, act] of cases) {
      const { gate, redis } = gateAt();
      expect(await gate.verify(t, q(act)), what).toBe(false);
      expect(redis.commands, what).toHaveLength(0);
    }
    // 대조: 같은 묶음이면 통과(위 거절이 묶음 대조 때문임을 보인다)
    const { gate } = gateAt();
    expect(await gate.verify(token({}, 'FAN_HIGH_RISK').t, q('FAN_HIGH_RISK'))).toBe(true);
  });

  test('R-T39 ② 어댑터는 토큰이 없거나 빈 값이면 false이고 공개키도 jti도 건드리지 않는다', async () => {
    const { gate, redis, jwks } = gateAt();
    expect(await gate.verify(undefined, q())).toBe(false);
    expect(await gate.verify('', q())).toBe(false);
    expect(redis.commands).toHaveLength(0);
    expect(jwks.urls, '공개키 묶음을 읽지 않는다').toHaveLength(0);
  });

  test('R-T39 ② 어댑터는 alg none·HS256 토큰을 거절하고 jti를 잡지 않으며, none은 공개키 묶음도 읽지 않는다', async () => {
    const claims = () => reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN });
    {
      const { gate, redis, jwks } = gateAt();
      expect(await gate.verify(unsignedReauth(fan.kid, claims()), q()), 'alg none').toBe(false);
      expect(redis.commands).toHaveLength(0);
      expect(jwks.urls, 'alg none: 공개키 읽기 0번').toHaveLength(0);
    }
    {
      const { gate, redis } = gateAt();
      expect(await gate.verify(hs256Reauth(fan, claims()), q()), 'alg HS256').toBe(false);
      expect(redis.commands).toHaveLength(0);
    }
  });

  test('R-T39 ⑤ 어댑터는 팬 공개키 묶음을 받지 못하면 false가 아니라 ReauthUnavailable을 던진다', async () => {
    for (const mode of ['throw', 'http500'] as const) {
      const { gate, redis, jwks } = gateAt();
      jwks.mode = mode;
      await expect(gate.verify(token().t, q()), mode).rejects.toBeInstanceOf(ReauthUnavailable);
      expect(jwks.urls.length, `${mode}: 장애가 실제로 끼어들었다`).toBeGreaterThanOrEqual(1);
      expect(redis.commands, mode).toHaveLength(0);
    }
  });

  test('R-T39 ⑤ 공개키 묶음 안의 키가 깨지면(같은 kid 키 둘, ERR_JWKS_MULTIPLE_MATCHING_KEYS) 어댑터는 ReauthUnavailable을 던진다', async () => {
    const twin = fanKey(fan.kid); // 같은 kid, 다른 키
    const { gate, redis, jwks } = gateAt(NOW, [fan, twin]);
    await expect(gate.verify(token().t, q())).rejects.toBeInstanceOf(ReauthUnavailable);
    expect(jwks.urls.length, '깨진 묶음을 실제로 받았다').toBeGreaterThanOrEqual(1);
    expect(redis.commands).toHaveLength(0);
  });

  test('R-T39 ⑤ 좌표가 곡선 밖인 키를 담은 공개키 묶음이면 어댑터는 ReauthUnavailable을 던진다', async () => {
    // 같은 kid, x는 팬 키 그대로이고 y만 다른 키의 것(곡선 밖, jose가 DOMException DataError를 낸다)
    const offCurve: FanKey = { ...fan, publicJwk: { ...fan.publicJwk, y: fanKey(fan.kid).publicJwk.y! } };
    const { gate, redis, jwks } = gateAt(NOW, [offCurve]);
    await expect(gate.verify(token().t, q())).rejects.toBeInstanceOf(ReauthUnavailable);
    expect(jwks.urls.length, '깨진 묶음을 실제로 받았다').toBeGreaterThanOrEqual(1);
    expect(redis.commands, 'jti를 잡지 않는다').toHaveLength(0);
    // 대조: crv가 빠진 키는 맞는 키가 없는 것이라 거절(false)이지 확인 못 함이 아니다
    const noCrv: FanKey = { ...fan, publicJwk: Object.fromEntries(Object.entries(fan.publicJwk).filter(([k]) => k !== 'crv')) };
    const c = gateAt(NOW, [noCrv]);
    expect(await c.gate.verify(token().t, q()), 'crv 없음').toBe(false);
    expect(c.redis.commands).toHaveLength(0);
  });

  test('R-T39 ⑤ 처음 공개키 읽기가 답하지 않으면 1,000ms 안팎에 ReauthUnavailable이다', { timeout: 15_000 }, async () => {
    const { gate, redis, jwks } = gateAt();
    jwks.mode = 'hang';
    const started = performance.now();
    const err = await gate.verify(token().t, q()).then(
      () => undefined,
      (e: unknown) => e,
    );
    const took = performance.now() - started;
    expect(err).toBeInstanceOf(ReauthUnavailable);
    // 가짜 시계는 AbortSignal.timeout을 움직이지 않아 실제 시간으로 잰다(아래쪽은 상한 − 100ms, 위쪽은 2,500ms)
    expect(took, `걸린 시간 ${Math.round(took)}ms`).toBeGreaterThanOrEqual(JWKS_READ_CAP_MS - 100);
    expect(took, `걸린 시간 ${Math.round(took)}ms`).toBeLessThan(2_500);
    expect(jwks.urls, '읽기 한 번').toHaveLength(1);
    expect(redis.commands).toHaveLength(0);
  });

  test('R-T39 ⑤ 어댑터는 jti 저장소 오류에 ReauthUnavailable, 이미 있음에 false를 준다(세 상태)', async () => {
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
      expect(await gate.verify(tk.t, q()), '같은 토큰 두 번째').toBe(false);
    }
  });
});
