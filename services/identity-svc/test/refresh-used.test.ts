// 리프레시 재시도 1회 가드(CONS-07). 재시도는 앞 토큰을 prev에 남기지 않고 refreshUsed를 세워,
// 같은 앞 토큰의 두 번째 재시도를 유예 안이어도 재사용(탈취)으로 판정한다.
import { describe, expect, test } from 'vitest';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { kit, newKey } from './support.js';

describe('리프레시 재시도 1회 [CONS-07]', () => {
  test('재시도 뒤 prev_refresh_hash는 비고 refresh_used가 서며, 같은 앞 토큰의 두 번째 재시도는 REUSED다', async () => {
    const store = new MemorySessionStore();
    const k = await kit(store);
    const s = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `ru-${newKey().slice(0, 8)}`, email: null, deviceId: null });

    expect((await k.refresh.run({ refreshToken: s.refreshToken })).result).toBe('OK');
    expect((await k.refresh.run({ refreshToken: s.refreshToken })).result).toBe('OK');

    const row = store.peekSession(s.sessionId)!;
    expect(row.prevRefreshHash).toBeNull();
    expect(row.refreshUsed).toBe(true);

    k.clock.advance(5_000);
    expect(await k.refresh.run({ refreshToken: s.refreshToken })).toEqual({ result: 'REUSED', ended: 'REFRESH_REUSE' });
    expect(store.peekSession(s.sessionId)?.terminatedAt).toBe(k.clock.now());
  });
});
