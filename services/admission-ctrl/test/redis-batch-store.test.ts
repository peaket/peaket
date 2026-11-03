// 묶음 기록 Valkey 어댑터의 나눠 읽기와 다시 보내기(2026-11-03 새 맥락 리뷰): 큰 묶음을 SSCAN으로 읽고 겹침을 빼며,
// 결과 쓰기 덩어리가 잠시 안 되면 그 덩어리만 다시 보낸다. 버그(스크립트 오류 같은)는 다시 보내지 않는다
import { type HotRedis, RedisDeadlineError } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { keys, RedisBatchStore } from '../src/modules/batch/adapters/redis-batch-store.js';

function fake(command: (args: string[]) => Promise<unknown>): HotRedis {
  return { command, evalScript: async () => 0, sendCommand: async () => null, close: async () => {} };
}

describe('참가자 읽기', () => {
  test('SSCAN을커서가0이될때까지부르고_겹친원소는한번만준다', async () => {
    const seen: string[][] = [];
    const pages: Record<string, [string, string[]]> = { '0': ['17', ['a', 'b']], '17': ['9', ['b', 'c']], '9': ['0', ['d']] };
    const store = new RedisBatchStore(
      fake(async (args) => {
        seen.push(args);
        return pages[args[2]!];
      }),
    );
    expect((await store.members('e1', 1)).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(seen.map((a) => a.slice(0, 3))).toEqual([
      ['SSCAN', keys.batchMembers('e1', 1), '0'],
      ['SSCAN', keys.batchMembers('e1', 1), '17'],
      ['SSCAN', keys.batchMembers('e1', 1), '9'],
    ]);
    expect(seen.every((a) => a[3] === 'COUNT' && Number(a[4]) <= 1000)).toBe(true);
  });
});

describe('결과 쓰기', () => {
  const entries = Array.from({ length: 2_500 }, (_, i) => ({ tokenHash: i.toString(16).padStart(64, '0'), seq: i + 1 }));

  test('덩어리가잠시안되면_그덩어리만다시보내모두쓴다', async () => {
    const written = new Map<string, string>();
    let failed = false;
    const store = new RedisBatchStore(
      fake(async (args) => {
        if (!failed && args[1] === keys.batchResult(entries[1_500]!.tokenHash)) {
          failed = true;
          throw new RedisDeadlineError(100);
        }
        written.set(args[1]!, args[2]!);
        return 'OK';
      }),
    );
    await store.writeResults(entries, 2, 1);
    expect(failed).toBe(true);
    expect(written.size).toBe(entries.length);
    expect(written.get(keys.batchResult(entries[1_500]!.tokenHash))).toBe('1501:2');
  });

  test('버그는_다시보내지않고그대로던진다', async () => {
    let calls = 0;
    const bug = new Error('ERR wrong number of arguments');
    const store = new RedisBatchStore(
      fake(async () => {
        calls++;
        throw bug;
      }),
    );
    await expect(store.writeResults(entries.slice(0, 10), 1, 1)).rejects.toBe(bug);
    expect(calls).toBe(10);
  });
});
