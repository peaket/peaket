// 스캐너 목록의 유효 키·폐기 keyId와 스캔 시 keyId 대조 시험(BUILD_ORDER GAT-140, offline-gate §3·§6.4·§7.1).
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
