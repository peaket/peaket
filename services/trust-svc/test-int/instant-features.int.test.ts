// 통합 시험: 요청 때 세는 판정 피처의 키를 실제 Valkey로 본다(docs/features/bot-defense.md §3.2·§4.9, docs/data.md §3, B-T22·B-T23, ADR-0251).
import { createHotRedis, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { keys, RedisFeatureStore } from '../src/modules/scoring/adapters/redis-feature-store.js';
import { ScoreRisk } from '../src/modules/scoring/application/score-risk.js';
import { parseRuleSet } from '../src/modules/scoring/domain/rules.js';
import { DEVICE_ID, recordingBehaviors, recordingHuman, recordingRecorder, recordingSignals, request, SYNTHETIC_RULES_JSON } from '../test/support.js';
import { startValkey } from './valkey.js';

const slow = (key: string) => ({ key, deadlineMs: 5_000 });
const valkey = startValkey();
let redis: HotRedis;
let store: RedisFeatureStore;
const MIN = 60_000;

beforeAll(async () => {
  redis = await createHotRedis({ url: valkey.url });
  store = new RedisFeatureStore(redis);
});
afterAll(async () => {
  await redis?.close();
  valkey.stop();
});

const card = (k: string) => redis.command(['SCARD', k], slow(k)).then(Number);
const pttl = (k: string) => redis.command(['PTTL', k], slow(k)).then(Number);
const exists = (k: string) => redis.command(['EXISTS', k], slow(k)).then(Number);

const share = async (deviceRef: string, pid: string, eventId = 'ev-1') => (await store.read({ deviceRef, pid, now: Date.now(), shareEventId: eventId })).shared;

describe('B-T22 기기 공유 수 키', () => {
  test('[ASVS v5.0.0-2.4.1] B-T22①③_서로다른pid를세고_같은pid는한번이며_겹쳐와도상한20을넘지않고_상한이상은같게본다', async () => {
    const ref = 'k1.share-cap';
    const k = keys.devShare(ref, 'ev-1');
    expect(await share(ref, 'p-0')).toBe(1);
    expect(await share(ref, 'p-0')).toBe(1);
    const counts = await Promise.all(Array.from({ length: 40 }, (_, n) => share(ref, `p-${n + 1}`)));
    expect(await card(k)).toBe(20);
    expect(Math.max(...counts.map(Number))).toBe(20);
    expect(await share(ref, 'p-late')).toBe(20);
    expect(await card(k)).toBe(20);
  });

  test('B-T22④_수명은첫원소때10분이고_뒤원소가늘리지않는다', async () => {
    const ref = 'k1.share-ttl';
    const k = keys.devShare(ref, 'ev-1');
    await share(ref, 'p-1');
    const ttl = await pttl(k);
    expect(ttl).toBeGreaterThan(9 * MIN);
    expect(ttl).toBeLessThanOrEqual(10 * MIN);
    await redis.command(['PEXPIRE', k, '5000'], slow(k));
    await share(ref, 'p-2');
    expect(await pttl(k)).toBeLessThanOrEqual(5_000);
    await share(ref, 'p-2');
    expect(await pttl(k)).toBeLessThanOrEqual(5_000);
  });

  test('B-T22④_실제로만료된뒤에넣으면새키가다시10분을산다', async () => {
    const ref = 'k1.share-expired';
    const k = keys.devShare(ref, 'ev-1');
    await share(ref, 'p-1');
    await redis.command(['PEXPIRE', k, '20'], slow(k));
    for (let i = 0; i < 200 && (await exists(k)) === 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await exists(k)).toBe(0);
    expect(await share(ref, 'p-2')).toBe(1);
    expect(await card(k)).toBe(1);
    const ttl = await pttl(k);
    expect(ttl).toBeGreaterThan(9 * MIN);
    expect(ttl).toBeLessThanOrEqual(10 * MIN);
  });

  test('B-T22②_판정으로키가실제로쌓이고_사람확인에실패한요청도들어간다', async () => {
    const clock = fakeClock({ now: Date.now() });
    const human = recordingHuman();
    const pending: Promise<unknown>[] = [];
    const score = new ScoreRisk({
      rules: { current: () => parseRuleSet(SYNTHETIC_RULES_JSON), intensity: () => 'BASE' },
      human,
      features: store,
      devices: { ref: () => 'k1.score' },
      asn: { classify: () => 'OTHER' },
      recorder: recordingRecorder(),
      behaviors: recordingBehaviors(),
      signals: recordingSignals(),
      clock,
      after: (w) => void pending.push(w()),
    });
    await score.run(request({ eventId: 'ev-score', pid: 'pid-a', deviceId: DEVICE_ID }));
    const k = keys.devShare('k1.score', 'ev-score');
    expect(await card(k)).toBe(1);
    human.set('FAILED');
    await score.run(request({ eventId: 'ev-score', pid: 'pid-b', deviceId: DEVICE_ID }));
    expect(await card(k)).toBe(2);
    await Promise.all(pending);
  });
});

describe('B-T23 호스팅·프록시 대역 진입 수 키', () => {
  const now = Date.now();
  const bucket = Math.floor(now / 10_000);

  test('[ASVS v5.0.0-2.4.1] B-T23①③④_10초칸으로세고_칸이바뀌면다시세며_수명은30초다', async () => {
    const entry = { asn: 16509, eventId: 'ev-h' };
    const a = await store.read({ deviceRef: undefined, pid: '', now, hostEntry: entry });
    const b = await store.read({ deviceRef: undefined, pid: '', now, hostEntry: entry });
    expect([a.hostEntries, b.hostEntries]).toEqual([1, 2]);
    const k = keys.asnHost(16509, 'ev-h', bucket);
    const ttl = await pttl(k);
    expect(ttl).toBeGreaterThan(20_000);
    expect(ttl).toBeLessThanOrEqual(30_000);
    const next = await store.read({ deviceRef: undefined, pid: '', now: now + 10_000, hostEntry: entry });
    expect(next.hostEntries).toBe(1);
    expect(await redis.command(['GET', k], slow(k))).toBe('2');
  });
});
