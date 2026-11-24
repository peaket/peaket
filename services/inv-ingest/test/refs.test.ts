// 계정 연결 값 묶음 시험(docs/streaming.md §6.4 '계정의 연결 값', F-04-10).
import { describe, expect, test } from 'vitest';
import { BatchRefResolver, type AccountRefSource, type InvestigationRefs } from '../src/refs.js';

const refs = (n: number): InvestigationRefs => ({ accountId: `acct-${n}`, contactRefs: [`k1.contact-${n}`], deviceRefs: [`k1.device-${n}`], identityConflicts: [] });

describe('ST-T21 계정 연결 값', () => {
  test('ST-T21 ⑨ 계정 연결 값은 500개씩 묻고 10분 캐시·1분 뒤 다시 묻기를 따른다', async () => {
    const calls: string[][] = [];
    let fail = false;
    const source: AccountRefSource = {
      async get(ids) {
        calls.push([...ids]);
        if (fail) throw new Error('identity-svc 없음');
        return ids.map((id) => refs(Number(id.slice(5))));
      },
    };
    let now = 0;
    const r = new BatchRefResolver(source, { clock: () => now });
    const first = await r.resolve(Array.from({ length: 1200 }, (_, i) => `acct-${i}`));
    expect(calls.map((c) => c.length)).toEqual([500, 500, 200]);
    expect(first.size).toBe(1200);
    // 10분 안에는 다시 묻지 않는다
    now = 9 * 60_000;
    await r.resolve(['acct-1']);
    expect(calls).toHaveLength(3);
    // 10분이 지나면 다시 묻는다
    now = 10 * 60_000;
    await r.resolve(['acct-1']);
    expect(calls).toHaveLength(4);
    // 실패하면 캐시에 넣지 않고, 1분 안에는 다시 묻지 않는다
    fail = true;
    now = 20 * 60_000;
    const failed = await r.resolve(['acct-900']);
    expect(failed.size).toBe(0);
    const before = calls.length;
    await r.resolve(['acct-900']);
    expect(calls.length).toBe(before);
    now += 60_000;
    fail = false;
    await r.resolve(['acct-900']);
    expect(calls.length).toBe(before + 1);
  });
});
