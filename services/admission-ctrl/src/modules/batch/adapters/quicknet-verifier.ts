// drand quicknet 서명 검증(ADR-0239 결정 3, ADR-0050 결정 7). 수식은 @noble/curves에 맡기고 여기서는 규격의 바이트만 맞춘다.
// 스킴 bls-unchained-g1-rfc9380: 메시지는 라운드 번호 8바이트 빅엔디언의 SHA-256, 서명은 G1(48바이트), 공개키는 G2(96바이트).
// 공개키는 코드에 고정한다. 체인 정보를 네트워크에서 받아 믿지 않는다(받은 값을 믿으면 중계가 체인을 바꿔치기할 수 있다).
import { createHash } from 'node:crypto';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import type { BeaconVerifier } from './drand-beacon.js';

export const QUICKNET_SCHEME = 'bls-unchained-g1-rfc9380';
export const QUICKNET_PUBLIC_KEY = '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a';
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';
const SIGNATURE_HEX = /^[0-9a-f]{96}$/;
const PUBLIC_KEY_BYTES = Buffer.from(QUICKNET_PUBLIC_KEY, 'hex');

export class QuicknetBeaconVerifier implements BeaconVerifier {
  /** 나쁜 입력(길이·16진수·곡선 밖의 점·범위 밖의 라운드)은 예외가 아니라 false다 */
  verify(round: number, signatureHex: string): boolean {
    if (!Number.isSafeInteger(round) || round < 1 || !SIGNATURE_HEX.test(signatureHex)) return false;
    try {
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64BE(BigInt(round));
      const message = createHash('sha256').update(counter).digest();
      const sigs = bls12_381.shortSignatures;
      return sigs.verify(Buffer.from(signatureHex, 'hex'), sigs.hash(message, DST), PUBLIC_KEY_BYTES);
    } catch {
      return false;
    }
  }
}
