// 시작 파일을 실제로 띄운다: 운영 환경 값(PEAKET_ENV=prod)에서 제어 설정 토픽(control.settings)의 브로커 주소(PEAKET_KAFKA_BROKERS)가 없으면
// trust-svc는 조용히 설정 없이 뜨지 않고 시작에 실패한다(ADR-0334 결정 2, docs/features/control-tower.md C-T75 ② '서비스 파드가 그 사건을 받는다',
// BUILD_ORDER BAT-215 리뷰 RV215-3). local·ci만 경고로 끄고 뜬다(그쪽은 main-key-info·main-label 시험이 ci로 띄워 본다).
import { PlatformConfigError } from '@peaket/platform';
import { expect, test } from 'vitest';
import { bootMain } from './main-boot.js';

test('C-T75 ② 운영 값으로 띄운 trust-svc는 제어 설정 토픽 브로커 주소가 없으면 PlatformConfigError로 시작에 실패하고 관리 포트를 열지 않는다', async () => {
  const boot = bootMain({});
  // 잘못 떠 버리면(이 시험이 실패하는 경우) 띄운 Valkey 컨테이너를 남기지 않는다. 실패한 시작은 bootMain이 이미 멈춘다
  void boot.then(
    (r) => r.valkey.stop(),
    () => {},
  );
  await expect(boot).rejects.toThrow(PlatformConfigError);
  await expect(boot).rejects.toThrow('PEAKET_KAFKA_BROKERS가 없다(PEAKET_ENV=prod에서는 제어 설정 토픽 소비가 있어야 한다. local·ci만 없이 뜬다)');
  // 실패한 시작이 준비 상태 포트를 열지 않는다(열렸다면 /ready가 무엇이든 답한다)
  const managementPort = Number(process.env.PEAKET_MANAGEMENT_PORT);
  expect(managementPort).toBeGreaterThan(0);
  await expect(fetch(`http://127.0.0.1:${managementPort}/ready`)).rejects.toThrow('fetch failed');
}, 120_000);
