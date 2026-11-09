// 시작 파일을 실제로 띄운다: 운영에 기기 라벨 키 설정이 없어도 시작하고, 기기 가명을 계산하지 못한 수가 관리 포트 지표로 나온다(B-T24, ADR-0251).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { bootMain } from './main-boot.js';
import type { ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let managementPort = 0;
let grpcPort = 0;

beforeAll(async () => {
  ({ valkey, managementPort, grpcPort } = await bootMain({}));
}, 120_000);

afterAll(() => {
  valkey?.stop();
});

test('[ASVS v5.0.0-16.3.4] B-T24_운영에키설정이없으면시작은하고_기기가명을못만든판정이inv_ref_missing_total의NO_KEY로센다', async () => {
  expect((await fetch(`http://127.0.0.1:${managementPort}/ready`)).status).toBe(200);
  const def = protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const root = grpc.loadPackageDefinition(def) as unknown as { peaket: { trust: { v1: { TrustService: grpc.ServiceClientConstructor } } } };
  const client = new root.peaket.trust.v1.TrustService(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure()) as unknown as grpc.Client & { ScoreRisk(r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void): void };
  // 로그인 맥락은 사람 확인(외부 API)을 부르지 않는다
  const answer = await new Promise<Record<string, unknown>>((res, rej) => {
    client.ScoreRisk({ context: 'SCORE_CONTEXT_LOGIN', device_id: 'AQEBAQEBAQEBAQEBAQEBAQ', client: { ip: '198.51.100.7', user_agent: 'UA', asn: 0 } }, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v ?? {})));
  });
  client.close();
  expect(answer).toMatchObject({ degraded: true });
  const metrics = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
  expect(metrics).toContain('inv_ref_missing_total{service="trust-svc",label="device",reason="NO_KEY"} 1');
});
