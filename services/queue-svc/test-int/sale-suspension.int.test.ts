// BAT-465 R-584 판매 중지 대기열 사본의 실제 Valkey 8.1 통합 시험.
// notice·ctl에 suspended·suspRev·suspCmd만 쓰고, 판매 상태·공지 같은 다른 칸은 건드리지 않는지 본다.
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { keys } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisSaleSuspensionCopies, SetSaleSuspensionCopy } from '../src/modules/sale/index.js';
import { newEvent } from '../test/support.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let redis: HotRedis;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

const hash = async (key: string): Promise<Record<string, string>> => {
  const flat = (await redis.command(['HGETALL', key], { key })) as unknown;
  if (Array.isArray(flat)) {
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = String(flat[i + 1]);
    return out;
  }
  return Object.fromEntries(Object.entries(flat as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
};

describe('BAT-465 판매 중지 대기열 사본 실제 Valkey', () => {
  test('R584_중지와_재개가_notice_ctl에_같은_칸을_쓰고_다른_칸은_둔다', async () => {
    const eventId = newEvent();
    const service = new SetSaleSuspensionCopy(new RedisSaleSuspensionCopies(redis));
    // 판매 상태·공지가 이미 있는 notice에 쓴다
    await redis.command(['HSET', keys.notice(eventId), 'saleState', 'ON_SALE', 'saleVersion', '3', 'banner', '공지'], { key: keys.notice(eventId) });

    const stopId = crypto.randomUUID();
    expect(await service.run({ eventId, action: 'SUSPEND', commandId: stopId, revision: 7 })).toEqual({ eventId, suspended: true, revision: 7 });
    const notice = await hash(keys.notice(eventId));
    expect(notice).toMatchObject({ suspended: '1', suspRev: '7', suspCmd: stopId, saleState: 'ON_SALE', saleVersion: '3', banner: '공지' });
    expect(await hash(keys.ctl(eventId))).toMatchObject({ suspended: '1', suspRev: '7', suspCmd: stopId });
    const ttl = Number(await redis.command(['PTTL', keys.notice(eventId)], { key: keys.notice(eventId) }));
    expect(ttl).toBeGreaterThan(0);

    const resumeId = crypto.randomUUID();
    expect(await service.run({ eventId, action: 'RESUME', commandId: resumeId, revision: 8 })).toEqual({ eventId, suspended: false, revision: 8 });
    expect(await hash(keys.notice(eventId))).toMatchObject({ suspended: '0', suspRev: '8', suspCmd: resumeId });
    expect(await hash(keys.ctl(eventId))).toMatchObject({ suspended: '0', suspRev: '8' });
  });

  test('R584_같은_값으로_여러_번_써도_같다', async () => {
    const eventId = newEvent();
    const service = new SetSaleSuspensionCopy(new RedisSaleSuspensionCopies(redis));
    const commandId = crypto.randomUUID();
    await service.run({ eventId, action: 'SUSPEND', commandId, revision: 1 });
    await service.run({ eventId, action: 'SUSPEND', commandId, revision: 1 });
    expect(await hash(keys.notice(eventId))).toMatchObject({ suspended: '1', suspRev: '1', suspCmd: commandId });
  });
});
