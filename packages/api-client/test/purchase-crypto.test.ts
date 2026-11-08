// FE-T7 구매 세션 서명: 서버와 같은 시험 벡터(MAC 입력·HKDF·키 형식, docs/frontend.md §5.3, ADR-0221 결정 6·7).
// 벡터 파일은 서버 시험(packages/platform/test/purchase-auth.test.ts)과 같은 docs/api/vectors/purchase-request-mac.v1.json이다.
// 합의 왕복은 서버가 하는 식(node:crypto diffieHellman → hkdfSync → HMAC)을 이 시험 안에서 따로 계산해 견준다.
import { createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  PURCHASE_KEY_INFO,
  admissionClaims,
  b64u,
  bodyHash,
  createClientKeyPair,
  macInput,
  purchaseMac,
  requestKey,
  sharedSecret,
} from '../src/purchase/crypto';

interface Case {
  method: string;
  pathAndQuery: string;
  seq: number;
  body: string;
  bodySha256B64u: string;
  macInput: string;
  mac: string;
}
const V = JSON.parse(readFileSync(new URL('../../../docs/api/vectors/purchase-request-mac.v1.json', import.meta.url), 'utf8')) as {
  sharedSecretHex: string;
  jti: string;
  info: string;
  keyHex: string;
  cases: Case[];
};
const subtle = globalThis.crypto.subtle;
const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const utf8 = (s: string) => new TextEncoder().encode(s);

describe('FE-T7 서버와 같은 시험 벡터', () => {
  test('HKDF info는 벡터와 같다(판을 바꾸면 v2) [ASVS v5.0.0-11.2.2]', () => {
    expect(PURCHASE_KEY_INFO).toBe(V.info);
  });

  test('공유 비밀·jti → 요청 인증 키 32바이트(시험에서만 추출 가능으로 만들어 바이트를 본다) [ASVS v5.0.0-11.2.1]', async () => {
    const key = await requestKey(subtle, hex(V.sharedSecretHex), V.jti, true);
    expect(key.algorithm).toMatchObject({ name: 'HMAC', hash: { name: 'SHA-256' }, length: 256 });
    expect(Buffer.from(await subtle.exportKey('raw', key)).toString('hex')).toBe(V.keyHex);
  });

  test('요청 인증 키는 기본으로 추출 불가이고 서명에만 쓴다 [ASVS v5.0.0-11.6.1]', async () => {
    const key = await requestKey(subtle, hex(V.sharedSecretHex), V.jti);
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(['sign']);
    await expect(subtle.exportKey('raw', key)).rejects.toThrow();
  });

  test.each(V.cases.map((c) => [`${c.method} ${c.pathAndQuery}`, c] as const))('본문 해시·MAC 입력·MAC(SHA-256·HMAC-SHA256) [ASVS v5.0.0-11.4.1] [ASVS v5.0.0-11.4.3]: %s', async (_, c) => {
    expect(await bodyHash(subtle, utf8(c.body))).toBe(c.bodySha256B64u);
    expect(macInput(c.method, c.pathAndQuery, c.seq, c.bodySha256B64u)).toBe(c.macInput);
    const key = await requestKey(subtle, hex(V.sharedSecretHex), V.jti);
    expect(await purchaseMac(subtle, key, c.method, c.pathAndQuery, c.seq, utf8(c.body))).toBe(c.mac);
  });

  test('본문이 없으면 빈 바이트의 해시를 쓴다', async () => {
    expect(await bodyHash(subtle, new Uint8Array())).toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
  });
});

describe('키 합의 왕복: 브라우저 임시 키 쌍 × 서버 ECDH 키', () => {
  test('서버가 따로 계산한 요청 인증 키로 브라우저 MAC을 확인할 수 있다(ECDH P-256) [ASVS v5.0.0-11.2.3]', async () => {
    const server = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const serverJwk = server.publicKey.export({ format: 'jwk' });
    const client = await createClientKeyPair(subtle);
    // 공개키는 비압축 점(0x04 ‖ x ‖ y, 65바이트)의 base64url이다(openapi ClientEphemeralKey)
    const point = Buffer.from(client.publicKey, 'base64url');
    expect(point.length).toBe(65);
    expect(point[0]).toBe(4);
    expect(client.privateKey.extractable).toBe(false);

    const secret = await sharedSecret(subtle, client.privateKey, { kty: 'EC', crv: 'P-256', x: serverJwk.x!, y: serverJwk.y! });
    const jti = '01934b2e-7c1a-7d3e-9f40-000000000001';
    const key = await requestKey(subtle, secret, jti);
    const body = utf8('{"seatIds":["A-1"]}');
    const mac = await purchaseMac(subtle, key, 'POST', '/v1/events/evt-01/holds', 7, body);

    // 서버 쪽(packages/platform purchaseRequestKey와 같은 식)
    const clientKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) }, format: 'jwk' });
    const shared = diffieHellman({ privateKey: server.privateKey, publicKey: clientKey });
    expect(Buffer.from(secret).equals(shared)).toBe(true);
    const serverKey = Buffer.from(hkdfSync('sha256', shared, Buffer.from(jti, 'utf8'), Buffer.from(V.info, 'utf8'), 32));
    const input = `POST\n/v1/events/evt-01/holds\n7\n${createHash('sha256').update(body).digest('base64url')}`;
    expect(mac).toBe(createHmac('sha256', serverKey).update(input, 'utf8').digest('base64url'));
  });

  test('곡선 위의 점이 아닌 서버 공개키는 합의하지 않는다', async () => {
    const client = await createClientKeyPair(subtle);
    const bad = { kty: 'EC', crv: 'P-256', x: b64u(new Uint8Array(32).fill(1)), y: b64u(new Uint8Array(32).fill(2)) };
    await expect(sharedSecret(subtle, client.privateKey, bad)).rejects.toThrow();
  });

  test('P-256이 아닌 서버 키는 받지 않는다', async () => {
    const client = await createClientKeyPair(subtle);
    const other = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'jwk' });
    await expect(sharedSecret(subtle, client.privateKey, other as never)).rejects.toThrow();
  });
});

describe('입장 토큰 본문 읽기(서명 확인은 서버가 한다)', () => {
  const jwt = (payload: unknown) => `${b64u(utf8('{"alg":"ES256"}'))}.${b64u(utf8(JSON.stringify(payload)))}.c2ln`;
  test('jti와 exp(초)를 읽는다', () => {
    expect(admissionClaims(jwt({ jti: 'j-1', exp: 1_800_000_000, event: 'evt' }))).toEqual({ jti: 'j-1', exp: 1_800_000_000 });
    expect(admissionClaims(jwt({ jti: 'j-2' }))).toEqual({ jti: 'j-2' });
  });
  test.each([
    ['조각이 셋이 아님', 'a.b'],
    ['본문이 JSON이 아님', `x.${b64u(utf8('nope'))}.y`],
    ['jti 없음', jwt({ exp: 1 })],
    ['jti가 빈 글자', jwt({ jti: '' })],
    ['jti가 너무 김(서버 KEY_PART 64자)', jwt({ jti: 'j'.repeat(65) })],
    ['jti에 쓸 수 없는 글자', jwt({ jti: 'a/b' })],
    ['exp가 숫자가 아님', jwt({ jti: 'j', exp: '1' })],
    ['본문이 배열', jwt([1])],
  ])('모양이 틀리면 null: %s', (_, token) => {
    expect(admissionClaims(token)).toBeNull();
  });
});
