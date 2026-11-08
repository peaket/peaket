// 닉네임 확인의 세션별 요청 수(세션·캐시 Redis id:nick, ADR-0235 결정 5, BUILD_ORDER BOT-047, I-T80). 실제 Valkey는 test-int/nickname-check-limits.int.test.ts.
import { type HotRedis, RedisDeadlineError } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { nicknameCheckKey, RedisNicknameCheckLimits } from '../src/modules/session/adapters/redis-nickname-check-limits.js';
import { NICKNAME_CHECK_LIMIT, NICKNAME_CHECK_WINDOW_MS } from '../src/modules/session/domain/signup.js';

function fake(reply: () => unknown) {
  const calls: { keys: string[]; args: string[] }[] = [];
  const commands: string[][] = [];
  const redis = {
    evalScript: async (_s: unknown, keys: string[], args: string[]) => {
      calls.push({ keys, args });
      return reply();
    },
    command: async (args: string[]) => {
      commands.push(args);
      return null;
    },
  } as unknown as HotRedis;
  return { redis, calls, commands };
}

describe('RedisNicknameCheckLimits(I-T80)', () => {
  test('I-T80_⑤ 세기와 수명 걸기는 스크립트 한 번이다(수명 없는 키가 남지 않게)', async () => {
    const f = fake(() => [1, NICKNAME_CHECK_WINDOW_MS]);
    expect(await new RedisNicknameCheckLimits(f.redis).allow('s-1')).toEqual({ allowed: true });
    expect(f.calls).toEqual([{ keys: [nicknameCheckKey('s-1')], args: [String(NICKNAME_CHECK_WINDOW_MS)] }]);
    expect(f.commands).toEqual([]);
  });

  test('I-T80_⑤ 한도를 넘으면 남은 시간을 돌려준다', async () => {
    const f = fake(() => [NICKNAME_CHECK_LIMIT + 1, 12_345]);
    expect(await new RedisNicknameCheckLimits(f.redis).allow('s-1')).toEqual({ allowed: false, retryAfterMs: 12_345 });
  });

  test('I-T80_⑤ 저장소에 닿지 못하면 통과시킨다', async () => {
    const f = fake(() => {
      throw new RedisDeadlineError(30);
    });
    expect(await new RedisNicknameCheckLimits(f.redis).allow('s-1')).toEqual({ allowed: true });
  });

  test('I-T80_⑤ 닿지 못한 것이 아닌 오류는 그대로 던진다', async () => {
    const f = fake(() => {
      throw new Error('ERR 스크립트 오류');
    });
    await expect(new RedisNicknameCheckLimits(f.redis).allow('s-1')).rejects.toThrow('스크립트 오류');
  });
});
