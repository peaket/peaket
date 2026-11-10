// 구매 요청 인증 계산(k6·Node 공용, loadtest/lib/purchase-auth.mjs, BUILD_ORDER PRF-215 ④)이 서버(packages/platform/src/purchase-auth.ts)와 같은 결과인지 본다.
// 정해진 값은 서버·화면 시험과 같은 파일(docs/api/vectors/purchase-request-mac.v1.json)이고, 무작위 값은 node:crypto의 HKDF·HMAC(서버가 쓰는 함수)로 따로 계산해 견준다.
// 공유 비밀은 무대 도구(tools/local/v1-stage.mjs v1ClientKey)가 미리 계산한 값과 서버 개인키로 다시 계산한 값이 같은지도 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { admissionJti, b64url, bytesToHex, fromB64url, hexToBytes, MAX_PURCHASE_SEQ, PURCHASE_KEY_INFO, PurchaseSigner, purchaseMac, purchaseMacInput, purchaseRequestKey, utf8 } from '../lib/purchase-auth.mjs';
import { v1ClientKey, v1Keys, v1SharedSecret } from '../../tools/local/v1-stage.mjs';

const VECTORS = JSON.parse(readFileSync(new URL('../../docs/api/vectors/purchase-request-mac.v1.json', import.meta.url), 'utf8'));
/** Node 원시 함수(k6는 k6/crypto로 같은 것을 넘긴다) */
const node = {
  hmacSha256: (key, data) => new Uint8Array(createHmac('sha256', key).update(data).digest()),
  sha256: (data) => new Uint8Array(createHash('sha256').update(data).digest()),
};
/** 서버 규칙(packages/platform/src/purchase-auth.ts)을 node:crypto로 그대로 */
const server = {
  key: (secret, jti) => Buffer.from(hkdfSync('sha256', secret, Buffer.from(jti, 'utf8'), Buffer.from('PEAKET-purchase-v1', 'utf8'), 32)),
  input: (m, p, seq, body) => `${m}\n${p}\n${seq}\n${createHash('sha256').update(body).digest('base64url')}`,
  mac: (key, input) => createHmac('sha256', key).update(input, 'utf8').digest('base64url'),
};
/** 서명 없는 시험 JWT(본문만 읽는다) */
const jwt = (claims) => `${b64url(utf8(JSON.stringify({ alg: 'ES256', typ: 'admission+jwt' })))}.${b64url(utf8(JSON.stringify(claims)))}.c2ln`;

test('PRF215_정해진값_파일의_요청인증키와_MAC입력·MAC이_같다', () => {
  assert.equal(PURCHASE_KEY_INFO, VECTORS.info);
  const key = purchaseRequestKey(node, hexToBytes(VECTORS.sharedSecretHex), VECTORS.jti);
  assert.equal(bytesToHex(key), VECTORS.keyHex);
  assert.equal(VECTORS.cases.length, 4);
  for (const c of VECTORS.cases) {
    const input = purchaseMacInput(node, c.method, c.pathAndQuery, c.seq, utf8(c.body));
    assert.equal(input, c.macInput, c.pathAndQuery);
    assert.equal(purchaseMac(node, key, input), c.mac, c.pathAndQuery);
  }
});

test('PRF215_무작위_공유비밀·jti·본문에서_서버규칙(node:crypto HKDF·HMAC)과_같다', () => {
  for (let i = 0; i < 50; i += 1) {
    const secret = randomBytes(32);
    const jti = randomUUID();
    const body = JSON.stringify({ seatIds: [randomUUID(), `한글-${i}-😀`] });
    const seq = 1 + Math.floor(Math.random() * 1e9);
    const path = `/v1/events/${randomUUID()}/holds?i=${i}`;
    const key = purchaseRequestKey(node, new Uint8Array(secret), jti);
    assert.deepEqual(Buffer.from(key), server.key(secret, jti));
    const input = purchaseMacInput(node, 'POST', path, seq, utf8(body));
    assert.equal(input, server.input('POST', path, seq, Buffer.from(body, 'utf8')));
    assert.equal(purchaseMac(node, key, input), server.mac(server.key(secret, jti), input));
  }
});

test('PRF215_키의_salt는_jti다(다른 jti·같은 비밀이면 키가 다르다)', () => {
  const secret = hexToBytes(VECTORS.sharedSecretHex);
  const a = purchaseRequestKey(node, secret, VECTORS.jti);
  const b = purchaseRequestKey(node, secret, '01934b2e-7c1a-7d3e-9f40-6b2a8c1d5e71');
  assert.notEqual(bytesToHex(a), bytesToHex(b));
  assert.throws(() => purchaseRequestKey(node, secret, ''), /jti/);
  assert.throws(() => purchaseRequestKey(node, new Uint8Array(0), VECTORS.jti), /공유 비밀/);
});

test('PRF215_서명기는_입장토큰의_jti로_키를만들고_일련번호를_1부터_하나씩올린다(같은 요청도 번호마다 MAC이 다르다)', () => {
  const token = jwt({ iss: 'https://q', sub: randomUUID(), aud: 'purchase', jti: VECTORS.jti, sid: 's', event: 'e', jny: 'j', iat: 1, exp: 2 });
  assert.equal(admissionJti(token), VECTORS.jti);
  const s = new PurchaseSigner(node, hexToBytes(VECTORS.sharedSecretHex), token);
  const c0 = VECTORS.cases[0];
  const h1 = s.sign('POST', c0.pathAndQuery, c0.body);
  assert.deepEqual(h1, { 'x-purchase-seq': '1', 'x-purchase-mac': c0.mac });
  const h2 = s.sign('POST', c0.pathAndQuery, c0.body);
  const h3 = s.sign('POST', c0.pathAndQuery, c0.body);
  assert.deepEqual([h2['x-purchase-seq'], h3['x-purchase-seq']], ['2', '3']);
  assert.equal(h2['x-purchase-mac'], server.mac(Buffer.from(VECTORS.keyHex, 'hex'), server.input('POST', c0.pathAndQuery, 2, Buffer.from(c0.body))));
  assert.notEqual(h2['x-purchase-mac'], h1['x-purchase-mac']);
  assert.notEqual(h3['x-purchase-mac'], h2['x-purchase-mac']);
  // 상한 2^53 − 1 다음은 없다
  s.seq = MAX_PURCHASE_SEQ - 1;
  assert.equal(s.sign('DELETE', '/v1/holds/h', '')['x-purchase-seq'], String(MAX_PURCHASE_SEQ));
  assert.throws(() => s.sign('DELETE', '/v1/holds/h', ''), /일련번호/);
});

test('PRF215_입장토큰이_JWT가_아니거나_jti가_없으면_던진다', () => {
  assert.throws(() => admissionJti('a.b'), /JWT/);
  assert.throws(() => admissionJti(jwt({ sub: 'x' })), /jti/);
  assert.throws(() => admissionJti(`${b64url(utf8('{}'))}.!!!.x`), /본문/);
});

test('PRF215_바이트_도우미는_Node와_같다(UTF-8·16진수·base64url)', () => {
  for (const s of ['', 'a', 'ab', 'abc', '한글', '😀x', 'é\u0000']) {
    assert.deepEqual(Buffer.from(utf8(s)), Buffer.from(s, 'utf8'), s);
    assert.equal(b64url(utf8(s)), Buffer.from(s, 'utf8').toString('base64url'), s);
    assert.deepEqual(Buffer.from(fromB64url(Buffer.from(s, 'utf8').toString('base64url'))), Buffer.from(s, 'utf8'), s);
  }
  const r = randomBytes(37);
  assert.equal(bytesToHex(hexToBytes(r.toString('hex'))), r.toString('hex'));
  assert.throws(() => hexToBytes('abc'), /16진수/);
  assert.throws(() => hexToBytes('zz'), /16진수/);
  assert.throws(() => fromB64url('a+b'), /base64url/);
});

test('PRF215_무대가_미리계산한_클라이언트키의_공유비밀은_서버개인키로_다시계산한값과_같고_공개키는_87자_압축안한점이다', () => {
  const keys = v1Keys();
  const c = v1ClientKey(keys.ecdh.publicJwk);
  assert.match(c.clientPublicKey, /^[A-Za-z0-9_-]{87}$/);
  assert.equal(Buffer.from(c.clientPublicKey, 'base64url')[0], 4);
  assert.match(c.sharedSecretHex, /^[0-9a-f]{64}$/);
  assert.equal(v1SharedSecret(keys.ecdh.privateJwk, c.clientPublicKey), c.sharedSecretHex);
  // 다른 서버 키와는 맞지 않는다
  assert.notEqual(v1SharedSecret(v1Keys().ecdh.privateJwk, c.clientPublicKey), c.sharedSecretHex);
});
