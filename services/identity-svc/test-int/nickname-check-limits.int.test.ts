// 닉네임 확인의 세션별 요청 수를 실제 Valkey에서 본다(세션·캐시 Redis id:nick, ADR-0235 결정 5, BUILD_ORDER BOT-047, I-T80).
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { nicknameCheckKey, RedisNicknameCheckLimits } from '../src/modules/session/adapters/redis-nickname-check-limits.js';
import { NICKNAME_CHECK_LIMIT, NICKNAME_CHECK_WINDOW_MS } from '../src/modules/session/domain/signup.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let vk: ValkeyContainer;
let redis: HotRedis;

beforeAll(async () => {
  vk = await startValkey();
  redis = await createHotRedis({ url: vk.url });
});

afterAll(async () => {
  await redis?.close();
  vk?.stop();
});

test('I-T80_⑤ 첫 요청부터 키에 수명이 걸리고 31번째는 남은 시간과 함께 거절된다', async () => {
  const limits = new RedisNicknameCheckLimits(redis);
  const key = nicknameCheckKey('session-a');
  expect(await limits.allow('session-a')).toEqual({ allowed: true });
  const ttl = Number(await redis.command(['PTTL', key], { key }));
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(NICKNAME_CHECK_WINDOW_MS);
  for (let i = 1; i < NICKNAME_CHECK_LIMIT; i++) expect((await limits.allow('session-a')).allowed).toBe(true);
  const over = await limits.allow('session-a');
  expect(over.allowed).toBe(false);
  if (!over.allowed) expect(over.retryAfterMs).toBeGreaterThan(0);
});

test('I-T80_⑤ 수명 없이 남은 키도 다음 요청에서 수명을 얻는다', async () => {
  const key = nicknameCheckKey('session-b');
  await redis.command(['SET', key, '3'], { key });
  await new RedisNicknameCheckLimits(redis).allow('session-b');
  expect(Number(await redis.command(['PTTL', key], { key }))).toBeGreaterThan(0);
});
