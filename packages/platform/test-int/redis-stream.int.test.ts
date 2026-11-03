// Redis Stream 정리(openspec 변경 add-maintenance-control-and-consumers 결정 15, ADR-0070, docs/data.md §3) — 실제 Valkey 8.1과 node-redis(기본안).
import { createClient } from 'redis';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { STREAM_KEY_TTL_AFTER_SALE_MS, ackAndTrimStream, expireStreamAfterSale, type RedisCommander } from '../src/index.js';
import { startValkey, type ValkeyContainer } from './containers.js';

let valkey: ValkeyContainer;
let client: ReturnType<typeof createClient>;
let redis: RedisCommander;

beforeAll(async () => {
  valkey = await startValkey();
  client = createClient({ url: valkey.url });
  const end = Date.now() + 30_000;
  for (;;) {
    try {
      await client.connect();
      break;
    } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  redis = { sendCommand: (args) => client.sendCommand(args) };
}, 60_000);

afterAll(async () => {
  await client?.quit().catch(() => {});
  valkey?.stop();
});

const KEY = 's:{event:E1}:stream';
const GROUP = 'relay';

test('ADR0070_확인받은항목만지우고_앞항목이확인전이면남긴다', async () => {
  await redis.sendCommand(['XGROUP', 'CREATE', KEY, GROUP, '$', 'MKSTREAM']);
  const ids: string[] = [];
  for (let i = 1; i <= 4; i += 1) ids.push(String(await redis.sendCommand(['XADD', KEY, '*', 'n', String(i)])));
  // 릴레이가 넷을 읽었다(모두 확인 전 목록에 든다)
  await redis.sendCommand(['XREADGROUP', 'GROUP', GROUP, 'relay-1', 'COUNT', '10', 'STREAMS', KEY, '>']);
  const len = async () => Number(await redis.sendCommand(['XLEN', KEY]));

  // 2·3만 Kafka 확인을 받았다: 1이 아직 확인 전이라 아무것도 지우지 않는다
  const a = await ackAndTrimStream(redis, { key: KEY, group: GROUP, ids: [ids[1]!, ids[2]!] });
  expect(a).toMatchObject({ acked: 2, trimmed: 0, minId: ids[0] });
  expect(await len()).toBe(4);

  // 1까지 확인받으면 1·2·3이 지워지고 확인 전인 4는 남는다
  const b = await ackAndTrimStream(redis, { key: KEY, group: GROUP, ids: [ids[0]!] });
  expect(b.acked).toBe(1);
  expect(b.minId).toBe(ids[3]);
  expect(await len()).toBe(1);

  // 4도 확인받으면 비고, 그 뒤에 들어온 항목은 남는다
  const late = String(await redis.sendCommand(['XADD', KEY, '*', 'n', '5']));
  await ackAndTrimStream(redis, { key: KEY, group: GROUP, ids: [ids[3]!] });
  const left = (await redis.sendCommand(['XRANGE', KEY, '-', '+'])) as [string, string[]][];
  expect(left.map((e) => e[0])).toEqual([late]);
});

test('ADR0070_키는판매종료더하기1일에만료된다', async () => {
  const saleEnd = Date.now() + 60 * 60_000;
  await redis.sendCommand(['XADD', 's:{event:E2}:stream', '*', 'n', '1']);
  await expireStreamAfterSale(redis, 's:{event:E2}:stream', saleEnd);
  const at = Number(await redis.sendCommand(['PEXPIRETIME', 's:{event:E2}:stream']));
  expect(at).toBe(saleEnd + STREAM_KEY_TTL_AFTER_SALE_MS);
});
