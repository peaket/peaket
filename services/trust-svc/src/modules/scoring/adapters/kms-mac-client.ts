// 기기 라벨 키를 받는 KMS GenerateMac(docs/security/secrets-and-keys.md '조사용 가명 키'). 요청 처리 중에는 부르지 않고 뒤에서 라벨 키를 받을 때만 부른다.
// 시간 값은 identity-svc의 같은 호출과 같다(docs/api/guidelines.md §8.1 KMS 행).
import { GenerateMacCommand, KMSClient } from '@aws-sdk/client-kms';
import type { LabelMacClient } from '@peaket/platform';

/** KMS 연결 1초·요청 2초 [가정], 두 번까지 */
const CONNECTION_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_ATTEMPTS = 2;

export function kmsMacClient(o: { region: string; endpoint?: string; credentials?: { accessKeyId: string; secretAccessKey: string } }): LabelMacClient {
  const client = new KMSClient({
    region: o.region,
    ...(o.endpoint ? { endpoint: o.endpoint } : {}),
    ...(o.credentials ? { credentials: o.credentials } : {}),
    maxAttempts: MAX_ATTEMPTS,
    // throwOnRequestTimeout: 이 SDK 판은 이것이 없으면 요청 시간 한도를 넘겨도 끊지 않는다(identity-svc kmsMacClient와 같다)
    requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS, throwOnRequestTimeout: true },
  });
  return {
    async mac(keyId, message) {
      const r = await client.send(new GenerateMacCommand({ KeyId: keyId, MacAlgorithm: 'HMAC_SHA_256', Message: message }));
      if (!r.Mac) throw new Error('GenerateMac 응답에 Mac이 없다');
      return r.Mac;
    },
  };
}
