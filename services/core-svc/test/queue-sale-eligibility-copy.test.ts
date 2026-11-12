// 대기열 Redis 사본 어댑터 시험(Q-T36 ⑦, ADR-0261 결정 9): 임시 키·판 비교·지우기 판·수명.
import { describe, expect, test } from 'vitest';
import { QueueSaleEligibilityCopy, type QueueRedis } from '../src/modules/catalog/adapters/queue-sale-eligibility-copy.js';

class FakeRedis implements QueueRedis {
  sets = new Map<string, Set<string>>();
  versions = new Map<string, number>();
  ttl = new Map<string, number>();
  batches: number[] = [];
  closed = false;

  async command(args: string[]): Promise<unknown> {
    const [op, key, ...rest] = args;
    if (op === 'SADD') {
      this.batches.push(rest.length);
      const s = this.sets.get(key!) ?? new Set<string>();
      for (const v of rest) s.add(v);
      this.sets.set(key!, s);
      return rest.length;
    }
    if (op === 'DEL') {
      this.sets.delete(key!);
      this.versions.delete(key!);
      return 1;
    }
    if (op === 'PEXPIREAT') {
      this.ttl.set(key!, Number(rest[0]));
      return 1;
    }
    if (op === 'EVAL') {
      const script = key!;
      const n = Number(rest[0]);
      const keys = rest.slice(1, 1 + n);
      const argv = rest.slice(1 + n);
      if (script.includes('RENAME')) {
        const [temp, final, ver] = keys as [string, string, string];
        const v = Number(argv[0]);
        const cur = this.versions.get(final) ?? -1;
        if (cur >= v) {
          this.sets.delete(temp);
          return 0;
        }
        const set = this.sets.get(temp);
        if (set) this.sets.set(final, set);
        this.sets.delete(temp);
        this.versions.set(final, v);
        this.versions.set(ver, v);
        this.ttl.set(final, Number(argv[1]));
        return 1;
      }
      if (script.includes("redis.call('DEL', KEYS[1])") && script.includes('PEXPIREAT')) {
        const [final, ver] = keys as [string, string];
        const v = Number(argv[0]);
        const cur = this.versions.get(final) ?? -1;
        if (cur >= v) return 0;
        this.sets.delete(final);
        this.versions.set(ver, v);
        this.ttl.set(ver, Number(argv[1]));
        return 1;
      }
      if (script.includes('redis.call') && script.includes('DEL')) {
        const [final, ver] = keys as [string, string];
        const v = Number(argv[0]);
        if ((this.versions.get(final) ?? -1) > v) return 0;
        this.sets.delete(final);
        this.versions.delete(final);
        this.versions.delete(ver);
        return 1;
      }
      return 0;
    }
    throw new Error(`모르는 명령 ${op}`);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const put = (v: number, ids: string[], at = new Date('2027-01-01T00:00:00Z')) => ({ productionId: 'p', eventIds: ['E1'], listKey: 'fanclub', version: v, accountIds: ids, expiresAt: at });

describe('대기열 Redis 사본', () => {
  test('1만 개씩 넣고 판이 클 때만 바꾸며 수명은 파기 시각이다', async () => {
    const r = new FakeRedis();
    const c = new QueueSaleEligibilityCopy(r);
    const ids = Array.from({ length: 25_000 }, (_, i) => `a${i}`);
    await c.put(put(5, ids));
    expect(r.batches).toEqual([10_000, 10_000, 5_000]);
    expect(r.sets.get('q:e1:elig:fanclub')?.size).toBe(25_000);
    expect(r.versions.get('q:e1:elig:fanclub')).toBe(5);
    expect(r.ttl.get('q:e1:elig:fanclub')).toBe(new Date('2027-01-01T00:00:00Z').getTime());
    // 옛 판은 덮지 않는다
    await c.put(put(4, ['old']));
    expect(r.sets.get('q:e1:elig:fanclub')?.has('old')).toBe(false);
    expect(r.sets.get('q:e1:elig:fanclub')?.size).toBe(25_000);
    // 새 판은 덮는다
    await c.put(put(6, ['new']));
    expect([...(r.sets.get('q:e1:elig:fanclub') ?? [])]).toEqual(['new']);
  });

  test('빈 명단은 본 키를 지우고 판을 올린다', async () => {
    const r = new FakeRedis();
    const c = new QueueSaleEligibilityCopy(r);
    await c.put(put(3, ['a']));
    await c.put(put(4, []));
    expect(r.sets.get('q:e1:elig:fanclub')).toBeUndefined();
    expect(r.versions.get('q:e1:elig:fanclub:v')).toBe(4);
  });

  test('지우기는 그 판 이하일 때만 한다', async () => {
    const r = new FakeRedis();
    const c = new QueueSaleEligibilityCopy(r);
    await c.put(put(7, ['a']));
    await c.drop({ eventIds: ['E1'], listKey: 'fanclub', version: 6 });
    expect(r.sets.has('q:e1:elig:fanclub')).toBe(true);
    await c.drop({ eventIds: ['E1'], listKey: 'fanclub', version: 7 });
    expect(r.sets.has('q:e1:elig:fanclub')).toBe(false);
  });

  test('같은 판은 덮지 않고, 지우기는 판 키도 지운다', async () => {
    const r = new FakeRedis();
    const c = new QueueSaleEligibilityCopy(r);
    await c.put(put(5, ['a']));
    await c.put(put(5, ['b']));
    expect([...(r.sets.get('q:e1:elig:fanclub') ?? [])]).toEqual(['a']);
    expect(r.versions.get('q:e1:elig:fanclub:v')).toBe(5);
    await c.drop({ eventIds: ['E1'], listKey: 'fanclub', version: 5 });
    expect(r.sets.has('q:e1:elig:fanclub')).toBe(false);
    expect(r.versions.has('q:e1:elig:fanclub:v')).toBe(false);
  });

  test('닫기는 Redis 연결을 닫는다', async () => {
    const r = new FakeRedis();
    await new QueueSaleEligibilityCopy(r).close();
    expect(r.closed).toBe(true);
  });
});
