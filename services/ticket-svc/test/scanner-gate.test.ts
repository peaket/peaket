// 스캐너 목록·변경분·스캔 판정·이상 표시 시험(BUILD_ORDER GAT-180·GAT-190, offline-gate §6.3~§7.2).
import { fakeClock } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { ScannerFlagNotFound, ScannerGate, ScannerGateForbidden } from '../src/modules/scanner/application/scanner-gate.js';
import type { ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';

const NOW = Date.parse('2026-11-13T03:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000002';
const TICKET_A = '0190f3a1-7c2e-7a00-8000-000000000011';
const TICKET_B = '0190f3a1-7c2e-7a00-8000-000000000012';
const TICKET_CANCELLED = '0190f3a1-7c2e-7a00-8000-000000000013';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000021';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000022';
const SESSION = '0190f3a1-7c2e-7a00-8000-000000000023';
const OTHER_SESSION = '0190f3a1-7c2e-7a00-8000-000000000024';

let store: MemoryScannerGateStore;
let gate: ScannerGate;
let n = 0;

const scan = (over: Partial<ScanEventInput> = {}): ScanEventInput => ({
  id: `0190f3a1-7c2e-7a00-8000-${String(100 + n++).padStart(12, '0')}`,
  eventId: EVENT,
  ticketId: TICKET_A,
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
  store = new MemoryScannerGateStore();
  store.seedTicket({ ticketId: TICKET_A, eventId: EVENT, seatId: 'A-1', gateZone: '동문', status: 'ACTIVE' });
  store.seedTicket({ ticketId: TICKET_B, eventId: EVENT, seatId: 'B-2', gateZone: '서문', status: 'ACTIVE' });
  store.seedTicket({ ticketId: TICKET_CANCELLED, eventId: EVENT, seatId: 'C-3', gateZone: '동문', status: 'REFUNDED' });
  gate = new ScannerGate({ store, clock: fakeClock({ now: NOW }) });
});

describe('ScannerGate 목록·변경분 [GAT-180]', () => {
  test('패키지는 회차 티켓·구역·좌석 표시·상태·lastSeq를 주고, 다른 회차는 403이다', async () => {
    const p = await gate.package(EVENT, EVENT);
    expect(p).toMatchObject({ eventId: EVENT, reentryAllowed: false, gateZones: ['동문', '서문'], lastSeq: 0 });
    expect(p.tickets).toEqual([
      expect.objectContaining({ ticketId: TICKET_A, seatLabel: 'A-1', gateZone: '동문', status: 'ACTIVE', keys: [] }),
      expect.objectContaining({ ticketId: TICKET_B, seatLabel: 'B-2', gateZone: '서문' }),
      expect.objectContaining({ ticketId: TICKET_CANCELLED, status: 'REFUNDED' }),
    ]);
    await expect(gate.package(EVENT, OTHER)).rejects.toBeInstanceOf(ScannerGateForbidden);
  });

  test('O-T38 패키지의 lastSeq와 변경분 after가 같은 일련번호로 이어진다', async () => {
    await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [scan()] });
    const p = await gate.package(EVENT, EVENT);
    expect(p.lastSeq).toBe(1);
    expect((await gate.changes(EVENT, p.lastSeq, 5000, EVENT)).changes).toEqual([]);
    await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [scan({ direction: 'OUT' })] });
    const next = await gate.changes(EVENT, p.lastSeq, 5000, EVENT);
    expect(next.lastSeq).toBe(2);
    expect(next.changes).toEqual([expect.objectContaining({ seq: 2, kind: 'SCAN_STATE', payload: expect.objectContaining({ direction: 'OUT' }) })]);
  });

  test('변경분은 after 다음 일련번호부터 주고, 스캔 통과 뒤 SCAN_STATE가 쌓인다', async () => {
    await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [scan()] });
    const c = await gate.changes(EVENT, 0, 5000, EVENT);
    expect(c.lastSeq).toBe(1);
    expect(c.changes).toEqual([expect.objectContaining({ seq: 1, kind: 'SCAN_STATE', payload: expect.objectContaining({ ticketId: TICKET_A, direction: 'IN' }) })]);
    expect((await gate.changes(EVENT, 1, 5000, EVENT)).changes).toEqual([]);
  });
});

describe('ScannerGate 스캔 판정 [GAT-180]', () => {
  test('첫 IN은 통과하고, 같은 티켓의 두 번째 IN은 ALREADY_IN과 DUPLICATE 표시가 된다', async () => {
    const first = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [scan()] });
    expect(first.acceptedIds).toHaveLength(1);
    expect(first.flags).toEqual([]);
    const second = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [scan({ knownSeq: 1 })] });
    expect(second.flags).toEqual([expect.objectContaining({ ticketId: TICKET_A, kind: 'DUPLICATE', status: 'OPEN' })]);
    const changes = await gate.changes(EVENT, 0, 5000, EVENT);
    expect(changes.changes.map((x) => x.kind)).toEqual(['SCAN_STATE', 'FLAG']);
  });

  test('같은 scanId를 다시 보내면 받은 ID만 돌려주고 표시·변경을 더 만들지 않는다', async () => {
    const s = scan();
    const first = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [s] });
    const second = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [s] });
    expect(first.acceptedIds).toEqual([s.id]);
    expect(second).toEqual({ acceptedIds: [s.id], flags: [] });
    expect((await gate.changes(EVENT, 0, 5000, EVENT)).changes).toHaveLength(1);
  });

  test('없는 티켓은 UNKNOWN_TICKET, 취소 티켓은 TICKET_CANCELLED와 AFTER_CANCEL 표시다', async () => {
    const unknown = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [scan({ ticketId: '0190f3a1-7c2e-7a00-8000-000000000099' })] });
    expect(unknown.flags).toEqual([]);
    const cancelled = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [scan({ ticketId: TICKET_CANCELLED })] });
    expect(cancelled.flags).toEqual([expect.objectContaining({ ticketId: TICKET_CANCELLED, kind: 'AFTER_CANCEL' })]);
  });

  test('세션이 다른 기록은 OUT_OF_SESSION 표시를 달고, 다른 회차 업로드는 403이다', async () => {
    const out = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [scan({ scannerSessionId: OTHER_SESSION })] });
    expect(out.flags).toEqual([expect.objectContaining({ kind: 'OUT_OF_SESSION' })]);
    await expect(
      gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [scan({ eventId: OTHER })] }),
    ).rejects.toBeInstanceOf(ScannerGateForbidden);
  });
});

describe('ScannerGate 이상 표시 [GAT-190]', () => {
  test('이상 표시 목록·확인 결과를 남기고, 다른 회차 표시는 403·없는 표시는 404다', async () => {
    const scans = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [scan(), scan()] });
    const flag = scans.flags[0]!;
    const page = await gate.listFlags({ eventIdRaw: EVENT, sessionEventId: EVENT, cursor: undefined, limit: 20 });
    expect(page.items).toEqual([expect.objectContaining({ flagId: flag.flagId, status: 'OPEN', seatLabel: 'A-1', gateZone: '동문' })]);
    const resolved = await gate.resolveFlag({ eventIdRaw: EVENT, sessionEventId: EVENT, flagIdRaw: flag.flagId, status: 'SUSPECT', note: '확인 필요', resolvedBy: ACCOUNT });
    expect(resolved).toMatchObject({ flagId: flag.flagId, status: 'SUSPECT' });
    await expect(gate.resolveFlag({ eventIdRaw: EVENT, sessionEventId: EVENT, flagIdRaw: flag.flagId, status: 'OK', resolvedBy: ACCOUNT })).resolves.toMatchObject({ status: 'OK' });
    await expect(gate.resolveFlag({ eventIdRaw: OTHER, sessionEventId: OTHER, flagIdRaw: flag.flagId, status: 'OK', resolvedBy: ACCOUNT })).rejects.toBeInstanceOf(ScannerGateForbidden);
    await expect(gate.resolveFlag({ eventIdRaw: EVENT, sessionEventId: EVENT, flagIdRaw: '0190f3a1-7c2e-7a00-8000-000000000099', status: 'OK', resolvedBy: ACCOUNT })).rejects.toBeInstanceOf(ScannerFlagNotFound);
  });
});
