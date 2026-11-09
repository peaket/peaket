// 구매 세션 시험 도구: 클라이언트 임시 키쌍(브라우저가 만드는 것). 공개키는 비압축 점 65바이트의 base64url이다.
import { generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface TestClientKey {
  /** X-Client-Ephemeral-Key 머리의 값 */
  text: string;
  privateKey: KeyObject;
}

export function clientKeyOf(): TestClientKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const text = Buffer.concat([Buffer.from([4]), Buffer.from(j.x!, 'base64url'), Buffer.from(j.y!, 'base64url')]).toString('base64url');
  return { text, privateKey };
}
