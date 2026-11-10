// 시작 파일을 실제로 띄운다: 업무 gRPC 포트에 TrustLabelService(ApplyLabel)가 열리고, 라벨 반영이 실제 Valkey의 차단 키를 바꾸며 지표가 관리 포트에 나온다(docs/features/bot-defense.md §9 '첫 구현', §15).
// 서비스 로거의 표준 출력(Pino 동기 쓰기, fd 1)을 받아 보안 로그 줄이 서비스 로그 가명 키의 accountRef를 싣는지도 본다.
import fs from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { createHotRedis, loadLogPseudonymizer } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { keys } from '../src/modules/scoring/adapters/redis-feature-store.js';
import { bootMain } from './main-boot.js';
import type { ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let managementPort = 0;
let grpcPort = 0;

/** 서비스 로거가 표준 출력에 쓴 줄(Pino는 fs.writeSync(1, …)로 쓴다) */
const stdoutLines: string[] = [];
const realWriteSync = fs.writeSync;

beforeAll(async () => {
  (fs as { writeSync: unknown }).writeSync = (fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd === 1) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      stdoutLines.push(...text.split(/\r?\n/).filter(Boolean));
      return Buffer.byteLength(text);
    }
    return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
  };
  // 라벨 반영은 판정이 읽는 판(지금 판)의 기기 가명만 쓴다. 시험 라벨 키(합성 값)를 주고, 보안 로그 줄을 보려고 info부터 낸다
  ({ valkey, managementPort, grpcPort } = await bootMain({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: Buffer.alloc(32, 11).toString('base64'), PEAKET_LOG_LEVEL: 'info' }));
}, 120_000);

afterAll(() => {
  (fs as { writeSync: unknown }).writeSync = realWriteSync;
  valkey?.stop();
});

type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;

test('B-T20①_시작파일이업무gRPC포트에TrustLabelService를열고_FRAUD_ACTIONED가실제Valkey에차단키를올리며_지표가오른다', async () => {
  const def = protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const root = grpc.loadPackageDefinition(def) as unknown as { peaket: { trust: { v1: { TrustLabelService: grpc.ServiceClientConstructor } } } };
  const client = new root.peaket.trust.v1.TrustLabelService(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure()) as unknown as grpc.Client & { ApplyLabel: Unary };
  const call = (r: object) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      client.ApplyLabel(r, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v ?? {})));
    });
  const deviceRef = `k1.${'B'.repeat(43)}`;
  const base = { source_ref: 'fc-main', source_version: 1, source: 'LABEL_SOURCE_FRAUD_ACTIONED', label: 'LABEL_BOT', event_id: 'ev-1', pid: 'pid-main', acted_by: 'ops-1', device_ref: deviceRef };
  try {
    expect(await call(base)).toEqual({ changed: true, block_list: 'BLOCK_LIST_CHANGE_ADDED' });
    expect(await call(base)).toEqual({ changed: false, block_list: 'BLOCK_LIST_CHANGE_ADDED' });
    await expect(call({ ...base, label: 'LABEL_HUMAN' })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
  } finally {
    client.close();
  }
  const redis = await createHotRedis({ url: valkey.url });
  try {
    const value = await redis.command(['GET', keys.block(deviceRef)], { key: keys.block(deviceRef), deadlineMs: 5_000 });
    expect(JSON.parse(String(value))).toMatchObject({ source: 'FRAUD_ACTIONED', caseId: 'fc-main' });
  } finally {
    await redis.close();
  }
  const metrics = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
  expect(metrics).toContain('trust_block_list_changes_total{op="added",source="FRAUD_ACTIONED"} 1');
});

test('[ASVS v5.0.0-16.3.3] B-T27⑨_시작파일의보안로그줄은처리자원문대신서비스로그가명키의accountRef를싣고_기기가명이없다', async () => {
  const lines = stdoutLines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === 'trust_block_list_change');
  // 앞 시험의 FRAUD_ACTIONED 등재 한 번(다시 보낸 같은 판은 끝남이라 줄이 없다)
  expect(lines).toHaveLength(1);
  const expected = loadLogPseudonymizer(process.env).pseudonymizer.ref('ops-1');
  expect(lines[0]).toMatchObject({ kind: 'security', service: 'trust-svc', caseId: 'fc-main', source: 'FRAUD_ACTIONED', change: 'ADDED', accountRef: expected });
  expect(expected).not.toBe('ops-1');
  const text = JSON.stringify(lines[0]);
  expect(text).not.toContain('"ops-1"');
  expect(text).not.toMatch(/k\d+\.[A-Za-z0-9_-]{43}/);
});
