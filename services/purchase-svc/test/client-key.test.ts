// 구매 세션 요청 인증 키의 합의: 클라이언트 임시 공개키 읽기와 서버 고정 ECDH 키(docs/features/seat-hold.md §2 '요청 인증 키', ADR-0050 결정 8, BUILD_ORDER PRF-136).
// 독립 검증: RFC 5903 §8.1의 P-256 시험 벡터(ECDH 공유 비밀은 x 좌표 32바이트, 해시하지 않는다)와, 클라이언트 쪽을 따로 계산해 같은 요청 인증 키가 나오는지 본다.
import { diffieHellman, generateKeyPairSync } from 'node:crypto';
import { purchaseRequestKey } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { PURCHASE_ECDH_KEY_ENV, ServerEcdhKey, parseClientEphemeralKey } from '../src/modules/inventory/index.js';

const hex = (h: string) => Buffer.from(h.replace(/\s/g, ''), 'hex');
// RFC 5903 §8.1 (256비트 랜덤 ECP 그룹)
const I_PRIV = hex('C88F01F5 10D9AC3F 70A292DA A2316DE5 44E9AAB8 AFE84049 C62A9C57 862D1433');
const I_X = hex('DAD0B653 94221CF9 B051E1FE CA5787D0 98DFE637 FC90B9EF 945D0C37 72581180');
const I_Y = hex('5271A046 1CDB8252 D61F1C45 6FA3E59A B1F45B33 ACCF5F58 389E0577 B8990BB3');
const R_X = hex('D12DFB52 89C8D4F8 1208B702 70398C34 2296970A 0BCCB74C 736FC755 4494BF63');
const R_Y = hex('56FBF3CA 366CC23E 8157854C 13C58D6A AC23F046 ADA30F83 53E74F33 039872AB');
const SHARED = 'D6840F6B42F6EDAFD13116E0E12565202FEF8E9ECE7DCE03812464D04B9442DE'.toLowerCase();

const point = (x: Buffer, y: Buffer) => Buffer.concat([Buffer.from([4]), x, y]).toString('base64url');
const serverJwk = (over: Record<string, unknown> = {}) => ({ kty: 'EC', crv: 'P-256', x: I_X.toString('base64url'), y: I_Y.toString('base64url'), d: I_PRIV.toString('base64url'), kid: 'ecdh-1', ...over });

describe('클라이언트 임시 공개키 읽기', () => {
  test('비압축 점 65바이트의 base64url이고 곡선 위의 점이면 받는다. 저장하는 글은 받은 글 그대로다 [ASVS v5.0.0-8.2.1]', () => {
    const text = point(R_X, R_Y);
    expect(text).toHaveLength(87);
    const k = parseClientEphemeralKey(text);
    expect(k?.text).toBe(text);
    expect(k?.key.type).toBe('public');
  });

  test('모양이 틀리거나 곡선 위의 점이 아니면 undefined다: 문자열 아님, 길이, 채움, 허용 밖 글자, 앞 바이트, 비정규 표기, 곡선 밖, 무한원점, 좌표가 소수 p 이상 [ASVS v5.0.0-8.2.1]', () => {
    const ok = point(R_X, R_Y);
    const bad: unknown[] = [
      undefined,
      null,
      7,
      ['x'],
      '',
      ok.slice(0, -1), // 86자
      `${ok}A`, // 88자
      `${ok.slice(0, -1)}=`,
      `${ok.slice(0, -1)}+`,
      `${ok.slice(0, -1)} `,
      // 앞 바이트가 04가 아님(압축 표기 02·03이나 0, 5)
      ...[0, 2, 3, 5].map((b) => Buffer.concat([Buffer.from([b]), R_X, R_Y]).toString('base64url')),
      // 곡선 위의 점이 아님(y를 바꿈)
      point(R_X, Buffer.alloc(32, 1)),
      // 무한원점을 뜻하는 0 좌표
      point(Buffer.alloc(32, 0), Buffer.alloc(32, 0)),
      // 좌표가 소수 p(2^256 − 2^224 + 2^192 + 2^96 − 1) 이상
      point(Buffer.alloc(32, 0xff), Buffer.alloc(32, 0xff)),
    ];
    for (const b of bad) expect(parseClientEphemeralKey(b), JSON.stringify(b)).toBeUndefined();
    // 마지막 글자가 남는 비트를 쓰는 비정규 표기(같은 바이트의 다른 글)는 받지 않는다
    const lastIdx = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(ok.at(-1)!);
    const alt = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[(lastIdx + 1) % 64]!;
    if (Buffer.from(ok.slice(0, -1) + alt, 'base64url').toString('base64url') !== ok.slice(0, -1) + alt) {
      expect(parseClientEphemeralKey(ok.slice(0, -1) + alt)).toBeUndefined();
    }
  });
});

describe('서버 고정 ECDH 키', () => {
  test('RFC 5903 §8.1 벡터: 서버 개인키 i와 상대 공개점 (g^r)의 공유 비밀은 x 좌표 32바이트다 [ASVS v5.0.0-8.2.1]', () => {
    const server = new ServerEcdhKey(serverJwk());
    const client = parseClientEphemeralKey(point(R_X, R_Y))!;
    expect(server.sharedSecret(client.key).toString('hex')).toBe(SHARED);
  });

  test('클라이언트가 따로 계산한 요청 인증 키와 서버가 계산한 키가 같다(HKDF salt = jti, info = PEAKET-purchase-v1) [ASVS v5.0.0-8.2.1]', () => {
    const { privateKey: sPriv, publicKey: sPub } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sj = sPriv.export({ format: 'jwk' }) as Record<string, string>;
    const server = new ServerEcdhKey({ kty: 'EC', crv: 'P-256', x: sj.x!, y: sj.y!, d: sj.d!, kid: 'k' });
    const { privateKey: cPriv, publicKey: cPub } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const cj = cPub.export({ format: 'jwk' }) as Record<string, string>;
    const text = point(Buffer.from(cj.x!, 'base64url'), Buffer.from(cj.y!, 'base64url'));
    const jti = '0190f3a1-7c2e-7a00-8000-0000000000a1';
    const clientKey = purchaseRequestKey(diffieHellman({ privateKey: cPriv, publicKey: sPub }), jti);
    const serverKey = purchaseRequestKey(server.sharedSecret(parseClientEphemeralKey(text)!.key), jti);
    expect(Buffer.from(serverKey).equals(Buffer.from(clientKey))).toBe(true);
    // jti가 다르면 키가 다르다(입장 토큰마다 다른 키)
    expect(Buffer.from(purchaseRequestKey(server.sharedSecret(parseClientEphemeralKey(text)!.key), `${jti}x`)).equals(Buffer.from(serverKey))).toBe(false);
  });

  test('공개 JWK에는 개인 성분이 없고 kid와 좌표만 있다 [ASVS v5.0.0-8.2.1]', () => {
    const pub = new ServerEcdhKey(serverJwk()).publicJwk();
    expect(pub).toEqual({ kty: 'EC', crv: 'P-256', x: I_X.toString('base64url'), y: I_Y.toString('base64url'), kid: 'ecdh-1' });
    expect(new ServerEcdhKey(serverJwk()).kid).toBe('ecdh-1');
  });

  test('개인 JWK가 아니거나 P-256이 아니거나 kid가 없거나 모양이 틀리면 만들지 않는다. 오류 문구에 개인 성분을 싣지 않는다 [ASVS v5.0.0-8.2.1]', () => {
    const d = I_PRIV.toString('base64url');
    // 마지막 항목은 곡선 위의 점이지만 d의 짝이 아닌 공개 좌표(입장 확정 응답의 공개키와 어긋나 모든 요청이 401이 되는 설정 실수)
    for (const over of [{ d: undefined }, { kty: 'RSA' }, { crv: 'P-384' }, { kid: undefined }, { kid: 'a b' }, { x: undefined }, { y: Buffer.alloc(32, 1).toString('base64url') }, { x: R_X.toString('base64url'), y: R_Y.toString('base64url') }]) {
      let msg = '';
      try {
        new ServerEcdhKey(serverJwk(over) as never);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg, JSON.stringify(over)).not.toBe('');
      expect(msg).not.toContain(d);
    }
  });

  test('환경 값 PEAKET_PURCHASE_ECDH_KEY에서 읽는다: 없으면 이름이 든 오류, JSON이 아니면 오류(값은 싣지 않는다) [ASVS v5.0.0-8.2.1]', () => {
    expect(() => ServerEcdhKey.fromEnv({})).toThrow(PURCHASE_ECDH_KEY_ENV);
    expect(() => ServerEcdhKey.fromEnv({ [PURCHASE_ECDH_KEY_ENV]: 'not json' })).toThrow(PURCHASE_ECDH_KEY_ENV);
    const k = ServerEcdhKey.fromEnv({ [PURCHASE_ECDH_KEY_ENV]: JSON.stringify(serverJwk()) });
    expect(k.kid).toBe('ecdh-1');
    let msg = '';
    try {
      ServerEcdhKey.fromEnv({ [PURCHASE_ECDH_KEY_ENV]: 'secret-value-xyz' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain('secret-value-xyz');
  });
});
