// 통합 시험: 기기 가명을 AWS 흉내 서버 moto 5.2.5의 KMS HMAC 키와 실제 Valkey로 끝까지 본다(docs/features/bot-defense.md §3.2·§4.9, B-T16·B-T24, ADR-0171·0250).
// 실제 AWS 계정·실제 키를 쓰지 않는다. identity-svc는 같은 라벨 키 링으로 같은 식을 계산한다(services/identity-svc/test-int/investigation.int.test.ts I-T63).
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { CreateKeyCommand, GenerateMacCommand, KMSClient } from '@aws-sdk/client-kms';
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { deviceRefsFromEnv } from '../src/modules/scoring/adapters/device-refs.js';
import { kmsMacClient } from '../src/modules/scoring/adapters/kms-mac-client.js';
import { keys, RedisFeatureStore } from '../src/modules/scoring/adapters/redis-feature-store.js';
import { ScoreRisk } from '../src/modules/scoring/application/score-risk.js';
import { parseRuleSet } from '../src/modules/scoring/domain/rules.js';
import { recordingBehaviors, recordingHuman, recordingRecorder, recordingSignals, request, SYNTHETIC_RULES_JSON } from '../test/support.js';
import { startValkey } from './valkey.js';

const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const creds = { accessKeyId: 'test', secretAccessKey: 'test' };
const region = 'ap-northeast-2';
const DEVICE = 'AQEBAQEBAQEBAQEBAQEBAQ';
const slow = (key: string) => ({ key, deadlineMs: 5_000 });

let motoId: string;
let endpoint: string;
let keyId: string;
let kms: KMSClient;
const valkey = startValkey();
let redis: HotRedis;

beforeAll(async () => {
  motoId = docker(['run', '-d', '--rm', '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  const mapped = docker(['port', motoId, '5000/tcp']).split('\n')[0]!;
  endpoint = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  kms = new KMSClient({ endpoint, region, credentials: creds });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      keyId = (await kms.send(new CreateKeyCommand({ KeySpec: 'HMAC_256', KeyUsage: 'GENERATE_VERIFY_MAC' }))).KeyMetadata!.KeyId!;
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  redis = await createHotRedis({ url: valkey.url });
});
afterAll(async () => {
  await redis?.close();
  valkey.stop();
  if (motoId) docker(['rm', '-f', '-v', motoId]);
});

const envFor = (id: string) => ({ PEAKET_ENV: 'ci', PEAKET_KMS_ENDPOINT: endpoint, PEAKET_INV_REF_DEVICE_KMS_KEY: id });
const kmsFor = (ep: string | undefined) => kmsMacClient({ region, credentials: creds, ...(ep ? { endpoint: ep } : {}) });

/** 시험에서 §3.2의 식대로 따로 계산한 값 */
async function expectedRef(id: string, deviceId: string): Promise<string> {
  const mac = (await kms.send(new GenerateMacCommand({ KeyId: id, MacAlgorithm: 'HMAC_SHA_256', Message: Buffer.from('PEAKET-inv-ref-v1|device', 'utf8') }))).Mac!;
  return `k1.${createHmac('sha256', mac).update(deviceId, 'utf8').digest('base64url')}`;
}

function scoring(devices: { ref(id: string): string | undefined }) {
  const recorder = recordingRecorder();
  const behaviors = recordingBehaviors();
  const signals = recordingSignals();
  const pending: Promise<unknown>[] = [];
  const score = new ScoreRisk({
    rules: { current: () => parseRuleSet(SYNTHETIC_RULES_JSON), intensity: () => 'BASE' },
    human: recordingHuman(),
    features: new RedisFeatureStore(redis),
    devices,
    asn: { classify: () => 'OTHER' },
    recorder,
    behaviors,
    signals,
    clock: systemClock,
    after: (w) => void pending.push(w()),
  });
  return { score, recorder, behaviors, signals, settle: () => Promise.all(pending.splice(0)) };
}

async function allKeysAndValues(): Promise<string> {
  const names = ((await redis.command(['KEYS', '*'], { deadlineMs: 5_000 })) as unknown[]).map(String);
  const parts = [...names];
  for (const k of names) {
    const type = String(await redis.command(['TYPE', k], slow(k)));
    if (type === 'set') parts.push(...((await redis.command(['SMEMBERS', k], slow(k))) as unknown[]).map(String));
    if (type === 'zset') parts.push(...((await redis.command(['ZRANGE', k, '0', '-1'], slow(k))) as unknown[]).map(String));
  }
  return parts.join('\n');
}

describe('B-T16 기기 키 통일', () => {
  test('B-T16_KMS로받은라벨키로_로비입장·사전검증의판정기록·행동신호·기기공유수·기기계정키가모두같은가명이고_원문이없다', async () => {
    const d = deviceRefsFromEnv(envFor(keyId), systemClock, kmsFor);
    await d.ring.refresh();
    const ref = await expectedRef(keyId, DEVICE);
    expect(ref).toMatch(/^k1\.[A-Za-z0-9_-]{43}$/);
    expect(d.refs.ref(DEVICE)).toBe(ref);

    const s = scoring(d.refs);
    await s.score.run(request({ context: 'LOBBY_ENTRY', eventId: 'ev-16', pid: 'pid-16', deviceId: DEVICE, behavior: undefined }));
    await s.score.run(request({ context: 'PREVERIFY', eventId: 'ev-16', pid: 'pid-16', deviceId: DEVICE }));
    await s.settle();

    expect(s.recorder.records.map((r) => r.deviceRef)).toEqual([ref, ref]);
    expect(s.behaviors.records.map((r) => r.deviceRef)).toEqual([ref, ref]);
    expect(s.behaviors.records.map((r) => r.screen)).toEqual(['LOBBY', 'EVENT_DETAIL']);
    expect(s.recorder.records.every((r) => r.refMissing === false)).toBe(true);
    const share = keys.devShare(ref, 'ev-16');
    expect(await redis.command(['SMEMBERS', share], slow(share))).toEqual(['pid-16']);
    const acct = keys.devAccounts(ref);
    expect(await redis.command(['ZCARD', acct], slow(acct))).toBe(1);
    expect(await allKeysAndValues()).not.toContain(DEVICE);
  });

  test('B-T16_라벨이다른연락처용MAC으로만든값과는다르다', async () => {
    const d = deviceRefsFromEnv(envFor(keyId), systemClock, kmsFor);
    await d.ring.refresh();
    const contactMac = (await kms.send(new GenerateMacCommand({ KeyId: keyId, MacAlgorithm: 'HMAC_SHA_256', Message: Buffer.from('PEAKET-inv-ref-v1|contact', 'utf8') }))).Mac!;
    expect(d.refs.ref(DEVICE)).not.toBe(`k1.${createHmac('sha256', contactMac).update(DEVICE, 'utf8').digest('base64url')}`);
  });
});

describe('B-T24 KMS를 받지 못할 때', () => {
  test('[ASVS v5.0.0-16.3.4] B-T24②_KMS가닿지않으면요청을막지않고_refMissing과degraded를내며_되살리면돌아온다', async () => {
    const dead = deviceRefsFromEnv({ PEAKET_ENV: 'ci', PEAKET_KMS_ENDPOINT: 'http://127.0.0.1:1', PEAKET_INV_REF_DEVICE_KMS_KEY: keyId }, systemClock, (ep) => kmsMacClient({ region, credentials: creds, endpoint: ep! }));
    const missing: string[] = [];
    dead.ring.onMissing((l, r) => missing.push(`${l}:${r}`));
    await dead.ring.refresh();
    const s = scoring(dead.refs);
    const r = await s.score.run(request({ eventId: 'ev-24', pid: 'pid-24', deviceId: DEVICE }));
    await s.settle();
    expect(r.degraded).toBe(true);
    expect(s.recorder.records[0]).toMatchObject({ refMissing: true });
    expect(s.recorder.records[0]?.deviceRef).toBeUndefined();
    expect(missing).toEqual(['device:KMS_ERROR']);

    const live = deviceRefsFromEnv(envFor(keyId), systemClock, kmsFor);
    await live.ring.refresh();
    expect(live.refs.ref(DEVICE)).toBe(await expectedRef(keyId, DEVICE));
  });
});
