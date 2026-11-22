// Kafka 네이티브 모듈을 싣지 못하면, 제어 설정 토픽 소비가 꼭 있어야 하는 운영 값(PEAKET_ENV=prod)의 trust-svc는 조용히 끄지 않고 시작에 실패한다
// (ADR-0334 결정 2, docs/features/control-tower.md C-T75 ② '서비스 파드가 그 사건을 받는다', BAT-215 리뷰 RV215-6). local·ci 쪽은 main-kafka-module 시험이 본다.
import { expect, test, vi } from 'vitest';
import { bootMain } from './main-boot.js';

vi.mock('@peaket/platform/stream-worker', () => {
  throw new Error('네이티브 모듈을 불러오지 못했다');
});

test('C-T75 ② RV215-6 ⑥ 운영 값으로 띄운 trust-svc는 Kafka 모듈을 싣지 못하면 그 오류로 시작에 실패하고 관리 포트를 열지 않는다', async () => {
  // 제어 설정 동기화를 진짜 싣기 경로로 둔다(bootMain이 운영 값에서 그 도우미를 바꾸지 않게)
  const boot = bootMain({}, { realControlSync: true });
  // 잘못 떠 버리면(이 시험이 실패하는 경우) 띄운 Valkey 컨테이너를 남기지 않는다. 실패한 시작은 bootMain이 이미 멈춘다
  void boot.then(
    (r) => r.valkey.stop(),
    () => {},
  );
  // vitest는 모듈 싣기 실패를 자기 문구로 감싸고 원래 오류를 cause에 둔다
  await expect(boot).rejects.toMatchObject({ cause: { message: '네이티브 모듈을 불러오지 못했다' } });
  const managementPort = Number(process.env.PEAKET_MANAGEMENT_PORT);
  expect(managementPort).toBeGreaterThan(0);
  await expect(fetch(`http://127.0.0.1:${managementPort}/ready`)).rejects.toThrow('fetch failed');
}, 120_000);
