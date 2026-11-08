// 세션 종료 사유를 갱신 401로 알린다(docs/features/identity.md §8 '팬 계정 요약·세션 종료 사유·가입 마무리의 첫 구현', BUILD_ORDER BOT-047, ADR-0235, I-T78).
// 메모리 저장소로 본다. PostgreSQL은 test-int/fan-account.int.test.ts.
import { describe, expect, test } from 'vitest';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, type TerminationReason } from '../src/modules/session/domain/session.js';
import { kit, newKey } from './support.js';

async function setup() {
  const sessions = new MemorySessionStore();
  const k = await kit(sessions);
  const login = (sub = 'sub-1') => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: sub, email: null, emailVerified: false, deviceId: 'dev-a' });
  return { sessions, k, login };
}

const end = (sessions: MemorySessionStore, id: string, reason: TerminationReason, now: number) => sessions.transaction((tx) => tx.terminateSessions([id], reason, now));

describe('갱신 401의 세션 종료 사유(I-T78)', () => {
  for (const reason of ['LOGOUT', 'DEVICE_LIMIT', 'REFRESH_REUSE', 'DELETE', 'MERGED', 'LOGIN_METHOD_CHANGED'] as const) {
    test(`I-T78_① 세션이 ${reason}로 끝났으면 갱신 거절에 그 까닭이 실린다 [ASVS v5.0.0-7.4.1]`, async () => {
      const { sessions, k, login } = await setup();
      const s = await login();
      await end(sessions, s.sessionId, reason, k.clock.now());
      expect(await k.refresh.run({ refreshToken: s.refreshToken })).toEqual({ result: 'INVALID', ended: reason });
    });
  }

  test('I-T78_② 재사용을 찾아낸 응답은 REFRESH_REUSE를 싣고, 그 뒤 같은 토큰도 같다 [ASVS v5.0.0-7.4.1]', async () => {
    const { k, login } = await setup();
    const s = await login();
    const next = await k.refresh.run({ refreshToken: s.refreshToken });
    if (next.result !== 'OK') throw new Error('갱신 실패');
    k.clock.advance(31_000);
    expect(await k.refresh.run({ refreshToken: s.refreshToken })).toEqual({ result: 'REUSED', ended: 'REFRESH_REUSE' });
    expect(await k.refresh.run({ refreshToken: next.refreshToken })).toEqual({ result: 'INVALID', ended: 'REFRESH_REUSE' });
  });

  test('I-T78_③ 모르는 토큰·모양이 틀린 토큰·유휴·절대 만료는 까닭을 싣지 않는다', async () => {
    const { k, login } = await setup();
    expect(await k.refresh.run({ refreshToken: 'x'.repeat(43) })).toEqual({ result: 'INVALID' });
    expect(await k.refresh.run({ refreshToken: 'short' })).toEqual({ result: 'INVALID' });
    const idle = await login('sub-idle');
    k.clock.advance(SESSION_IDLE_MS + 1);
    expect(await k.refresh.run({ refreshToken: idle.refreshToken })).toEqual({ result: 'INVALID' });
    const abs = await login('sub-abs');
    k.clock.advance(SESSION_ABSOLUTE_MS + 1);
    expect(await k.refresh.run({ refreshToken: abs.refreshToken })).toEqual({ result: 'INVALID' });
  });

  test('I-T78_④ 탈퇴·병합된 계정의 남은 세션은 계정 상태에 맞는 까닭으로 끝나고 그 까닭을 싣는다', async () => {
    const { sessions, k, login } = await setup();
    const a = await login('sub-del');
    await sessions.transaction((tx) => tx.eraseAccount(a.accountId, k.clock.now()));
    expect(await k.refresh.run({ refreshToken: a.refreshToken })).toEqual({ result: 'INVALID', ended: 'DELETE' });
  });

  test('I-T78_④ 병합으로 흡수된 계정의 남은 세션은 MERGED로 끝나고 그 까닭을 싣는다', async () => {
    const { sessions, k, login } = await setup();
    const absorbed = await login('sub-absorbed');
    const primary = await login('sub-primary');
    await sessions.transaction((tx) => tx.mergeAccounts({ mergeId: 'merge-1', primaryAccountId: primary.accountId, absorbedAccountId: absorbed.accountId, mergedProvider: 'kakao', moved: {}, requestedAt: k.clock.now(), now: k.clock.now() }));
    expect(await k.refresh.run({ refreshToken: absorbed.refreshToken })).toEqual({ result: 'INVALID', ended: 'MERGED' });
    // 그 세션도 끝나 다시 보내도 같은 까닭이다
    expect(await k.refresh.run({ refreshToken: absorbed.refreshToken })).toEqual({ result: 'INVALID', ended: 'MERGED' });
  });

  test('I-T78_⑦ 이미 끝난 세션을 다른 까닭으로 또 끝내도 첫 까닭이 남는다', async () => {
    const { sessions, k, login } = await setup();
    const s = await login();
    await end(sessions, s.sessionId, 'LOGIN_METHOD_CHANGED', k.clock.now());
    await end(sessions, s.sessionId, 'DELETE', k.clock.now() + 1);
    expect(await k.refresh.run({ refreshToken: s.refreshToken })).toEqual({ result: 'INVALID', ended: 'LOGIN_METHOD_CHANGED' });
  });
});
