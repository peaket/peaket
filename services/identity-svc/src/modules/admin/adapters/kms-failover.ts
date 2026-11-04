// 관리 계정 KMS 호출의 복제 키 넘기기(docs/features/identity.md §6 '관리 계정 KMS 호출의 복제 키 넘기기의 첫 구현', BUILD_ORDER BOT-131, ADR-0102).
// 서울이 응답하지 않으면(연결 실패·시간 초과·서버 쪽 오류·한도) 같은 호출을 넘길 리전의 다중 리전 복제 키로 한 번 한다. 거절은 넘기지 않는다(같은 키 재료라 답이 같다).
export const KMS_FAILOVER_REGION_ENV = 'PEAKET_KMS_FAILOVER_REGION';
export const KMS_FAILOVER_ENDPOINT_ENV = 'PEAKET_KMS_FAILOVER_ENDPOINT';
const LOCAL_ENVS = ['local', 'ci'];
/** 응답은 왔지만 KMS가 잠시 처리하지 못한 것(넘긴다) */
const TRANSIENT = new Set(['ThrottlingException', 'KMSInternalException', 'DependencyTimeoutException', 'KeyUnavailableException', 'TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'ServiceUnavailable', 'InternalFailure']);
/** 응답 전에 끊긴 네트워크 오류 코드(넘긴다) */
const NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH']);

export interface KmsFailover {
  region: string;
  endpoint?: string;
}

/**
 * 넘길 오류인가: 잠시 처리하지 못한 이름이거나, 응답 전에 끊긴 네트워크 오류이거나, SDK를 거친 오류($metadata)인데 HTTP 응답이 없었거나 5xx다.
 * SDK를 거치지 않은 오류(코드 버그, 빈 응답)는 장애로 보지 않는다(재검토 2026-11-05)
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

/** 오류 이름(로그·지표에는 이것만 싣는다: 메시지에 키 ARN·계정 번호가 들 수 있다) */
export const kmsErrorName = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === 'string' ? n : 'Error';
};

/** 넘길 리전의 복제 키 ID: 키 ARN이면 리전 칸만 바꾸고, 키 ID면 그대로다. 다중 리전 키(mrk-)가 아니면 받지 않는다 */
export function replicaKeyId(keyId: string, region: string): string {
  const at = keyId.lastIndexOf('key/');
  const id = at >= 0 ? keyId.slice(at + 4) : keyId;
  if (!id.startsWith('mrk-')) throw new Error('복제 키로 넘기려면 다중 리전 키(키 ID가 mrk-로 시작)여야 한다');
  if (!keyId.startsWith('arn:')) return keyId;
  const parts = keyId.split(':');
  if (parts.length < 6 || parts[2] !== 'kms') throw new Error('KMS 키 ARN 꼴이 아니다');
  parts[3] = region;
  return parts.join(':');
}

/**
 * 설정: 넘길 리전이 없으면 null. 끝점은 local·ci만 받는다.
 * 서울을 흉내 서버(PEAKET_KMS_ENDPOINT)로 가리키면 넘길 끝점도 있어야 한다: 비우면 넘길 때 실제 AWS로 나간다(재검토 2026-11-05)
 */
export function kmsFailoverFromEnv(env: Record<string, string | undefined>): KmsFailover | null {
  const peaketEnv = env.PEAKET_ENV ?? 'prod';
  const region = env[KMS_FAILOVER_REGION_ENV];
  const endpoint = env[KMS_FAILOVER_ENDPOINT_ENV];
  if (endpoint && !LOCAL_ENVS.includes(peaketEnv)) throw new Error(`${KMS_FAILOVER_ENDPOINT_ENV}는 ${LOCAL_ENVS.join('·')}에서만 쓴다(지금 ${peaketEnv})`);
  // 넘길 끝점만 있고 리전이 없으면 넘기기가 말없이 꺼진다(재검토 2026-11-05)
  if (!region && endpoint) throw new Error(`${KMS_FAILOVER_ENDPOINT_ENV}를 쓰려면 ${KMS_FAILOVER_REGION_ENV}도 있어야 한다`);
  if (!region) return null;
  if (region === (env.AWS_REGION ?? 'ap-northeast-2')) throw new Error(`${KMS_FAILOVER_REGION_ENV}는 서비스 리전과 달라야 한다`);
  if (env.PEAKET_KMS_ENDPOINT && !endpoint) throw new Error(`PEAKET_KMS_ENDPOINT(흉내 서버)를 쓰면 ${KMS_FAILOVER_ENDPOINT_ENV}도 있어야 한다(넘길 때 실제 AWS로 나가지 않게)`);
  return endpoint ? { region, endpoint } : { region };
}

/** 넘길 리전이 없으면 local·ci 밖에서는 시작하지 않는다(ADR-0102: 관리 로그인이 KMS 한쪽 장애에 막히지 않게) */
export function requireFailoverOutsideLocal(env: Record<string, string | undefined>, failover: KmsFailover | null, what: string): void {
  const peaketEnv = env.PEAKET_ENV ?? 'prod';
  if (!failover && !LOCAL_ENVS.includes(peaketEnv)) throw new Error(`${what}를 KMS로 쓰려면 ${KMS_FAILOVER_REGION_ENV}(복제 키 리전)가 있어야 한다(ADR-0102)`);
}

/** 서울 호출을 하고, 넘길 오류면 복제 키로 한 번 더 한다. onFailover(서울 오류 이름)가 던져도 넘긴다 */
export async function withFailover<T>(primary: () => Promise<T>, secondary: (() => Promise<T>) | undefined, onFailover?: (errorName: string) => void): Promise<T> {
  try {
    return await primary();
  } catch (e) {
    if (!secondary || !isKmsUnavailable(e)) throw e;
    try {
      onFailover?.(kmsErrorName(e));
    } catch {
      // 지표·로그가 실패해도 도쿄를 부른다
    }
    return secondary();
  }
}
