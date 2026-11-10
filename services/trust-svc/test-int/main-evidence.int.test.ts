// 시작 파일을 실제로 띄운다: 업무 gRPC 포트에 TrustEvidenceService(GetVerdictEvidence)가 열리고, 실제 Valkey의 판정 근거 키와 그 기기의 이력을 읽어 답한다
// (docs/features/bot-defense.md §12 '판정에 쓰는 자료', B-T15 ①). 근거 키와 이력은 시험이 직접 쓴다(판정 경로는 score-risk·verdict-evidence 통합 시험이 본다).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { createHotRedis } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { keys } from '../src/modules/scoring/adapters/redis-feature-store.js';
import { bootMain } from './main-boot.js';
import type { ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let grpcPort = 0;

beforeAll(async () => {
  ({ valkey, grpcPort } = await bootMain({}));
}, 120_000);

afterAll(() => {
  valkey?.stop();
});

type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;

test('B-T15 ① 시작 파일이 업무 gRPC 포트에 TrustEvidenceService를 열고 실제 Valkey의 판정 근거 키와 그 기기의 30일 이력만 읽어 답한다', async () => {
  const deviceRef = `k1.${'C'.repeat(43)}`;
  const otherRef = `k1.${'D'.repeat(43)}`;
  const decidedAtMs = Date.now() - 61_789;
  const today = Math.floor(Date.now() / 86_400_000);
  const redis = await createHotRedis({ url: valkey.url });
  const slow = (key: string) => ({ key, deadlineMs: 5_000 });
  try {
    const e = keys.evidence('pid-main-ev', 'ev-main');
    await redis.command(['SET', e, JSON.stringify({ eventKey: '0190f3a1-7c2e-7a00-8000-0000000000ab', deviceRef, hardSignal: 'BLOCK_LIST', reason: 'DEVICE_HISTORY', profileVersion: 11, decidedAtMs }), 'PX', '600000'], slow(e));
    await redis.command(['HSET', keys.devHistory(deviceRef), `sent:${today}`, '3', `passed:${today}`, '1', `failed:${today - 2}`, '2'], slow(keys.devHistory(deviceRef)));
    // 같은 사람의 다른 기기 이력은 세지 않는다
    await redis.command(['HSET', keys.devHistory(otherRef), `passed:${today}`, '8'], slow(keys.devHistory(otherRef)));
  } finally {
    await redis.close();
  }
  const def = protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const root = grpc.loadPackageDefinition(def) as unknown as { peaket: { trust: { v1: { TrustEvidenceService: grpc.ServiceClientConstructor } } } };
  const client = new root.peaket.trust.v1.TrustEvidenceService(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure()) as unknown as grpc.Client & { GetVerdictEvidence: Unary };
  const call = (r: object) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      client.GetVerdictEvidence(r, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (err, v) => (err ? rej(err) : res(v ?? {})));
    });
  try {
    expect(await call({ event_id: 'ev-main', pid: 'pid-main-ev' })).toEqual({
      found: true,
      reason: 'REASON_CATEGORY_DEVICE_HISTORY',
      hard_signal: 'HARD_SIGNAL_BLOCK_LIST',
      source: 'EVIDENCE_SOURCE_REALTIME',
      decided_at: { seconds: Math.floor(decidedAtMs / 1000), nanos: (decidedAtMs % 1000) * 1_000_000 },
      profile_version: 11,
      device_challenges_sent: 3,
      device_challenges_passed: 1,
      device_challenges_failed: 2,
    });
    expect(await call({ event_id: 'ev-main', pid: 'pid-main-none' })).toMatchObject({ found: false, device_challenges_sent: 0, device_challenges_passed: 0, device_challenges_failed: 0 });
    await expect(call({ event_id: 'ev-main', pid: 'pid:x' })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
  } finally {
    client.close();
  }
});
