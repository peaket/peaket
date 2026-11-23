// F-05-4 스캐너 QR v1 풀기·서명 검증 시험(계획 docs/review/plans/F-05-4.md §4 qr-v1.ts·§6 O-T33).
// 정본: docs/features/offline-gate.md §3(93바이트·base45·서명 대상)·§6.4 '스캐너 앱 판정 첫 구현' 1·6, 벡터 docs/api/vectors/qr-v1-device-key.v1.json.
// 새 모듈은 동적 불러오기로 읽는다: 모듈이 없으면 각 시험이 '함수가 있다'는 단언에서 떨어진다(파일이 불러오기에서 멈추지 않게).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { base45, b64u, fromHex, qrPayload, uuidBytes, walletKey } from './scanner-fixture.ts';

interface ScannedQr {
  version: 1;
  ticketId: string;
  keyId: string;
  timestampSec: number;
  message: Uint8Array;
  signature: Uint8Array;
}
type QrModule = {
  parseQrV1(raw: string): { ok: true; qr: ScannedQr } | { ok: false; reason: 'INVALID_QR' | 'UNSUPPORTED_VERSION' };
  verifyQrSignature(publicKey: string, qr: ScannedQr): Promise<boolean>;
};
const MODULE = '../src/judge/qr-v1.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as Partial<QrModule>;
function qr(): QrModule {
  for (const name of ['parseQrV1', 'verifyQrSignature'] as const) assert.equal(typeof loaded[name], 'function', `${MODULE}의 ${name}가 없다`);
  return loaded as QrModule;
}

interface Vector {
  keyIdB64u: string;
  compressedPublicKeyB64u: string;
  qr: { ticketId: string; timeSeconds: number; messageHex: string; signatureB64u: string; payloadHex: string; base45: string };
  negative: { tamperedSignatureB64u: string; tamperedMessageHex: string; otherKeyIdB64u: string };
}
const vector = JSON.parse(readFileSync(new URL('../../../docs/api/vectors/qr-v1-device-key.v1.json', import.meta.url), 'utf8')) as Vector;

function parsed(raw: string): ScannedQr {
  const r = qr().parseQrV1(raw);
  assert.equal(r.ok, true, `풀려야 한다: ${JSON.stringify(r)}`);
  return (r as { ok: true; qr: ScannedQr }).qr;
}

test('O-T33 벡터 QR v1(base45 140자)이 풀리고 티켓 ID·keyId·시각·서명 대상·서명이 벡터 값과 같다 [ASVS v5.0.0-2.1.1]', () => {
  // 도우미 base45가 벡터와 같은지 먼저 본다(아래 시험들이 만든 QR의 전제)
  assert.equal(base45(fromHex(vector.qr.payloadHex)), vector.qr.base45);
  assert.equal(vector.qr.base45.length, 140);
  const q = parsed(vector.qr.base45);
  assert.equal(q.version, 1);
  assert.equal(q.ticketId, vector.qr.ticketId);
  assert.equal(q.keyId, vector.keyIdB64u);
  assert.equal(q.timestampSec, vector.qr.timeSeconds);
  assert.equal(Buffer.from(q.message).toString('hex'), vector.qr.messageHex);
  assert.equal(b64u(q.signature), vector.qr.signatureB64u);
  assert.equal(q.signature.length, 64);
});

test('O-T33 벡터 압축 공개키로 벡터 서명이 맞고, 서명 한 바이트·시각 한 바이트를 바꾸면 틀린다 [ASVS v5.0.0-2.2.1]', async () => {
  const { verifyQrSignature } = qr();
  const q = parsed(vector.qr.base45);
  assert.equal(await verifyQrSignature(vector.compressedPublicKeyB64u, q), true);
  assert.equal(await verifyQrSignature(vector.compressedPublicKeyB64u, { ...q, signature: new Uint8Array(Buffer.from(vector.negative.tamperedSignatureB64u, 'base64url')) }), false);
  assert.equal(await verifyQrSignature(vector.compressedPublicKeyB64u, { ...q, message: fromHex(vector.negative.tamperedMessageHex) }), false);
});

test('O-T33 형식 버전이 0·2·255면 UNSUPPORTED_VERSION이다(93바이트여도, 길이가 달라도) [ASVS v5.0.0-2.1.1]', () => {
  const { parseQrV1 } = qr();
  const payload = fromHex(vector.qr.payloadHex);
  for (const v of [0, 2, 255]) {
    const p = payload.slice();
    p[0] = v;
    assert.deepEqual(parseQrV1(base45(p)), { ok: false, reason: 'UNSUPPORTED_VERSION' }, `버전 ${v}`);
  }
  const short = payload.slice(0, 50);
  short[0] = 2;
  assert.deepEqual(parseQrV1(base45(short)), { ok: false, reason: 'UNSUPPORTED_VERSION' });
});

test('O-T33 형식 버전 1인데 92·94바이트면 INVALID_QR이다(93바이트만 받는다) [ASVS v5.0.0-2.1.1]', () => {
  const { parseQrV1 } = qr();
  const payload = fromHex(vector.qr.payloadHex);
  assert.equal(payload.length, 93);
  assert.deepEqual(parseQrV1(base45(payload.slice(0, 92))), { ok: false, reason: 'INVALID_QR' });
  const longer = new Uint8Array(94);
  longer.set(payload);
  assert.deepEqual(parseQrV1(base45(longer)), { ok: false, reason: 'INVALID_QR' });
});

test('O-T33 빈 글·base45가 아닌 글자·풀리지 않는 base45는 INVALID_QR이다 [ASVS v5.0.0-2.1.1]', () => {
  const { parseQrV1 } = qr();
  assert.deepEqual(parseQrV1(''), { ok: false, reason: 'INVALID_QR' });
  // 소문자·#은 base45 글자가 아니다(RFC 9285 45글자)
  assert.deepEqual(parseQrV1(vector.qr.base45.toLowerCase()), { ok: false, reason: 'INVALID_QR' });
  assert.deepEqual(parseQrV1(`${vector.qr.base45.slice(0, 139)}#`), { ok: false, reason: 'INVALID_QR' });
  // 글자 수가 3으로 나눠 1이 남으면 풀리지 않는다
  assert.deepEqual(parseQrV1(`${vector.qr.base45}0`), { ok: false, reason: 'INVALID_QR' });
  // 세 글자 묶음 값이 65535를 넘으면 풀리지 않는다(':::' = 44 + 44×45 + 44×2025 = 91124)
  assert.deepEqual(parseQrV1(`${vector.qr.base45.slice(0, 135)}:::00`), { ok: false, reason: 'INVALID_QR' });
});

test('O-T33 시험이 만든 키(y 홀짝 둘 다)로 서명한 QR은 그 압축 공개키로 맞고 다른 키로는 틀린다 [ASVS v5.0.0-2.2.1]', async () => {
  const { verifyQrSignature } = qr();
  const seen = new Set<boolean>();
  const ticketId = '0190f3a1-7c2e-7a00-8b2a-6c1d5e70f199';
  for (let i = 0; i < 40 && seen.size < 2; i++) {
    const key = await walletKey();
    if (seen.has(key.yOdd)) continue;
    seen.add(key.yOdd);
    const other = await walletKey();
    const q = parsed(base45(await qrPayload(key, { ticketId, timestampSec: 1_795_651_215 })));
    assert.equal(q.ticketId, ticketId);
    assert.equal(q.keyId, key.keyId);
    assert.equal(Buffer.from(q.message.slice(12, 28)).toString('hex'), Buffer.from(uuidBytes(ticketId)).toString('hex'));
    assert.equal(await verifyQrSignature(key.publicKey, q), true, `y ${key.yOdd ? '홀수' : '짝수'}`);
    assert.equal(await verifyQrSignature(other.publicKey, q), false);
  }
  assert.equal(seen.size, 2, 'y 홀짝 두 경우를 모두 만들었다');
});

test('O-T33 압축 공개키를 읽지 못하면(길이·접두·곡선 밖 점) verifyQrSignature가 던진다 [ASVS v5.0.0-2.2.1]', async () => {
  const { verifyQrSignature } = qr();
  const q = parsed(vector.qr.base45);
  const good = new Uint8Array(Buffer.from(vector.compressedPublicKeyB64u, 'base64url'));
  const prefix04 = good.slice();
  prefix04[0] = 0x04;
  // x = p - 1 이 아닌, 곡선 위에 점이 없는 x(모두 0xff는 p보다 크다)
  const offCurve = new Uint8Array(33).fill(0xff);
  offCurve[0] = 0x02;
  for (const bad of ['', 'AAAA', b64u(good.slice(0, 32)), b64u(prefix04), b64u(offCurve)]) {
    await assert.rejects(verifyQrSignature(bad, q), `공개키 ${JSON.stringify(bad)}`);
  }
});
