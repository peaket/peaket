// 클라이언트 임시 공개키(X-Client-Ephemeral-Key, docs/api/openapi.yaml ClientEphemeralKey, docs/features/seat-hold.md §2 '요청 인증 키', ADR-0050 결정 8).
// 비압축 점 65바이트(0x04 ‖ X ‖ Y)의 base64url(채움 없음, 87자)이다. 곡선(P-256) 위의 점이 아니면 받지 않는다. 도메인 층이라 node:crypto만 쓴다.
import { createPublicKey, type KeyObject } from 'node:crypto';
import { CLIENT_KEY_PATTERN } from './purchase-session.js';

export interface ClientEphemeralKey {
  /** 저장하는 글(받은 글 그대로, 87자 base64url) */
  text: string;
  /** ECDH에 쓰는 공개키 객체 */
  key: KeyObject;
}

/**
 * 모양과 곡선 위의 점인지를 본다. 문자열이 아니거나 87자 base64url이 아니거나(허용 밖 글자·채움·비정규 표기 포함) 첫 바이트가 0x04가 아니거나
 * 점이 P-256 곡선 위에 없으면(좌표가 소수 p 이상이거나 무한원점 0 포함) undefined다. 던지지 않는다
 */
export function parseClientEphemeralKey(text: unknown): ClientEphemeralKey | undefined {
  if (typeof text !== 'string' || !CLIENT_KEY_PATTERN.test(text)) return undefined;
  const b = Buffer.from(text, 'base64url');
  if (b.length !== 65 || b[0] !== 0x04 || b.toString('base64url') !== text) return undefined;
  try {
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b.subarray(1, 33).toString('base64url'), y: b.subarray(33).toString('base64url') }, format: 'jwk' });
    return { text, key };
  } catch {
    return undefined;
  }
}
