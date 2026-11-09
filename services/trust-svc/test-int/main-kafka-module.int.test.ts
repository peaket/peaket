// Kafka 네이티브 모듈을 싣지 못해도 trust-svc는 시작하고 텔레메트리만 꺼진다(응용 프로그램 제어에 막힌 PC·이미지, ADR-0249 결정 4).
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { bootMain } from './main-boot.js';
import type { ValkeyContainer } from './valkey.js';

vi.mock('@peaket/platform/stream-worker', () => {
  throw new Error('네이티브 모듈을 불러오지 못했다');
});

let valkey: ValkeyContainer;
let managementPort = 0;

beforeAll(async () => {
  ({ valkey, managementPort } = await bootMain({ PEAKET_ENV: 'ci', PEAKET_TELEMETRY_KAFKA_BROKERS: '127.0.0.1:1' }));
}, 120_000);

afterAll(() => {
  valkey?.stop();
});

test('Kafka모듈을싣지못해도_시작하고_준비상태가된다', async () => {
  const r = await fetch(`http://127.0.0.1:${managementPort}/ready`);
  expect(r.status).toBe(200);
});
