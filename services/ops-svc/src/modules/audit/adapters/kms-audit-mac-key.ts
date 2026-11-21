// 감사 체인 키의 KMS 어댑터(ADR-0341 결정 2, docs/api/guidelines.md §8.1 '감사 체인 키' 행). HMAC 다중 리전 키(mrk-)의 GenerateMac·VerifyMac(HMAC_SHA_256).
// 서울이 응답하지 않으면(연결 실패·시간 초과·5xx·한도) 넘길 리전의 복제 키로 한 번 더 하고, 거절(권한 없음·키 꺼짐)은 넘기지 않는다(같은 키 재료라 mac이 같다).
// 시간 값은 연결 1초·요청 2초 [가정](trust-svc·identity-svc의 같은 호출과 같다). 로그·지표에는 오류 이름만 싣는다(메시지에 키 ARN·계정 번호가 들 수 있다).
import { GenerateMacCommand, KMSClient, VerifyMacCommand } from '@aws-sdk/client-kms';
import { AuditMacKeyUnavailable, type AuditMacKey } from '../mac.js';

const CONNECTION_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_ATTEMPTS = 2;
/** 응답은 왔지만 KMS가 잠시 처리하지 못한 것(넘긴다) */
const TRANSIENT = new Set(['ThrottlingException', 'KMSInternalException', 'DependencyTimeoutException', 'KeyUnavailableException', 'TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'ServiceUnavailable', 'InternalFailure']);
/** 응답 전에 끊긴 네트워크 오류 코드(넘긴다) */
const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * 넘길 오류인가: 잠시 처리하지 못한 이름, 응답 전에 끊긴 네트워크 오류, SDK를 거친 오류인데 HTTP 응답이 없었거나 5xx.
 * 거절(AccessDeniedException·DisabledException·NotFoundException 등 4xx)은 넘기지 않는다
 */
export function isKmsUnavailable(e: unknown): boolean {
  const x = e as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: number } } | null;
  const name = typeof x?.name === 'string' ? x.name : '';
  if (TRANSIENT.has(name)) return true;
  if (typeof x?.code === 'string' && NETWORK.has(x.code)) return true;
  if (!x?.$metadata) return false;
  const status = x.$metadata.httpStatusCode;
  return status === undefined || status >= 500;
}

export const kmsErrorName = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === 'string' ? n : 'Error';
};

/** 넘길 리전의 복제 키 ID: 키 ARN이면 리전 칸만 바꾸고, 키 ID면 그대로다. 다중 리전 키(mrk-)가 아니면 받지 않는다 */
export function replicaKeyId(keyId: string, region: string): string {
  const at = keyId.lastIndexOf('key/');
  const id = at >= 0 ? keyId.slice(at + 4) : keyId;
  if (!id.startsWith('mrk-')) throw new Error('감사 체인 키는 다중 리전 키(키 ID가 mrk-로 시작)여야 한다');
  if (!keyId.startsWith('arn:')) return keyId;
  const parts = keyId.split(':');
  if (parts.length < 6 || parts[2] !== 'kms') throw new Error('KMS 키 ARN 꼴이 아니다');
  parts[3] = region;
  return parts.join(':');
}

/** GenerateMac·VerifyMac을 부르는 것(시험은 대역이나 KMS 흉내 서버) */
export interface AuditMacClient {
  mac(keyId: string, message: Uint8Array): Promise<Uint8Array>;
  verify(keyId: string, message: Uint8Array, mac: Uint8Array): Promise<boolean>;
}

export function kmsAuditMacClient(o: { region: string; endpoint?: string }): AuditMacClient {
  const client = new KMSClient({
    region: o.region,
    ...(o.endpoint ? { endpoint: o.endpoint } : {}),
    maxAttempts: MAX_ATTEMPTS,
    // throwOnRequestTimeout: 이 SDK 판은 이것이 없으면 요청 시간 한도를 넘겨도 끊지 않는다(identity-svc kmsPepperClient와 같다)
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
        // 맞지 않는 mac은 KMS가 오류로 돌려준다: 틀린 mac으로 본다
        if (kmsErrorName(e) === 'KMSInvalidMacException') return false;
        throw e;
      }
    },
  };
}

/** KMS 감사 체인 키. secondary가 있으면 서울 무응답 때 복제 키로 한 번 넘기고 onFailover(op, 오류 이름)를 부른다 */
export class KmsAuditMacKey implements AuditMacKey {
  constructor(
    private readonly primary: AuditMacClient,
    readonly keyId: string,
    private readonly failover?: { readonly client: AuditMacClient; readonly region: string },
    private readonly onFailover?: (op: 'GenerateMac' | 'VerifyMac', errorName: string) => void,
  ) {
    replicaKeyId(keyId, failover?.region ?? 'ap-northeast-1');
  }

  async #call<T>(op: 'GenerateMac' | 'VerifyMac', f: (c: AuditMacClient, keyId: string) => Promise<T>): Promise<T> {
    try {
      return await f(this.primary, this.keyId);
    } catch (e) {
      if (!this.failover || !isKmsUnavailable(e)) throw new AuditMacKeyUnavailable(kmsErrorName(e));
      try {
        this.onFailover?.(op, kmsErrorName(e));
      } catch {
        // 지표가 실패해도 도쿄를 부른다
      }
      try {
        return await f(this.failover.client, replicaKeyId(this.keyId, this.failover.region));
      } catch (e2) {
        throw new AuditMacKeyUnavailable(kmsErrorName(e2));
      }
    }
  }

  mac(message: Uint8Array): Promise<Uint8Array> {
    return this.#call('GenerateMac', (c, id) => c.mac(id, message));
  }

  verify(message: Uint8Array, mac: Uint8Array): Promise<boolean> {
    return this.#call('VerifyMac', (c, id) => c.verify(id, message, mac));
  }
}
