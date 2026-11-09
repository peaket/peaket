// 시드 풀기·비콘의 조립(ADR-0239 결정 5). local·ci·demo만 시험 대역이고, 그 밖(값이 없으면 운영으로 본다)은 설정이 없으면 시작하지 않는다.
import type { KMSClient } from '@aws-sdk/client-kms';
import { type Clock, systemClock } from '@peaket/platform';
import { type SeedOpener, TEST_SEAL_ENV, TestSeedSealer } from '@peaket/shuffle';
import type { Beacon, ShuffleRecords } from '../domain/ports.js';
import { DrandBeacon, type BeaconHttp } from './drand-beacon.js';
import { externalBeaconHttp } from './drand-http.js';
import { KmsSeedOpener } from './kms-seed-opener.js';
import { QuicknetBeaconVerifier } from './quicknet-verifier.js';
import { TestRandomness } from './test-randomness.js';

export const SEED_KMS_KEY_ENV = 'PEAKET_SHUFFLE_SEED_KMS_KEY';
export const DRAND_RELAYS_ENV = 'PEAKET_DRAND_RELAYS';
const KMS_ENDPOINT_ENV = 'PEAKET_KMS_ENDPOINT';
const TEST_ENVS = ['local', 'ci', 'demo'];
const LOCAL_ENVS = ['local', 'ci'];
/** 운영의 중계 주소 최소 수 [가정] */
const MIN_RELAYS = 2;

export interface ShuffleRuntime {
  opener: SeedOpener;
  beacon(records: ShuffleRecords): Beacon;
}

export interface ShuffleRuntimeDeps {
  kms: (endpoint: string | undefined, region: string) => KMSClient;
  clock?: Clock;
  http?: (relays: readonly string[]) => BeaconHttp;
}

/** 중계 주소 읽기: 쿼리·조각·사용자 정보가 없는 주소만 받는다. 운영은 https만이고 2개 이상이다 */
function relaysOf(raw: string | undefined, peaketEnv: string): string[] {
  const relays = [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    ),
  ];
  const local = LOCAL_ENVS.includes(peaketEnv);
  if (relays.length === 0) throw new Error(`${DRAND_RELAYS_ENV}가 없다(drand 중계 주소 목록, 쉼표로 나눈다)`);
  if (!local && relays.length < MIN_RELAYS) throw new Error(`${DRAND_RELAYS_ENV}는 ${MIN_RELAYS}개 이상이어야 한다(지금 ${relays.length}개)`);
  for (const relay of relays) {
    let u: URL;
    try {
      u = new URL(relay);
    } catch {
      throw new Error(`${DRAND_RELAYS_ENV}의 주소가 틀렸다: ${relay}`);
    }
    if (u.search || u.hash || u.username || u.password) throw new Error(`${DRAND_RELAYS_ENV}의 주소에 쿼리·조각·사용자 정보를 쓸 수 없다: ${relay}`);
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error(`${DRAND_RELAYS_ENV}는 https 주소만 받는다: ${relay}`);
  }
  return relays;
}

export function shuffleRuntimeFromEnv(env: Record<string, string | undefined>, deps: ShuffleRuntimeDeps): ShuffleRuntime {
  const peaketEnv = env.PEAKET_ENV || 'prod';
  const testEnv = TEST_ENVS.includes(peaketEnv);
  const keyId = env[SEED_KMS_KEY_ENV];
  if (!testEnv && env[TEST_SEAL_ENV]) throw new Error(`${TEST_SEAL_ENV}(시험 시드·비콘 값)가 ${peaketEnv}에 있다. local·ci·demo에서만 쓴다`);
  if (!keyId) {
    if (!testEnv) throw new Error(`${SEED_KMS_KEY_ENV}가 없다(셔플 시드 KMS 키. 운영은 시험 대역을 쓰지 않는다)`);
    const opener = TestSeedSealer.fromEnv(env);
    const beacon = TestRandomness.fromEnv(env);
    return { opener, beacon: () => beacon };
  }
  const endpoint = env[KMS_ENDPOINT_ENV];
  if (endpoint && !LOCAL_ENVS.includes(peaketEnv)) throw new Error(`${KMS_ENDPOINT_ENV}는 ${LOCAL_ENVS.join('·')}에서만 쓴다(지금 ${peaketEnv})`);
  const relays = relaysOf(env[DRAND_RELAYS_ENV], peaketEnv);
  const opener = new KmsSeedOpener(deps.kms(endpoint, env.AWS_REGION ?? 'ap-northeast-2'), keyId);
  const clock = deps.clock ?? systemClock;
  const http = (deps.http ?? externalBeaconHttp)(relays);
  const verifier = new QuicknetBeaconVerifier();
  return { opener, beacon: (records) => new DrandBeacon({ relays, records, verifier, http, clock }) };
}
