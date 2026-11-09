// 셔플 시드 풀기(AWS KMS Decrypt만, ADR-0239 결정 1·2, docs/security/secrets-and-keys.md '셔플 시드').
// queue-svc가 봉인한 값을 admission-ctrl 리더만 푼다. 푼 시드는 로그·오류에 싣지 않는다(키 재료).
import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { type SeedOpener, sealContext, type ShuffleGroup } from '@peaket/shuffle';

/** KMS 호출 한도 [가정](identity-svc와 같은 값, ADR-0102). throwOnRequestTimeout이 없으면 이 SDK 판은 요청 시간 한도를 넘겨도 끊지 않는다(BOT-131) */
const CONNECTION_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_ATTEMPTS = 2;

export const kmsSeedClient = (i: { region: string; endpoint?: string; credentials?: { accessKeyId: string; secretAccessKey: string } }): KMSClient =>
  new KMSClient({ region: i.region, ...(i.endpoint ? { endpoint: i.endpoint } : {}), ...(i.credentials ? { credentials: i.credentials } : {}), maxAttempts: MAX_ATTEMPTS, requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS, throwOnRequestTimeout: true } });

const errorName = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === 'string' ? n : 'Error';
};

/** KMS로 풀지 못했다. 오류 이름만 싣는다(SDK 오류 객체를 그대로 올리면 요청·응답 값이 로그에 섞일 수 있다) */
export class SeedKeyUnavailable extends Error {
  constructor(reason: string) {
    super(`시드를 풀지 못했다(${reason})`);
    this.name = 'SeedKeyUnavailable';
  }
}

export class KmsSeedOpener implements SeedOpener {
  constructor(
    private readonly client: KMSClient,
    private readonly keyId: string,
  ) {
    if (keyId.startsWith('alias/') || keyId.includes(':alias/')) throw new Error('KMS 별칭은 받지 않는다(키 ID나 키 ARN)');
  }

  async open(eventId: string, group: ShuffleGroup, sealed: string): Promise<Buffer> {
    let plain: Uint8Array | undefined;
    try {
      const r = await this.client.send(new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: Buffer.from(sealed, 'base64'), EncryptionContext: sealContext(eventId, group) }));
      plain = r.Plaintext;
    } catch (e) {
      throw new SeedKeyUnavailable(errorName(e));
    }
    if (!plain) throw new SeedKeyUnavailable('empty');
    const seed = Buffer.from(plain);
    plain.fill(0);
    return seed;
  }

  toJSON(): string {
    return '[KmsSeedOpener]';
  }
}
