// 월렛 keyId·QR v1을 구현과 따로 계산해 둔 시험 벡터로 맞추는 시험(BAT-350, GAT-010, O-T45 ①, ADR-0336 결정 6).
// 벡터: docs/api/vectors/qr-v1-device-key.v1.json(Node crypto로 따로 만든 공개키·keyId·QR v1·서명·base45). ticket-svc 시험이 같은 파일을 읽는다.
// 기대 값은 모두 벡터 파일에서 읽고, 월렛 코드의 상수를 가져오지 않는다. 93바이트·140자는 정본(offline-gate §11 O-T45 ①)의 값이다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { generateDeviceKey, importPublicKeyJwk, keyIdOfPublicKey, verifyQrV1 } from './device-key.ts';
import { base45Decode, base45Encode, decodeQrV1, encodeQrV1, keyIdFromBase64Url, keyIdToBase64Url, qrV1Message } from './qr-v1.ts';

const vector = JSON.parse(readFileSync(new URL('../../../../../docs/api/vectors/qr-v1-device-key.v1.json', import.meta.url), 'utf8'));
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const fromHex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const fromB64u = (t) => new Uint8Array(Buffer.from(t, 'base64url'));

test('O-T45 ① 월렛 keyId·QR v1·base45가 시험 벡터와 같고 서명이 맞으며 한 바이트 바꾸면 틀린다', async () => {
  // keyId: 벡터 공개키(두 모양 모두)에서 월렛 코드가 계산한 값이 벡터 값과 같다
  for (const jwk of [vector.publicKeyJwk, vector.publicKeyJwkAsExported]) {
    const pub = await importPublicKeyJwk(jwk);
    const keyId = await keyIdOfPublicKey(pub);
    assert.equal(hex(keyId), vector.keyIdHex);
    assert.equal(keyIdToBase64Url(keyId), vector.keyIdB64u);
    assert.equal(hex(keyIdFromBase64Url(vector.keyIdB64u)), vector.keyIdHex);
  }

  // QR v1: base45 140자를 풀면 93바이트이고, 칸이 벡터 값과 같다
  assert.equal(vector.qr.base45.length, 140);
  const payload = base45Decode(vector.qr.base45);
  assert.equal(payload.length, 93);
  assert.equal(hex(payload), vector.qr.payloadHex);
  assert.equal(payload[0], vector.qr.version);
  const decoded = decodeQrV1(payload);
  assert.equal(decoded.ticketId, vector.qr.ticketId);
  assert.equal(hex(decoded.keyId), vector.keyIdHex);
  assert.equal(decoded.timeSeconds, vector.qr.timeSeconds);
  assert.equal(Buffer.from(decoded.signature).toString('base64url'), vector.qr.signatureB64u);
  // 거꾸로 만들어도 같다(서명 대상·93바이트·base45)
  const fields = { ticketId: vector.qr.ticketId, keyId: fromHex(vector.keyIdHex), timeSeconds: vector.qr.timeSeconds };
  assert.equal(hex(qrV1Message(fields)), vector.qr.messageHex);
  assert.equal(new TextDecoder().decode(qrV1Message(fields).slice(0, 12)), vector.qr.header);
  assert.equal(hex(encodeQrV1({ ...fields, signature: fromB64u(vector.qr.signatureB64u) })), vector.qr.payloadHex);
  assert.equal(base45Encode(fromHex(vector.qr.payloadHex)), vector.qr.base45);

  // 서명이 맞는다
  const pub = await importPublicKeyJwk(vector.publicKeyJwkAsExported);
  assert.equal(await verifyQrV1(pub, decoded, decoded.signature), true);

  // 서명 한 바이트를 바꾸면 틀린다
  const tamperedSig = fromB64u(vector.negative.tamperedSignatureB64u);
  assert.equal(tamperedSig.length, 64);
  assert.equal([...tamperedSig].filter((b, i) => b !== decoded.signature[i]).length, 1, '벡터의 틀린 서명은 한 바이트만 다르다');
  assert.equal(await verifyQrV1(pub, decoded, tamperedSig), false);

  // 시각을 한 바이트 바꾼 서명 대상은 틀린다(서명 대상 끝 4바이트가 시각)
  const tamperedMessage = fromHex(vector.negative.tamperedMessageHex);
  const tamperedTime = Buffer.from(tamperedMessage).readUInt32BE(tamperedMessage.length - 4);
  assert.notEqual(tamperedTime, vector.qr.timeSeconds);
  const tamperedFields = { ...fields, timeSeconds: tamperedTime };
  assert.equal(hex(qrV1Message(tamperedFields)), vector.negative.tamperedMessageHex);
  assert.equal(await verifyQrV1(pub, tamperedFields, decoded.signature), false);

  // 다른 keyId를 실은 QR도 그 서명으로는 틀린다(keyId가 서명 대상에 든다)
  assert.equal(await verifyQrV1(pub, { ...fields, keyId: keyIdFromBase64Url(vector.negative.otherKeyIdB64u) }, decoded.signature), false);
});

test('O-T45 ① 월렛이 만든 공개키 JWK는 벡터의 내보낸 모양(publicKeyJwkAsExported)과 칸이 같다', async () => {
  // ticket-svc 시험(O-T45 ②)이 이 모양으로 등록하므로, 실제 월렛이 내보내는 칸과 같아야 그 시험이 월렛과 짝이 된다
  const key = await generateDeviceKey();
  assert.deepEqual(Object.keys(key.publicKeyJwk).sort(), Object.keys(vector.publicKeyJwkAsExported).sort());
  assert.equal(key.publicKeyJwk.ext, vector.publicKeyJwkAsExported.ext);
  assert.deepEqual(key.publicKeyJwk.key_ops, vector.publicKeyJwkAsExported.key_ops);
  assert.equal(key.publicKeyJwk.kty, vector.publicKeyJwkAsExported.kty);
  assert.equal(key.publicKeyJwk.crv, vector.publicKeyJwkAsExported.crv);
  assert.equal('d' in key.publicKeyJwk, false);
});
