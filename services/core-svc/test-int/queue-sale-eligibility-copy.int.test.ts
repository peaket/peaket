// 판매 자격 명단의 대기열 Redis 사본 통합 시험(ADR-0261 결정 9·12, BUILD_ORDER BAT-158, Q-T36 ⑦).
// 실제 Valkey 8.1 컨테이너에 임시 키·판 비교 Lua·수명·지우기 판을 잇는다.
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { QueueSaleEligibilityCopy } from '../src/modules/catalog/adapters/queue-sale-eligibility-copy.js';
import { startValkey, type ValkeyContainer } from '../../queue-svc/test-int/valkey.js';

let valkey: ValkeyContainer;
let redis: HotRedis;
let copy: QueueSaleEligibilityCopy;
const cmd = (args: string[]) => redis.command(args, { deadlineMs: 5_000 });
const EVENT = 'e-1';
const LIST = 'fanclub';
const KEY = `q:${EVENT}:elig:${LIST}`;
const VKEY = `${KEY}:v`;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  copy = new QueueSaleEligibilityCopy(redis);
}, 120_000);

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

const put = (version: number, accountIds: string[], expiresAt = new Date('2027-01-01T00:00:00Z')) => ({
  productionId: 'p-1',
  eventIds: [EVENT],
  listKey: LIST,
  version,
  accountIds,
  expiresAt,
});
const members = async () => (await cmd(['SMEMBERS', KEY])) as string[];
const versionOf = async () => (await cmd(['GET', VKEY])) as string | null;

describe('대기열 Redis 사본(실제 Valkey)', () => {
  test('1만 개씩 넣고 판이 클 때만 바꾸며 수명은 파기 시각이다', async () => {
    const ids = Array.from({ length: 25_000 }, (_, i) => `a${i}`);
    await copy.put(put(5, ids));
    expect(await cmd(['SCARD', KEY])).toBe(25_000);
    expect(await versionOf()).toBe('5');
    const expiresAt = new Date('2027-01-01T00:00:00Z');
    const expected = expiresAt.getTime() - Date.now();
    const ttl = (await cmd(['PTTL', KEY])) as number;
    expect(Math.abs(ttl - expected)).toBeLessThan(10_000);

    // 같은 판은 덮지 않는다
    await copy.put(put(5, ['same']));
    expect(await members()).not.toContain('same');
    // 옛 판은 덮지 않는다
    await copy.put(put(4, ['old']));
    expect(await members()).not.toContain('old');
    expect(await cmd(['SCARD', KEY])).toBe(25_000);
    expect(await versionOf()).toBe('5');
    // 새 판은 덮는다
    await copy.put(put(6, ['new']));
    expect(await members()).toEqual(['new']);
    expect(await versionOf()).toBe('6');
  });

  test('빈 명단은 본 키를 지우고 판을 올린다', async () => {
    await copy.put(put(7, ['a']));
    await copy.put(put(8, []));
    expect(await cmd(['EXISTS', KEY])).toBe(0);
    expect(await versionOf()).toBe('8');
  });

  test('지우기는 그 판 이하일 때만 한다', async () => {
    await copy.put(put(10, ['a']));
    await copy.drop({ eventIds: [EVENT], listKey: LIST, version: 9 });
    expect(await cmd(['EXISTS', KEY])).toBe(1);
    await copy.drop({ eventIds: [EVENT], listKey: LIST, version: 10 });
    expect(await cmd(['EXISTS', KEY])).toBe(0);
    expect(await cmd(['EXISTS', VKEY])).toBe(0);
  });
});
