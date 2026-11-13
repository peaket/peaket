// 월렛 회전 QR v1·기기 키 단위 시험(BAT-350, GAT-010, FR-012, POL-018, ADR-0025·0051, offline-gate §3, O-T13).
// base45 RFC 9285 표본, 93바이트 QR v1 형식, WebCrypto ECDSA P-256 non-extractable 키, keyId, 15초 프레임을 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import QRCode from 'qrcode';
import { generateDeviceKey, importPublicKeyJwk, keyIdOfPublicKey, signQrV1, verifyQrV1 } from './device-key.ts';
import { createQrFrame, msUntilNextQrFrame, qrFrameIndex, qrFrameStale, qrTimeSeconds } from './frame.ts';
import {
  base45Decode,
  base45Encode,
  bytesToUuidV7,
  decodeQrV1,
  encodeQrV1,
  keyIdFromBase64Url,
  keyIdToBase64Url,
  qrV1Message,
  QR_V1_BASE45_LENGTH,
  QR_V1_BYTES,
  QR_V1_SIGNATURE_BYTES,
  QR_V1_VERSION,
  uint32BE,
  uint32FromBE,
  uuidV7ToBytes,
} from './qr-v1.ts';

const UUID = '0190f3a1-7c2e-7a00-8000-000000000101';
const KEY_ID = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);

test('base45는 RFC 9285 표본과 같고 93바이트를 140자로 만든다', () => {
  const enc = (s) => base45Encode(new TextEncoder().encode(s));
  assert.equal(enc('AB'), 'BB8');
  assert.equal(enc('Hello!!'), '%69 VD92EX0');
  assert.equal(enc('base-45'), 'UJCLQE7W581');
  assert.equal(enc('ietf!'), 'QED8WEX0');
  for (const s of ['AB', 'Hello!!', 'base-45', 'ietf!']) {
    assert.deepEqual(base45Decode(enc(s)), new TextEncoder().encode(s));
  }
  const bytes = Uint8Array.from({ length: QR_V1_BYTES }, (_, i) => (i * 37 + 11) & 0xff);
  const text = base45Encode(bytes);
  assert.equal(text.length, QR_V1_BASE45_LENGTH);
  assert.deepEqual(base45Decode(text), bytes);
});

test('base45 QR v1은 영숫자 모드로 실리고 140자가 QR 한 장에 들어간다', () => {
  const bytes = Uint8Array.from({ length: QR_V1_BYTES }, (_, i) => (i * 53 + 7) & 0xff);
  const qr = QRCode.create(base45Encode(bytes), { errorCorrectionLevel: 'M' });
  assert.equal(qr.segments[0].mode.id, 'Alphanumeric');
  assert.equal(qr.modules.size, qr.version * 4 + 17);
  assert.ok(qr.version <= 10);
});

test('QR v1은 UUIDv7 16바이트·keyId 8바이트·시각 4바이트 빅엔디언·서명 64바이트를 싣는다', () => {
  const id = uuidV7ToBytes(UUID);
  assert.equal(id.length, 16);
  assert.equal(id[6] >> 4, 7);
  assert.equal(bytesToUuidV7(id), UUID);
  assert.throws(() => uuidV7ToBytes('0190f3a1-7c2e-4a00-8000-000000000101'), /UUIDv7/);
  assert.throws(() => uuidV7ToBytes('0190f3a1-7c2e-7a00-0000-000000000101'), /변형/);
  assert.throws(() => uuidV7ToBytes('not-a-uuid'), /UUID/);
  assert.throws(() => base45Decode(':::'), /2바이트/);
  assert.throws(() => base45Decode('::'), /1바이트/);
  assert.throws(() => base45Decode('U6'), /1바이트/, '300은 1바이트를 넘는다');

  const signature = Uint8Array.from({ length: QR_V1_SIGNATURE_BYTES }, (_, i) => i);
  const bytes = encodeQrV1({ ticketId: UUID, keyId: KEY_ID, timeSeconds: 0x01020304, signature });
  assert.equal(bytes.length, QR_V1_BYTES);
  assert.equal(bytes[0], QR_V1_VERSION);
  assert.deepEqual(Array.from(bytes.slice(1, 17)), Array.from(id));
  assert.deepEqual(Array.from(bytes.slice(17, 25)), Array.from(KEY_ID));
  assert.deepEqual(Array.from(bytes.slice(25, 29)), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(bytes.slice(29)), Array.from(signature));

  const decoded = decodeQrV1(bytes);
  assert.equal(decoded.ticketId, UUID);
  assert.deepEqual(decoded.keyId, KEY_ID);
  assert.equal(decoded.timeSeconds, 0x01020304);
  assert.deepEqual(decoded.signature, signature);
  assert.equal(qrV1Message({ ticketId: UUID, keyId: KEY_ID, timeSeconds: 0x01020304 }).length, 40);
  assert.equal(new TextDecoder().decode(qrV1Message({ ticketId: UUID, keyId: KEY_ID, timeSeconds: 0 }).slice(0, 12)), 'PEAKET-QR-v1');

  assert.deepEqual(Array.from(uint32BE(0xffffffff)), [255, 255, 255, 255]);
  assert.equal(uint32FromBE(uint32BE(1_700_000_000)), 1_700_000_000);
  assert.throws(() => uint32BE(-1), /32비트/);
  assert.throws(() => uint32BE(0x1_0000_0000), /32비트/);
  assert.throws(() => decodeQrV1(Uint8Array.from([2, ...bytes.slice(1)])), /형식 버전/);
  assert.throws(() => decodeQrV1(bytes.slice(0, 92)), /93바이트/);
});

test('기기 키는 ECDSA P-256 non-extractable이고 keyId는 SPKI SHA-256 앞 8바이트다', async () => {
  const key = await generateDeviceKey();
  assert.equal(key.privateKey.extractable, false);
  assert.equal(key.privateKey.type, 'private');
  assert.equal(key.publicKey.type, 'public');
  assert.equal(key.publicKeyJwk.kty, 'EC');
  assert.equal(key.publicKeyJwk.crv, 'P-256');
  assert.equal(key.publicKeyJwk.x?.length, 43);
  assert.equal(key.publicKeyJwk.y?.length, 43);
  assert.equal(key.publicKeyJwk.d, undefined);
  assert.equal(key.keyId.length, 8);
  assert.equal(key.keyIdText.length, 11);
  assert.deepEqual(keyIdFromBase64Url(key.keyIdText), key.keyId);
  assert.equal(keyIdToBase64Url(key.keyId), key.keyIdText);

  const spki = await crypto.subtle.exportKey('spki', key.publicKey);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', spki)).slice(0, 8);
  assert.deepEqual(await keyIdOfPublicKey(key.publicKey), digest);
  assert.deepEqual(key.keyId, digest);

  const fields = { ticketId: UUID, keyId: key.keyId, timeSeconds: 1_700_000_000 };
  const signature = await signQrV1(key.privateKey, fields);
  assert.equal(signature.length, QR_V1_SIGNATURE_BYTES);
  assert.equal(await verifyQrV1(key.publicKey, fields, signature), true);
  const imported = await importPublicKeyJwk(key.publicKeyJwk);
  assert.equal(await verifyQrV1(imported, fields, signature), true);
  assert.equal(await verifyQrV1(imported, { ...fields, timeSeconds: fields.timeSeconds + 1 }, signature), false);
  assert.equal(await verifyQrV1(imported, { ...fields, ticketId: '0190f3a1-7c2e-7a00-8000-000000000102' }, signature), false);
});

test('O-T13_오프라인에서도 15초마다 새 서명 QR을 만들고_화면이 다시 보이면 그 시각으로 다시 서명한다', async () => {
  const key = await generateDeviceKey();
  const t = 1_700_000_000;
  const first = await createQrFrame(key, UUID, t);
  const second = await createQrFrame(key, UUID, t + 15);
  assert.equal(first.bytes.length, QR_V1_BYTES);
  assert.equal(first.text.length, QR_V1_BASE45_LENGTH);
  assert.notEqual(first.text, second.text);
  const firstDecoded = decodeQrV1(first.bytes);
  const secondDecoded = decodeQrV1(second.bytes);
  assert.equal(firstDecoded.timeSeconds, t);
  assert.equal(secondDecoded.timeSeconds, t + 15);
  assert.equal(await verifyQrV1(key.publicKey, firstDecoded, firstDecoded.signature), true);
  assert.equal(await verifyQrV1(key.publicKey, secondDecoded, secondDecoded.signature), true);
  assert.equal(qrFrameStale(firstDecoded.timeSeconds, t * 1000), false);
  assert.equal(qrFrameStale(firstDecoded.timeSeconds, (t + 15) * 1000), true);

  // 화면을 2분 끈 뒤 다시 보이면 그 순간(같은 15초 프레임)의 시각으로 다시 서명한다.
  const awake = await createQrFrame(key, UUID, t + 120);
  const awakeDecoded = decodeQrV1(awake.bytes);
  assert.equal(awakeDecoded.timeSeconds, t + 120);
  assert.equal(await verifyQrV1(key.publicKey, awakeDecoded, awakeDecoded.signature), true);

  assert.equal(qrFrameIndex(0), 0);
  assert.equal(qrFrameIndex(14_999), 0);
  assert.equal(qrFrameIndex(15_000), 1);
  assert.equal(msUntilNextQrFrame(0), 15_000);
  assert.equal(msUntilNextQrFrame(14_500), 500);
  assert.equal(msUntilNextQrFrame(15_000), 15_000);
  assert.equal(qrTimeSeconds(1_700_000_000_999), 1_700_000_000);
});
