// 리프레시 토큰 회전·재시도 유예·재사용 탐지와 세션 종료 사건(docs/features/identity.md §3 '토큰 수명주기 구현', I-T4, I-T3의 발행 쪽, [ASVS v5.0.0-7.2.4]·[ASVS v5.0.0-7.4.1]).
// 메모리 저장소(단위)와 PostgreSQL 저장소(통합)에 같은 시험을 돌린다.
import { describe, expect, test } from 'vitest';
import type { CreateSessionInput } from '../src/modules/session/application/create-session.js';
import type { RefreshResult } from '../src/modules/session/application/refresh-session.js';
import type { SessionStore } from '../src/modules/session/domain/ports.js';
import { type Kit, kit, newKey } from './support.js';

export interface RefreshStoreUnderTest {
  store: SessionStore;
  /** 그 계정의 세션 종료 사건(Outbox에 적힌 것): [세션 ID, 사유] */
  terminations(accountId: string): Promise<Array<[string, string]>>;
  isTerminated(sessionId: string): Promise<boolean>;
}

const login = (k: Kit, over: Partial<CreateSessionInput> = {}) =>
  k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `u-${newKey().slice(0, 8)}`, email: null, deviceId: 'dev-R', ...over });

const ok = (r: RefreshResult) => {
  if (r.result !== 'OK') throw new Error(`갱신 실패: ${r.result}`);
  return r;
};

export function refreshCases(name: string, make: () => Promise<RefreshStoreUnderTest>) {
  describe(`리프레시 회전과 종료 사건(${name})`, () => {
    test('I-T4_지금토큰으로갱신하면_회전하고_새액세스토큰과유휴만료를늘린다 [ASVS v5.0.0-7.2.4]', async () => {
      const t = await make();
      const k = await kit(t.store);
      const s = await login(k);
      k.clock.advance(60_000);
      const r = ok(await k.refresh.run({ refreshToken: s.refreshToken }));
      expect(r.sessionId).toBe(s.sessionId);
      expect(r.refreshToken).not.toBe(s.refreshToken);
      expect(r.accessToken).not.toBe(s.accessToken);
      expect(r.refreshTokenExpiresAt).toBe(k.clock.now() + 14 * 24 * 3_600_000);
      expect(k.signals.seen.at(-1)).toBe('refresh:fan:rotated');
    });

    test('I-T4_서명이실패하면_회전을쓰지않아_30초가지나도옛토큰으로다시갱신되고_탈취로보지않는다(BOT-130이넘긴것) [ASVS v5.0.0-7.2.4]', async () => {
      const t = await make();
      const k = await kit(t.store);
      const s = await login(k);
      const access = k.signer.access.bind(k.signer);
      k.signer.access = async () => {
        throw new Error('서명 키를 읽지 못했다');
      };
      await expect(k.refresh.run({ refreshToken: s.refreshToken })).rejects.toThrow('서명 키');
      k.signer.access = access;
      k.clock.advance(31_000);
      const r = ok(await k.refresh.run({ refreshToken: s.refreshToken }));
      expect(r.sessionId).toBe(s.sessionId);
      expect(k.signals.seen.at(-1)).toBe('refresh:fan:rotated');
      expect(await t.isTerminated(s.sessionId)).toBe(false);
    });

    test('I-T4_②_응답을잃고30초안에바로앞토큰으로다시갱신하면_새쌍을한번더주고세션이이어진다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const s = await login(k);
      const lost = ok(await k.refresh.run({ refreshToken: s.refreshToken }));
      k.clock.advance(10_000);
      const again = ok(await k.refresh.run({ refreshToken: s.refreshToken }));
      expect(again.refreshToken).not.toBe(lost.refreshToken);
      expect(k.signals.seen.at(-1)).toBe('refresh:fan:retried');
      // 다시 받은 새 토큰으로 이어서 갱신된다
      ok(await k.refresh.run({ refreshToken: again.refreshToken }));
      expect(await t.isTerminated(s.sessionId)).toBe(false);
    });

    test('I-T4_③_재시도로폐기된먼저준토큰을쓰면_탈취로보고세션을끝내며사건을남긴다 [ASVS v5.0.0-7.4.1]', async () => {
      const t = await make();
      const k = await kit(t.store);
      const s = await login(k);
      const lost = ok(await k.refresh.run({ refreshToken: s.refreshToken }));
      ok(await k.refresh.run({ refreshToken: s.refreshToken }));
      expect(await k.refresh.run({ refreshToken: lost.refreshToken })).toEqual({ result: 'REUSED', ended: 'REFRESH_REUSE' });
      expect(await t.isTerminated(s.sessionId)).toBe(true);
      expect(await t.terminations(s.accountId)).toEqual([[s.sessionId, 'REFRESH_REUSE']]);
      expect(k.signals.seen.at(-1)).toBe('refresh:fan:reused');
    });

    test('I-T4_①_폐기된토큰을30초가지난뒤다시쓰면_탈취로보고패밀리를끝낸다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const s = await login(k);
      ok(await k.refresh.run({ refreshToken: s.refreshToken }));
      k.clock.advance(31_000);
      expect(await k.refresh.run({ refreshToken: s.refreshToken })).toEqual({ result: 'REUSED', ended: 'REFRESH_REUSE' });
      expect(await t.isTerminated(s.sessionId)).toBe(true);
    });

    test('I-T4_④_두대앞토큰은_유예안이어도탈취다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const s = await login(k);
      const r1 = ok(await k.refresh.run({ refreshToken: s.refreshToken }));
      ok(await k.refresh.run({ refreshToken: r1.refreshToken }));
      expect(await k.refresh.run({ refreshToken: s.refreshToken })).toEqual({ result: 'REUSED', ended: 'REFRESH_REUSE' });
    });

    test('I-T4_⑤_새토큰을한번쓴뒤바로앞토큰을유예안에쓰면_탈취다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const s = await login(k);
      const r1 = ok(await k.refresh.run({ refreshToken: s.refreshToken }));
      k.clock.advance(5_000);
      // 새 토큰(r1)을 한 번 썼다 = 응답을 받았다는 뜻이다
      ok(await k.refresh.run({ refreshToken: r1.refreshToken }));
      k.clock.advance(5_000);
      // 그 앞 토큰(s)은 첫 회전에서 10초 안이지만 이제 두 대 앞이다
      expect(await k.refresh.run({ refreshToken: s.refreshToken })).toEqual({ result: 'REUSED', ended: 'REFRESH_REUSE' });
      expect(await t.isTerminated(s.sessionId)).toBe(true);
    });

    test('I-T4_모르는토큰·끝난세션·만료된세션은_INVALID다', async () => {
      const t = await make();
      const k = await kit(t.store);
      expect(await k.refresh.run({ refreshToken: 'x'.repeat(43) })).toEqual({ result: 'INVALID' });
      const s = await login(k);
      await k.end.run({ sessionId: s.sessionId, accountId: s.accountId });
      // 끝난 세션의 토큰에는 끝난 까닭이 실린다(ADR-0235, I-T78)
      expect(await k.refresh.run({ refreshToken: s.refreshToken })).toEqual({ result: 'INVALID', ended: 'LOGOUT' });
      const s2 = await login(k);
      k.clock.advance(14 * 24 * 3_600_000 + 1);
      expect(await k.refresh.run({ refreshToken: s2.refreshToken })).toEqual({ result: 'INVALID' });
    });

    test('I-T3_로그아웃과기기한도정리는_같은트랜잭션에세션종료사건을남긴다', async () => {
      const t = await make();
      const k = await kit(t.store);
      const sub = `u-${newKey().slice(0, 8)}`;
      const first = await login(k, { providerUserId: sub, deviceId: 'd0' });
      for (let d = 1; d <= 5; d++) {
        k.clock.advance(1_000);
        await login(k, { providerUserId: sub, deviceId: `d${d}` });
      }
      const last = await login(k, { providerUserId: sub, deviceId: 'd5' });
      await k.end.run({ sessionId: last.sessionId, accountId: last.accountId });
      expect(await t.terminations(first.accountId)).toEqual([
        [first.sessionId, 'DEVICE_LIMIT'],
        [last.sessionId, 'LOGOUT'],
      ]);
    });
  });
}
