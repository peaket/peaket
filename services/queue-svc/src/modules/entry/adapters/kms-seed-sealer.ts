// 셔플 시드 봉인(AWS KMS Encrypt만, ADR-0239 결정 1·2, docs/security/secrets-and-keys.md '셔플 시드'). queue-svc는 봉인만 하고 풀 수 없다.
import { EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { sealContext, type SeedSealer, type ShuffleGroup, TEST_SEAL_ENV, TestSeedSealer } from '@peaket/shuffle';

export const SEED_KMS_KEY_ENV = 'PEAKET_SHUFFLE_SEED_KMS_KEY';
const KMS_ENDPOINT_ENV = 'PEAKET_KMS_ENDPOINT';
const TEST_ENVS = ['local', 'ci', 'demo'];
const LOCAL_ENVS = ['local', 'ci'];
/** KMS 호출 한도 [가정](identity-svc와 같은 값, ADR-0102). throwOnRequestTimeout이 없으면 이 SDK 판은 요청 시간 한도를 넘겨도 끊지 않는다(BOT-131) */
const CONNECTION_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_ATTEMPTS = 2;

export const kmsSealClient = (i: { region: string; endpoint?: string; credentials?: { accessKeyId: string; secretAccessKey: string } }): KMSClient =>
  new KMSClient({ region: i.region, ...(i.endpoint ? { endpoint: i.endpoint } : {}), ...(i.credentials ? { credentials: i.credentials } : {}), maxAttempts: MAX_ATTEMPTS, requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS, throwOnRequestTimeout: true } });

const errorName = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === 'string' ? n : 'Error';
};

/** KMS로 봉인하지 못했다. 오류 이름만 싣는다(시드는 싣지 않는다) */
export class SeedSealUnavailable extends Error {
  constructor(reason: string) {
    super(`시드를 봉인하지 못했다(${reason})`);
    this.name = 'SeedSealUnavailable';
  }
}

export class KmsSeedSealer implements SeedSealer {
  constructor(
    private readonly client: KMSClient,
    private readonly keyId: string,
  ) {
    if (keyId.startsWith('alias/') || keyId.includes(':alias/')) throw new Error('KMS 별칭은 받지 않는다(키 ID나 키 ARN)');
  }

  async seal(eventId: string, group: ShuffleGroup, seed: Uint8Array): Promise<string> {
    let blob: Uint8Array | undefined;
    try {
      blob = (await this.client.send(new EncryptCommand({ KeyId: this.keyId, Plaintext: seed, EncryptionContext: sealContext(eventId, group) }))).CiphertextBlob;
    } catch (e) {
      throw new SeedSealUnavailable(errorName(e));
    }
    if (!blob) throw new SeedSealUnavailable('empty');
    return Buffer.from(blob).toString('base64');
  }

  toJSON(): string {
    return '[KmsSeedSealer]';
  }
}

/**
 * 조립(ADR-0239 결정 5): KMS 키가 있으면 KMS, 없으면 local·ci·demo만 시험 봉인(값이 없으면 봉인 없이 시작해 로비 참가와 공시가 503이다).
 * 그 밖의 환경(값이 없으면 운영으로 본다)은 키가 없으면 시작하지 않고, 시험 값이 보여도 시작하지 않는다.
 */
export function seedSealerFromEnv(env: Record<string, string | undefined>, kms: (endpoint: string | undefined, region: string) => KMSClient): SeedSealer | undefined {
  const peaketEnv = env.PEAKET_ENV || 'prod';
  const testEnv = TEST_ENVS.includes(peaketEnv);
  if (!testEnv && env[TEST_SEAL_ENV]) throw new Error(`${TEST_SEAL_ENV}(시험 봉인 값)가 ${peaketEnv}에 있다. local·ci·demo에서만 쓴다`);
  const keyId = env[SEED_KMS_KEY_ENV];
  if (!keyId) {
    if (!testEnv) throw new Error(`${SEED_KMS_KEY_ENV}가 없다(셔플 시드 KMS 키. 운영은 시험 봉인을 쓰지 않는다)`);
    return env[TEST_SEAL_ENV] ? TestSeedSealer.fromEnv(env) : undefined;
  }
  const endpoint = env[KMS_ENDPOINT_ENV];
  if (endpoint && !LOCAL_ENVS.includes(peaketEnv)) throw new Error(`${KMS_ENDPOINT_ENV}는 ${LOCAL_ENVS.join('·')}에서만 쓴다(지금 ${peaketEnv})`);
  return new KmsSeedSealer(kms(endpoint, env.AWS_REGION ?? 'ap-northeast-2'), keyId);
}
