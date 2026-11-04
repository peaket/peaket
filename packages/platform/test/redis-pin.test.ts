// pin 옵션(ADR-0186 클러스터 실측): node-redis 6.3 클러스터는 WAIT·INFO·CLIENT INFO를 명령 정책에 따라 모든 샤드나 아무 노드로 보내 key를 무시한다.
// pin을 주면 raw.send의 네 번째 인자로 넘어가 클러스터 연결이 key 슬롯의 주 노드 한 곳으로 보낸다. 실제 클러스터 라우팅은 queue-svc의 실측(test-sim/pin-routing)이 본다
import { ClientOfflineError } from 'redis';
import { describe, expect, test } from 'vitest';
import { hotRedisOver, type RawRedis } from '../src/redis.js';

function raw(send: RawRedis['send']): RawRedis & { calls: Array<{ key: string | undefined; args: string[]; binary?: boolean; pin?: boolean }> } {
  const calls: Array<{ key: string | undefined; args: string[]; binary?: boolean; pin?: boolean }> = [];
  return {
    calls,
    send: async (key, args, binary, pin) => {
      calls.push({ key, args, ...(binary ? { binary } : {}), ...(pin ? { pin } : {}) });
      return send(key, args, binary, pin);
    },
    close: async () => {},
    destroy: () => {},
  };
}

const noSleep = { sleep: async () => {} };

describe('pin', () => {
  test('pin을주면_raw에pin으로넘기고_주지않으면넘기지않는다', async () => {
    const r = raw(async () => 1);
    const redis = hotRedisOver(r, noSleep);
    await redis.command(['WAIT', '1', '500'], { key: 'q:{event:E}:epoch', pin: true, deadlineMs: 800 });
    await redis.command(['GET', 'k'], { key: 'k' });
    expect(r.calls).toEqual([
      { key: 'q:{event:E}:epoch', args: ['WAIT', '1', '500'], pin: true },
      { key: 'k', args: ['GET', 'k'] },
    ]);
  });

  test('연결이끊겨다시보낼때도_pin을그대로둔다', async () => {
    let n = 0;
    const r = raw(async () => {
      if (++n === 1) throw new ClientOfflineError();
      return 'OK';
    });
    await expect(hotRedisOver(r, noSleep).command(['INFO', 'replication'], { key: 'k', pin: true })).resolves.toBe('OK');
    expect(r.calls.map((c) => c.pin)).toEqual([true, true]);
  });
});
