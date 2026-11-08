// 셔플 검증 정보의 읽기를 실제 Valkey 8.1로 본다(공시 기록과 게시 표시를 같은 슬롯 Lua 하나로 읽는다, ADR-0232 결정 8)
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { RedisShuffleProofSource } from '../src/modules/state/adapters/shuffle-proof-sources.js';
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

test('POL-005 공시 기록과 게시 표시를 칸 원문으로 읽고, 없는 회차는 빈 칸이다', async () => {
  const e = newEvent();
  const shuffleKey = `q:{event:${e}}:shuffle`;
  const doneKey = `q:{event:${e}}:batch_done`;
  await redis.command(['HSET', shuffleKey, 'commit:lobby', 'aa', 'round:lobby', '9', 'chain', 'quicknet'], { key: shuffleKey });
  await redis.command(['HSET', doneKey, 'lobby', '1:5:1', 'root:lobby', 'bb'], { key: doneKey });
  const source = new RedisShuffleProofSource(redis);
  expect(await source.read(e)).toEqual({ shuffle: { 'commit:lobby': 'aa', 'round:lobby': '9', chain: 'quicknet' }, done: { lobby: '1:5:1', 'root:lobby': 'bb' } });
  expect(await source.read(newEvent())).toEqual({ shuffle: {}, done: {} });
});
