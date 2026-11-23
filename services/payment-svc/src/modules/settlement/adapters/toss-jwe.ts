// 토스페이먼츠 지급대행 요청·응답 본문의 JWE(F-07-6 LCH-110, settlement §8 JWE 행, ADR-0369 결정 1, secrets-and-keys 토스 보안 키).
// 그 상점 보안 키(32바이트) 하나로 dir + A256GCM 대칭 JWE compact를 만든다. 보호 머리에 iat(만든 시각, KST 오프셋 꼴 밀리초 없음)·nonce(16바이트 base64url)를 싣는다.
// 풀 때는 dir·A256GCM만 받고(다른 alg·enc 거부, ASVS 11.3.1·11.3.3) 키 목록(지금·옛 키)을 차례로 시도한다. 실패는 TossJweError이고 메시지에 키·원문을 싣지 않는다.
import { CompactEncrypt, compactDecrypt } from 'jose';
import { randomBytes } from 'node:crypto';

export class TossJweError extends Error {
  constructor(message = '토스 JWE를 풀지 못했다') {
    super(message);
    this.name = 'TossJweError';
  }
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

/** 공개 안내 꼴 `yyyy-MM-dd'T'HH:mm:ss+09:00`(밀리초 없음, KST 오프셋) */
export const tossIat = (now: Date): string => `${new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;

export async function sealTossJwe(payload: unknown, key: Buffer, now: Date): Promise<string> {
  if (key.length !== 32) throw new TossJweError('토스 보안 키는 32바이트여야 한다');
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', iat: tossIat(now), nonce: randomBytes(16).toString('base64url') })
    .encrypt(new Uint8Array(key));
}

export async function openTossJwe(jwe: string, keys: readonly Buffer[]): Promise<unknown> {
  const text = jwe.trim();
  if (text.split('.').length !== 5) throw new TossJweError('JWE compact 꼴이 아니다');
  for (const key of keys) {
    try {
      const { plaintext } = await compactDecrypt(text, new Uint8Array(key), { keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] });
      return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    } catch {
      // 다음 키(교체 중의 옛 키)로 본다. 모두 실패하면 아래에서 던진다
    }
  }
  throw new TossJweError();
}
