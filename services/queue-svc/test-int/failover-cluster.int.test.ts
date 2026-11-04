// 장애 전환 알아채기를 클러스터 모드 Valkey(노드 하나가 모든 슬롯)로 돈다(ADR-0181). 단일 노드 시험(entry-store.int.test.ts)은 노드 표지가
// 'standalone'이라 설정 세대를 볼 수 없어서다. 옛 주 노드가 다시 오르거나 중간 주 노드의 RB-05를 잃은 경우는 세대 키에 옛 표지를 써서 흉내 낸다.
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { RedisEntryStore, keys } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
import { EnterQueue } from '../src/modules/entry/application/enter-queue.js';
import { ACCOUNT, DEVICE, newEvent, newRequest, openSchedule, preverifyToken, tokens } from '../test/support.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const CONFIG_EPOCH = 5;
const SKIP = 10;

let valkey: ValkeyContainer;
let redis: HotRedis;
let myId: string;

beforeAll(async () => {
  valkey = await startValkey({ cluster: true, configEpoch: CONFIG_EPOCH });
  redis = await createHotRedis({ url: valkey.url });
  myId = String(await redis.command(['CLUSTER', 'MYID'], { key: 'x' }));
});

afterAll(async () => {
  await redis?.close();
  valkey?.stop();
});

const cmd = (key: string, args: string[]) => redis.command(args, { key });

async function open(): Promise<{ eventId: string; go: (i: number) => Promise<unknown>; settled: () => Promise<void> }> {
  const eventId = newEvent();
  const s = openSchedule(Date.now());
  const k = keys.cfg(eventId);
  await cmd(k, ['HSET', k, 'opensAtMs', String(s.opensAtMs), 'startsAtMs', String(s.startsAtMs), 'lobbyShuffle', '0', 'openBatch', '1', 'rev', '1', 'batchWindowMs', '1']);
  const enter = new EnterQueue(new RedisEntryStore(redis), new RedisEventSchedules(redis, systemClock), tokens, systemClock, { pendingTtlMs: 300, rb05SkipBase: SKIP });
  const go = (i: number) =>
    enter.run({ accountId: ACCOUNT, pid: `pid-cl-${i}-${eventId}`.slice(0, 64), eventId, body: { preverifyToken: preverifyToken(systemClock, eventId), deviceId: DEVICE, entryRequestId: newRequest() } });
  return { eventId, go, settled: () => enter.confirmsSettled() };
}
const node = async (eventId: string) => String(await cmd(keys.epoch(eventId), ['HGET', keys.epoch(eventId), 'node']));
/** 세대 키에 옛 표지를 쓴다. 실제 승격은 몇 초가 걸리므로 마지막으로 설정 세대까지 견준 초(chk)도 지난 값으로 둔다 */
const older = (eventId: string, value: string) => cmd(keys.epoch(eventId), ['HSET', keys.epoch(eventId), 'node', value, 'chk', '0']);
const skipped = async (eventId: string) => ((await cmd(keys.skipped(eventId), ['LRANGE', keys.skipped(eventId), '0', '-1'])) as unknown[]).map(String);

test('클러스터모드의세대키는_노드ID와설정세대이고_설정세대까지견준초를적어둔다', async () => {
  const { eventId, go } = await open();
  await go(0);
  expect(await node(eventId)).toBe(`${myId}:${CONFIG_EPOCH}`);
  const chk = Number(await cmd(keys.epoch(eventId), ['HGET', keys.epoch(eventId), 'chk']));
  expect(Math.abs(chk - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(1);
});

test('같은초에는노드ID만견주지만_다른노드ID면그초에도알아챈다', async () => {
  const { eventId, go } = await open();
  await go(0);
  // chk는 이번 초 그대로 두고 노드 ID만 다른 값으로: 주 노드가 바뀐 것이다
  await cmd(keys.epoch(eventId), ['HSET', keys.epoch(eventId), 'node', `0123456789abcdef0123456789abcdef01234567:${CONFIG_EPOCH}`]);
  await expect(go(1)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
});

test('옛주노드가다시주노드가되면_노드ID가같아도설정세대가달라_알아채고RB05를돈다', async () => {
  const { eventId, go } = await open();
  await go(0);
  await older(eventId, `${myId}:${CONFIG_EPOCH - 1}`);
  await expect(go(1)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  expect(await skipped(eventId)).toEqual([`2:${1 + SKIP}:1`]);
  expect(await node(eventId)).toBe(`${myId}:${CONFIG_EPOCH}`);
});

test('[Q-T13] 설정세대가여럿올라도_곱하지않고바탕값만건너뛰며_붙은복제본이없으면바로확인해다음진입이번호를받는다(ADR-0186)', async () => {
  const { eventId, go, settled } = await open();
  await go(0);
  // 세대 키는 두 번 전의 주 노드가 쓴 그대로다. RB-05는 복제를 확인한 뒤에만 번호를 내므로 사이 주 노드가 낸 번호가 없다
  await older(eventId, `0123456789abcdef0123456789abcdef01234567:${CONFIG_EPOCH - 4}`);
  await expect(go(1)).rejects.toMatchObject({ code: 'QUEUE_RECOVERING' });
  expect(await skipped(eventId)).toEqual([`2:${1 + SKIP}:1`]);
  // 복제 확인은 요청 밖에서 돈다(요청은 기다리지 않고 바로 503): 끝나기를 기다린 뒤에 표시가 지워졌다
  await settled();
  expect(await cmd(keys.epoch(eventId), ['HGET', keys.epoch(eventId), 'pend'])).toBeNull();
  await expect(go(2)).resolves.toMatchObject({ kind: 'TICKET', seq: 2 + SKIP, generation: 2 });
});
