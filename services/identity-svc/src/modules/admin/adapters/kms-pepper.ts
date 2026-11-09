// 운영의 관리자 비밀번호 페퍼(판마다 AWS KMS HMAC 키, GenerateMac·VerifyMac, docs/security/secrets-and-keys.md '관리자 비밀번호 페퍼 키', BUILD_ORDER BOT-110).
// MAC 값을 서비스가 견주지 않고 KMS VerifyMac이 판정한다. 서울이 답하지 않으면 도쿄 복제 키로 한 번 넘기고(BOT-131, ADR-0102), 그래도 안 되면 PepperUnavailable.
// 로컬·CI는 설정의 키 값(LocalPepper)을 받을 수 있다. 설정이 없으면 null(관리 계정 비밀번호를 정하거나 확인할 수 없다).
import { GenerateMacCommand, KMSClient, VerifyMacCommand } from '@aws-sdk/client-kms';
import { type AdminPepper, PepperUnavailable } from '../domain/ports.js';
import { kmsFailoverFromEnv, replicaKeyId, requireFailoverOutsideLocal, withFailover } from './kms-failover.js';
import { LocalPepper } from './local-pepper.js';

export const PEPPER_KMS_KEYS_ENV = 'PEAKET_ADMIN_PEPPER_KMS_KEYS';
export const PEPPER_WRITE_VERSION_ENV = 'PEAKET_ADMIN_PEPPER_WRITE_VERSION';
export const PEPPER_LOCAL_KEY_ENV = 'PEAKET_ADMIN_PEPPER_KEY';
const LOCAL_ENVS = ['local', 'ci'];
/** KMS 연결 1초·요청 2초 [가정], 두 번까지(연계정보 키와 같다) */
const CONNECTION_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 2_000;

/** GenerateMac·VerifyMac을 부르는 것(시험은 대역이나 KMS 흉내 서버) */
export interface PepperMacClient {
  mac(keyId: string, message: Uint8Array): Promise<Uint8Array>;
  verify(keyId: string, message: Uint8Array, mac: Uint8Array): Promise<boolean>;
}

export function kmsPepperClient(o: { region: string; endpoint?: string; credentials?: { accessKeyId: string; secretAccessKey: string } }): PepperMacClient {
  const client = new KMSClient({
    region: o.region,
    ...(o.endpoint ? { endpoint: o.endpoint } : {}),
    ...(o.credentials ? { credentials: o.credentials } : {}),
    maxAttempts: 2,
    // throwOnRequestTimeout: 이 SDK 판은 이것이 없으면 요청 시간 한도를 넘겨도 끊지 않는다(연결만 받고 답하지 않는 서울에서 넘기기 전에 멈춘다, 재검토 2026-11-05)
    requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS, throwOnRequestTimeout: true },
  });
  return {
    async mac(keyId, message) {
      const r = await client.send(new GenerateMacCommand({ KeyId: keyId, MacAlgorithm: 'HMAC_SHA_256', Message: message }));
      if (!r.Mac) throw new Error('GenerateMac 응답에 Mac이 없다');
      return r.Mac;
    },
    async verify(keyId, message, mac) {
      try {
        const r = await client.send(new VerifyMacCommand({ KeyId: keyId, MacAlgorithm: 'HMAC_SHA_256', Message: message, Mac: mac }));
        return r.MacValid === true;
      } catch (e) {
        // 맞지 않는 MAC은 KMS가 오류로 돌려준다: 틀린 비밀번호로 본다
        if ((e as { name?: string }).name === 'KMSInvalidMacException') return false;
        throw e;
      }
    },
  };
}

/** 서울 클라이언트가 응답하지 않으면 넘길 리전의 복제 키(ARN이면 리전 칸만 바꾼다)로 같은 호출을 한 번 한다(BOT-131) */
export function failoverPepperClient(primary: PepperMacClient, secondary: PepperMacClient, region: string, onFailover?: (errorName: string) => void): PepperMacClient {
  return {
    mac: (keyId, message) => withFailover(() => primary.mac(keyId, message), () => secondary.mac(replicaKeyId(keyId, region), message), onFailover),
    verify: (keyId, message, mac) => withFailover(() => primary.verify(keyId, message, mac), () => secondary.verify(replicaKeyId(keyId, region), message, mac), onFailover),
  };
}

/** 원인에는 오류 이름만 싣는다(메시지에 키 ARN·계정 번호가 들 수 있다, 연계정보 키와 같다) */
const errorName = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === 'string' ? n : 'Error';
};

export class KmsPepper implements AdminPepper {
  constructor(
    private readonly client: PepperMacClient,
    private readonly keys: Map<number, string>,
    readonly writeVersion: number,
  ) {
    if (!keys.has(writeVersion)) throw new Error(`쓰기 판 ${writeVersion}의 페퍼 KMS 키가 없다`);
    const ids = [...keys.values()];
    if (ids.some((x) => x.startsWith('alias/') || x.includes(':alias/'))) throw new Error('KMS 별칭은 받지 않는다(키 ID나 키 ARN)');
    // 같은 키를 키 ID와 ARN으로 섞어 줘도 같은 키로 본다(연계정보 키와 같은 견줌)
    const keyIdOf = (x: string) => x.slice(x.lastIndexOf('key/') >= 0 ? x.lastIndexOf('key/') + 4 : 0);
    if (new Set(ids.map(keyIdOf)).size !== ids.length) throw new Error('페퍼 판마다 다른 KMS 키여야 한다');
  }

  has(version: number): boolean {
    return this.keys.has(version);
  }

  async mac(version: number, message: Uint8Array): Promise<Buffer> {
    try {
      return Buffer.from(await this.client.mac(this.keys.get(version)!, message));
    } catch (e) {
      throw new PepperUnavailable(errorName(e));
    }
  }

  async verify(version: number, message: Uint8Array, mac: Uint8Array): Promise<boolean> {
    const id = this.keys.get(version);
    if (!id) return false;
    try {
      return await this.client.verify(id, message, mac);
    } catch (e) {
      throw new PepperUnavailable(errorName(e));
    }
  }

  toJSON(): string {
    return '[KmsPepper]';
  }
}

/**
 * 설정에서 만든다. KMS 키 목록(JSON {판: 키 ID})이 있으면 KMS, 없고 local·ci면 키 값, 둘 다 없으면 null.
 * client(끝점, 리전): 서울은 (PEAKET_KMS_ENDPOINT, AWS_REGION), 넘길 리전은 (PEAKET_KMS_FAILOVER_ENDPOINT, PEAKET_KMS_FAILOVER_REGION)으로 부른다
 */
export function adminPepperFromEnv(env: Record<string, string | undefined>, client: (endpoint: string | undefined, region: string) => PepperMacClient, onFailover?: (use: 'pepper', errorName: string) => void): AdminPepper | null {
  const peaketEnv = env.PEAKET_ENV ?? 'prod';
  const local = LOCAL_ENVS.includes(peaketEnv);
  const many = env[PEPPER_KMS_KEYS_ENV];
  if (many) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(many) as Record<string, unknown>;
    } catch {
      throw new Error(`${PEPPER_KMS_KEYS_ENV}는 JSON {판: 키 ID}다`);
    }
    const keys = new Map<number, string>();
    for (const [v, id] of Object.entries(parsed)) {
      const n = Number(v);
      if (!(Number.isInteger(n) && n > 0) || typeof id !== 'string' || id === '') throw new Error(`${PEPPER_KMS_KEYS_ENV}의 판·키 ID가 틀렸다`);
      keys.set(n, id);
    }
    const write = Number(env[PEPPER_WRITE_VERSION_ENV] ?? Math.max(...keys.keys()));
    const endpoint = env.PEAKET_KMS_ENDPOINT;
    if (endpoint && !local) throw new Error(`PEAKET_KMS_ENDPOINT는 ${LOCAL_ENVS.join('·')}에서만 쓴다(지금 ${peaketEnv})`);
    const failover = kmsFailoverFromEnv(env);
    requireFailoverOutsideLocal(env, failover, '관리자 비밀번호 페퍼');
    const primary = client(endpoint, env.AWS_REGION ?? 'ap-northeast-2');
    if (!failover) return new KmsPepper(primary, keys, write);
    // 넘길 리전이 있으면 모든 판의 키가 다중 리전 키여야 한다(시작 때 확인)
    for (const id of keys.values()) replicaKeyId(id, failover.region);
    return new KmsPepper(failoverPepperClient(primary, client(failover.endpoint, failover.region), failover.region, (name) => onFailover?.('pepper', name)), keys, write);
  }
  const raw = env[PEPPER_LOCAL_KEY_ENV];
  if (!raw) return null;
  if (!local) throw new Error(`${PEPPER_LOCAL_KEY_ENV}(페퍼 키 값)는 ${LOCAL_ENVS.join('·')}에서만 쓴다. 운영은 ${PEPPER_KMS_KEYS_ENV}`);
  return new LocalPepper(new Map([[1, Buffer.from(raw, 'base64')]]), 1);
}
