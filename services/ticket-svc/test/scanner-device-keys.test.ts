// 스캐너 목록의 유효 키·폐기 keyId와 스캔 시 keyId 대조 시험(BUILD_ORDER GAT-140, offline-gate §3·§6.4·§7.1).
import { createHash, createPublicKey, ECDH, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fakeClock } from '@peaket/platform';
import { exportJWK, generateKeyPair } from 'jose';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { ScannerGate } from '../src/modules/scanner/application/scanner-gate.js';
import type { ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';
import { MemoryDeviceKeyStore } from '../src/modules/ticket/adapters/memory-device-key-store.js';
import { DeviceKeys } from '../src/modules/ticket/application/device-keys.js';
import type { PublicKeyJwk } from '../src/modules/ticket/domain/device-key.js';

const NOW = Date.parse('2026-11-14T03:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const TICKET = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000004';
const SESSION = '0190f3a1-7c2e-7a00-8000-000000000005';
let n = 0;

async function jwk(): Promise<PublicKeyJwk> {
  return (await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)) as PublicKeyJwk;
}

let deviceKeys: MemoryDeviceKeyStore;
let gateStore: MemoryScannerGateStore;
let gate: ScannerGate;
let keys: DeviceKeys;
let reauthKeys: DeviceKeys;

const scan = (over: Partial<ScanEventInput> = {}): ScanEventInput => ({
  id: `0190f3a1-7c2e-7a00-8000-${String(200 + n++).padStart(12, '0')}`,
  eventId: EVENT,
  ticketId: TICKET,
  scannerSessionId: SESSION,
  direction: 'IN',
  method: 'QR',
  result: 'PASS',
  gateZone: '동문',
  scannedAtDevice: new Date(NOW + n).toISOString(),
  knownSeq: 0,
  deviceSeq: n,
  ...over,
});

beforeEach(() => {
  const clock = fakeClock({ now: NOW });
  deviceKeys = new MemoryDeviceKeyStore();
  deviceKeys.seedTicket({ ticketId: TICKET, eventId: EVENT, accountId: ACCOUNT });
  keys = new DeviceKeys({ store: deviceKeys, clock });
  reauthKeys = new DeviceKeys({ store: deviceKeys, clock, reauth: { verify: async () => true } });
  gateStore = new MemoryScannerGateStore(deviceKeys);
  gateStore.seedTicket({ ticketId: TICKET, eventId: EVENT, seatId: 'A-1', gateZone: '동문', status: 'ACTIVE' });
  gate = new ScannerGate({ store: gateStore, clock });
});

const scans = (body: ScanEventInput[]) => gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body });

describe('스캐너 기기 키 [GAT-140]', () => {
  test('목록은 유효 키를 싣고, 스캔의 keyId가 유효 키면 통과한다', async () => {
    const registered = await keys.register({ ticketId: TICKET, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await jwk(), reason: 'ISSUE' });
    const p = await gate.package(EVENT, EVENT);
    expect(p.tickets[0]!.keys).toEqual([expect.objectContaining({ keyId: registered.keyId, publicKey: expect.any(String) })]);
    expect(p.revokedKeyIds).toEqual([]);
    const r = await scans([scan({ keyId: registered.keyId })]);
    expect(r.acceptedIds).toHaveLength(1);
    expect(r.flags).toEqual([]);
    expect((await gateStore.changes({ eventId: EVENT, after: 0, limit: 10 })).changes.some((c) => c.kind === 'SCAN_STATE')).toBe(true);
  });

  test('모르는 keyId는 KEY_UNKNOWN, 형식이 틀린 keyId는 INVALID_QR로 거절한다', async () => {
    const r = await scans([scan({ keyId: 'AAAAAAAAAAA' })]);
    expect(r.acceptedIds).toHaveLength(1);
    expect(r.flags).toEqual([]);
    const stored = gateStore.scans.get(r.acceptedIds[0]!);
    expect(stored).toMatchObject({ result: 'REJECT', reason: 'KEY_UNKNOWN' });
    const bad = await scans([scan({ keyId: 'short' })]);
    expect(gateStore.scans.get(bad.acceptedIds[0]!)).toMatchObject({ result: 'REJECT', reason: 'INVALID_QR' });
  });

  test('키를 다시 등록하면 옛 keyId는 폐기 목록에 실리고 옛 QR은 KEY_REVOKED로 거절한다', async () => {
    const first = await keys.register({ ticketId: TICKET, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await jwk(), reason: 'ISSUE' });
    const second = await reauthKeys.register({ ticketId: TICKET, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: await jwk(), reason: 'ISSUE' });
    const p = await gate.package(EVENT, EVENT);
    expect(p.tickets[0]!.keys).toEqual([expect.objectContaining({ keyId: second.keyId })]);
    expect(p.revokedKeyIds).toEqual([first.keyId]);
    const r = await scans([scan({ keyId: first.keyId })]);
    expect(gateStore.scans.get(r.acceptedIds[0]!)).toMatchObject({ result: 'REJECT', reason: 'KEY_REVOKED' });
    const ok = await scans([scan({ keyId: second.keyId })]);
    expect(gateStore.scans.get(ok.acceptedIds[0]!)).toMatchObject({ result: 'PASS' });
  });
});

// 월렛 → 서버 → 스캐너 목록 → 스캔 대조의 keyId 맞물림(BAT-350, O-T45 ④⑤, offline-gate §2·§3, ADR-0336 결정 6).
// 기대 값은 구현과 따로 계산해 둔 시험 벡터(docs/api/vectors/qr-v1-device-key.v1.json)에서 읽고, 압축 공개키 풀기·서명 확인은 node:crypto로 따로 한다.
interface QrVector {
  publicKeyJwkAsExported: PublicKeyJwk;
  spkiDerB64u: string;
  keyIdB64u: string;
  compressedPublicKeyB64u: string;
  qr: { ticketId: string; messageHex: string; signatureB64u: string };
  negative: { tamperedSignatureB64u: string; otherKeyIdB64u: string };
}
const vector = JSON.parse(readFileSync(new URL('../../../docs/api/vectors/qr-v1-device-key.v1.json', import.meta.url), 'utf8')) as QrVector;
/** P-256 SPKI DER 머리(비압축 점 65바이트 앞, RFC 5480 id-ecPublicKey + prime256v1) */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

describe('스캐너 keyId 맞물림 [O-T45]', () => {
  const VT = vector.qr.ticketId;

  beforeEach(async () => {
    deviceKeys.seedTicket({ ticketId: VT, eventId: EVENT, accountId: ACCOUNT });
    gateStore.seedTicket({ ticketId: VT, eventId: EVENT, seatId: 'A-2', gateZone: '동문', status: 'ACTIVE' });
    expect(await keys.register({ ticketId: VT, accountId: ACCOUNT, sessionId: SESSION, publicKeyJwk: vector.publicKeyJwkAsExported, reason: 'ISSUE' })).toEqual({
      keyId: vector.keyIdB64u,
    });
  });

  test('O-T45 ④ 스캐너 목록 keys에 벡터 keyId·압축 공개키가 하나 있고 그 키로 벡터 서명이 확인된다', async () => {
    const p = await gate.package(EVENT, EVENT);
    const ticket = p.tickets.find((t) => t.ticketId === VT)!;
    expect(ticket.keys).toEqual([{ keyId: vector.keyIdB64u, publicKey: vector.compressedPublicKeyB64u }]);
    expect(p.revokedKeyIds).toEqual([]);

    // 목록의 압축 공개키(33바이트)를 풀어 SPKI를 만들면 벡터 SPKI와 같고, keyId(SPKI SHA-256 앞 8바이트)도 같다
    const compressed = Buffer.from(ticket.keys[0]!.publicKey, 'base64url');
    expect(compressed).toHaveLength(33);
    const point = Buffer.from(String(ECDH.convertKey(compressed, 'prime256v1', undefined, 'hex', 'uncompressed')), 'hex');
    expect(point).toHaveLength(65);
    const spki = Buffer.concat([P256_SPKI_PREFIX, point]);
    expect(spki.toString('base64url')).toBe(vector.spkiDerB64u);
    expect(createHash('sha256').update(spki).digest().subarray(0, 8).toString('base64url')).toBe(ticket.keys[0]!.keyId);

    // 그 키로 벡터 QR v1 서명이 확인되고, 한 바이트 바꾼 서명은 틀린다
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const message = Buffer.from(vector.qr.messageHex, 'hex');
    expect(verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(vector.qr.signatureB64u, 'base64url'))).toBe(true);
    expect(verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(vector.negative.tamperedSignatureB64u, 'base64url'))).toBe(false);
  });

  test('O-T45 ⑤ 등록한 keyId 스캔은 PASS, 다른 keyId는 KEY_UNKNOWN이다', async () => {
    // 다른 keyId를 먼저 올린다(거절은 입장 상태를 바꾸지 않아, 뒤의 PASS가 '이미 입장'에 섞이지 않는다)
    const unknown = await scans([scan({ ticketId: VT, keyId: vector.negative.otherKeyIdB64u })]);
    expect(unknown.acceptedIds).toHaveLength(1);
    expect(gateStore.scans.get(unknown.acceptedIds[0]!)).toMatchObject({ result: 'REJECT', reason: 'KEY_UNKNOWN' });
    const ok = await scans([scan({ ticketId: VT, keyId: vector.keyIdB64u })]);
    expect(ok.acceptedIds).toHaveLength(1);
    expect(gateStore.scans.get(ok.acceptedIds[0]!)).toMatchObject({ result: 'PASS' });
    expect(gateStore.scans.get(ok.acceptedIds[0]!)!.reason ?? null).toBeNull();
  });
});
