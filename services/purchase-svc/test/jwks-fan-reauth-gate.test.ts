// 팬 취소 재인증 확인기(JwksFanReauthGate) 단위 시험(R-T39 ⑤, BAT-415-reauth, 시험 담당 l3-b415r-test).
// 정본: docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인'('한 번 쓰기'·'답'), docs/data.md §3 `reauth:jti:{jti}`
// (서명·클레임 확인을 마친 뒤 잡고, 수명은 토큰의 남은 시간이며 5분을 넘지 않는다).
// 가짜 시계로 경계(exp 직전 1ms·exp)를 재고, 수명 값은 5분 상수와 다르게(180초·600초) 고른다.
import { fakeClock, RedisReauthJtiStore } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { JwksFanReauthGate, ReauthUnavailable, type FanReauthAct } from '../src/modules/refund/index.js';
import { fakeJwksFetch, fakeSeatRedis, fanKey, ISS, JWKS_URL, reauthClaims, signReauth } from './fan-reauth-fixtures.js';

const NOW = Date.parse('2026-11-13T10:00:00+09:00');
const NOW_S = NOW / 1000;
const ACCOUNT = '0193a200-0000-7000-8000-000000000001';
const LOGIN = '0193a200-0000-7000-8000-000000000002';
const fan = fanKey('fan-k1');
const q = (act: FanReauthAct = 'FAN_SENSITIVE') => ({ accountId: ACCOUNT, sessionId: LOGIN, act });

function gateAt(nowMs = NOW) {
  const clock = fakeClock({ now: nowMs });
  const redis = fakeSeatRedis();
  const jwks = fakeJwksFetch([fan]);
  const gate = new JwksFanReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock, fetch: jwks.fetch });
  return { gate, redis, jwks, clock };
}
const token = (over: Record<string, unknown> = {}, act = 'FAN_SENSITIVE', lifeS = 180) => {
  const c = reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN, act, lifeS }, over);
  return { jti: c.jti as string, exp: c.exp as number, t: signReauth(fan, c) };
};

describe('JwksFanReauthGate [BAT-415-reauth]', () => {
  test('R-T39 ⑤ 어댑터는 확인을 마친 뒤에만 정확한 수명으로 jti를 잡는다', async () => {
    // 180초 → PX 180000(남은 시간)
    {
      const { gate, redis, jwks } = gateAt();
      const tk = token();
      expect(await gate.verify(tk.t, q())).toBe(true);
      expect(redis.commands).toEqual([['SET', `reauth:jti:${tk.jti}`, '1', 'NX', 'PX', '180000']]);
      expect(jwks.urls, '팬 공개키 묶음 주소에서 읽는다').toEqual([JWKS_URL]);
    }
    // 600초(정본 5분보다 긴 시험 키 토큰) → 5분에서 자른다
    {
      const { gate, redis } = gateAt();
      const tk = token({}, 'FAN_SENSITIVE', 600);
      expect(await gate.verify(tk.t, q())).toBe(true);
      expect(redis.commands).toEqual([['SET', `reauth:jti:${tk.jti}`, '1', 'NX', 'PX', '300000']]);
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

  test('R-T39 ⑤ 어댑터는 act·sid·sub가 틀린 토큰을 거절하고 jti를 잡지 않는다', async () => {
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

  test('R-T39 ⑤ 어댑터는 토큰이 없거나 빈 값이면 false이고 공개키도 jti도 건드리지 않는다', async () => {
    const { gate, redis } = gateAt();
    expect(await gate.verify(undefined, q())).toBe(false);
    expect(await gate.verify('', q())).toBe(false);
    expect(redis.commands).toHaveLength(0);
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
