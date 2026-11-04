// 연계정보 HMAC과 pid의 KMS 키(docs/features/identity.md §5 '키 판·만 14세…', docs/security/secrets-and-keys.md 연계정보·pid 행, ADR-0050 결정 5).
// 판마다 따로 된 KMS HMAC 키(HMAC_256)의 GenerateMac(HMAC_SHA_256)이다. 결과 확정 때만 부르고(트랜잭션 밖), 토큰 발급은 저장값을 쓴다.
// KMS가 답하지 않거나 한도에 걸리면 KeyServiceUnavailable(유스케이스가 PROVIDER_DOWN으로 마친다). 복구 리전 복제 키 넘기기는 BUILD_ORDER BOT-130
import { GenerateMacCommand, KMSClient } from '@aws-sdk/client-kms';
import type { IdentityHashers } from '../domain/ports.js';
import { KeyServiceUnavailable } from '../domain/verification.js';
import { orderVersions, parseVersions, pidVersionOf, writeVersionOf } from './hmac-identity-hashers.js';

export const CI_HMAC_KMS_KEYS_ENV = 'PEAKET_CI_HMAC_KMS_KEYS';
export const PID_HMAC_KMS_KEY_ENV = 'PEAKET_PID_HMAC_KMS_KEY';
/** 로컬 시험의 AWS 흉내 서버(moto) 주소. local·ci만 */
export const KMS_ENDPOINT_ENV = 'PEAKET_KMS_ENDPOINT';
const ENDPOINT_ENVS = ['local', 'ci'];
/** KMS 연결 1초·요청 2초 [가정], 두 번까지(docs/api/guidelines.md §8.1 KMS 행) */
const CONNECTION_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_ATTEMPTS = 2;

/** GenerateMac을 부르는 것(시험은 대역으로 바꾼다) */
export interface MacClient {
  mac(keyId: string, message: Uint8Array): Promise<Uint8Array>;
}

export function kmsMacClient(o: { region: string; endpoint?: string; credentials?: { accessKeyId: string; secretAccessKey: string } }): MacClient {
  const client = new KMSClient({
    region: o.region,
    ...(o.endpoint ? { endpoint: o.endpoint } : {}),
    ...(o.credentials ? { credentials: o.credentials } : {}),
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
  });
  return {
    async mac(keyId, message) {
      const r = await client.send(new GenerateMacCommand({ KeyId: keyId, MacAlgorithm: 'HMAC_SHA_256', Message: message }));
      if (!r.Mac) throw new Error('GenerateMac 응답에 Mac이 없다');
      return r.Mac;
    },
  };
}

export class KmsIdentityHashers implements IdentityHashers {
  /** 첫째가 쓰기 판, 나머지는 큰 판부터 */
  readonly #ciKeys: [number, string][];
  readonly #pidKeyId: string;
  readonly #pidVersion: number;
  readonly #client: MacClient;

  constructor(o: { client: MacClient; ciKeys: Map<number, string>; writeVersion?: number; pidKeyId: string; pidVersion: number }) {
    if (o.ciKeys.size === 0) throw new Error('연계정보 KMS 키 판이 하나도 없다');
    const ids = [...o.ciKeys.values(), o.pidKeyId];
    // 키 ID와 키 ARN을 섞어 줘도 같은 키를 알아보게 ARN의 'key/' 뒤를 견준다(다시 보기 낮음 7)
    const keyIdOf = (x: string) => x.slice(x.lastIndexOf('key/') >= 0 ? x.lastIndexOf('key/') + 4 : 0);
    if (new Set(ids.map(keyIdOf)).size !== ids.length) throw new Error('연계정보 키 판끼리, 연계정보 키와 pid 키는 서로 다른 KMS 키다');
    // 별칭은 가리키는 키가 바뀌면 같은 사람의 값이 조용히 달라진다. 키 ID·ARN만 받는다(새 맥락 리뷰 낮음 9)
    if (ids.some((x) => x.startsWith('alias/') || x.includes(':alias/'))) throw new Error('KMS 별칭은 받지 않는다(키 ID나 키 ARN)');
    this.#ciKeys = orderVersions([...o.ciKeys], o.writeVersion);
    this.#pidKeyId = o.pidKeyId;
    this.#pidVersion = o.pidVersion;
    this.#client = o.client;
  }

  /** PEAKET_CI_HMAC_KMS_KEYS가 있으면 KMS를 쓴다(없으면 null) */
  static fromEnv(env: Record<string, string | undefined>): KmsIdentityHashers | null {
    const many = env[CI_HMAC_KMS_KEYS_ENV];
    if (!many) return null;
    const pid = env[PID_HMAC_KMS_KEY_ENV];
    if (!pid) throw new Error(`${PID_HMAC_KMS_KEY_ENV}가 없다(pid HMAC KMS 키 ID)`);
    const endpoint = env[KMS_ENDPOINT_ENV];
    const peaketEnv = env.PEAKET_ENV ?? 'prod';
    if (endpoint && !ENDPOINT_ENVS.includes(peaketEnv)) throw new Error(`${KMS_ENDPOINT_ENV}는 ${ENDPOINT_ENVS.join('·')}에서만 쓴다(지금 ${peaketEnv})`);
    const client = kmsMacClient({ region: env.AWS_REGION ?? 'ap-northeast-2', ...(endpoint ? { endpoint } : {}) });
    return new KmsIdentityHashers({ client, ciKeys: parseVersions(many, CI_HMAC_KMS_KEYS_ENV), writeVersion: writeVersionOf(env), pidKeyId: pid, pidVersion: pidVersionOf(env) });
  }

  versions(): number[] {
    return this.#ciKeys.map(([v]) => v);
  }

  pidVersion(): number {
    return this.#pidVersion;
  }

  async #mac(keyId: string, message: Uint8Array): Promise<Buffer> {
    try {
      return Buffer.from(await this.#client.mac(keyId, message));
    } catch (e) {
      const name = (e as { name?: string }).name ?? 'Error';
      throw new KeyServiceUnavailable(name);
    }
  }

  async ciAll(ci: string) {
    const message = Buffer.from(ci, 'utf8');
    return Promise.all(this.#ciKeys.map(async ([version, keyId]) => ({ hmac: await this.#mac(keyId, message), version })));
  }

  async pid(ciHmac: Buffer) {
    return { pid: await this.#mac(this.#pidKeyId, ciHmac), version: this.#pidVersion };
  }
}
