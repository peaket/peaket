// 운영자 KMS 비대칭 키로 RB-35 묶음에 서명한다(ADR-0053 결정 11, ADR-0239 결정 7). 키 재료는 이 프로세스에 들어오지 않는다.
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';

/** 묶음은 RAW 한도(4,096바이트)보다 훨씬 작다(사유 200자 안). KMS가 돌려주는 서명은 DER이다 */
export const kmsRunbookSigner =
  (kms: KMSClient) =>
  async (keyId: string, message: Buffer): Promise<Buffer> => {
    const r = await kms.send(new SignCommand({ KeyId: keyId, Message: message, MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256' }));
    if (!r.Signature) throw new Error('KMS가 서명을 돌려주지 않았다');
    return Buffer.from(r.Signature);
  };
