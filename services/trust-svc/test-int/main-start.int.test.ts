// 시작 파일을 실제로 띄운다: 운영 환경에서 텔레메트리 설정이 없어도 trust-svc는 준비 상태가 되고 그 기능만 꺼진다(ADR-0249 결정 4, 배포 조건).
import { afterAll, beforeAll, expect, test } from 'vitest';
import { bootMain, type ControlSyncCall } from './main-boot.js';
import type { ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let managementPort = 0;
let controlSyncCalls: ControlSyncCall[] = [];

beforeAll(async () => {
  ({ valkey, managementPort, controlSyncCalls } = await bootMain({}));
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

// 운영 값 시험은 제어 설정 동기화 도우미 하나만 가짜로 바꾼다(main-boot.ts). 그 가짜가 시작 파일의 진짜 호출과 짝인지 여기서 본다
// (docs/features/control-tower.md C-T75 ② '서비스 파드가 그 사건을 받는다', ADR-0334 결정 2, BAT-215 RV215-3)
test('C-T75 ② 운영 값으로 띄운 trust-svc 시작 파일은 듣기 전에 제어 설정 토픽 읽기 도우미를 프로세스 환경과 설정만 읽기(sessions: false)로 한 번 부른다', () => {
  expect(controlSyncCalls).toEqual([{ service: 'trust-svc', options: { sessions: false }, peaketEnv: 'prod', envIsProcessEnv: true, listening: false }]);
});
