// 시작 파일을 실제로 띄운다: 운영 환경에서 텔레메트리 설정이 없어도 trust-svc는 준비 상태가 되고 그 기능만 꺼진다(ADR-0249 결정 4, 배포 조건).
import { afterAll, beforeAll, expect, test } from 'vitest';
import { bootMain } from './main-boot.js';
import type { ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let managementPort = 0;

beforeAll(async () => {
  ({ valkey, managementPort } = await bootMain({}));
}, 120_000);

afterAll(() => {
  valkey?.stop();
});

test('운영환경에서_텔레메트리설정이없어도_시작하고_준비상태가된다', async () => {
  const r = await fetch(`http://127.0.0.1:${managementPort}/ready`);
  expect(r.status).toBe(200);
  const metrics = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
  expect(metrics).toContain('telemetry_dropped_total');
});
