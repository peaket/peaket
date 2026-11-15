// 스캐너 목록·변경분·스캔 판정·이상 표시 시험(BUILD_ORDER GAT-180·GAT-190, offline-gate §6.3~§7.2).
import { fakeClock } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { ScannerFlagNotFound, ScannerGate, ScannerGateForbidden, ScannerGateOverrideForbidden } from '../src/modules/scanner/application/scanner-gate.js';
import type { ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';
import { normalizeVersionVector } from '../src/modules/scanner/domain/scanner-gate.js';

const NOW = Date.parse('2026-11-13T03:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000002';
const TICKET_A = '0190f3a1-7c2e-7a00-8000-000000000011';
const TICKET_B = '0190f3a1-7c2e-7a00-8000-000000000012';
const TICKET_CANCELLED = '0190f3a1-7c2e-7a00-8000-000000000013';
const TICKET_CANCELLED_AFTER = '0190f3a1-7c2e-7a00-8000-000000000014';
const TICKET_ZONE = '0190f3a1-7c2e-7a00-8000-000000000015';
const TICKET_REENTRY = '0190f3a1-7c2e-7a00-8000-000000000016';
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
  store.seedTicket({ ticketId: TICKET_CANCELLED_AFTER, eventId: EVENT, seatId: 'C-4', gateZone: '동문', status: 'REFUNDED', cancelledAtMs: NOW + 60_000 });
  store.seedTicket({ ticketId: TICKET_ZONE, eventId: EVENT, seatId: 'D-4', gateZone: '서문', status: 'ACTIVE' });
  store.seedTicket({ ticketId: TICKET_REENTRY, eventId: EVENT, seatId: 'E-5', gateZone: '동문', status: 'ACTIVE' });
  gate = new ScannerGate({ store, clock: fakeClock({ now: NOW }) });
});

describe('버전 벡터·동기화 신선도 [GAT-160]', () => {
  const vector = (over: Partial<import('../src/modules/scanner/domain/scanner-gate.js').ScannerVersionVector> = {}) => ({
    eventId: EVENT,
    seq: 0,
    ticketSeq: 0,
    keySeq: 0,
    policySeq: 0,
    placementSeq: 0,
    flagSeq: 0,
    issuedAt: new Date(NOW).toISOString(),
    maxOfflineMs: 24 * 60 * 60_000,
    ...over,
  });

  test('패키지·변경분은 종류별 마지막 일련번호와 오프라인 허용 시간을 준다 [O-T38]', async () => {
    const p = await gate.package(EVENT, EVENT);
    expect(p.versionVector).toEqual({
      eventId: EVENT,
      seq: 0,
      ticketSeq: 0,
      keySeq: 0,
      policySeq: 0,
      placementSeq: 0,
      flagSeq: 0,
      issuedAt: new Date(NOW).toISOString(),
      maxOfflineMs: 24 * 60 * 60_000,
    });
    const s = scan();
    await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [s] });
    const c = await gate.changes(EVENT, 0, 10, EVENT);
    expect(c.versionVector).toMatchObject({ eventId: EVENT, seq: 1, ticketSeq: 0, keySeq: 0, policySeq: 0, placementSeq: 0, flagSeq: 0, maxOfflineMs: 24 * 60 * 60_000 });
  });

  test('오프라인 허용 시간을 넘긴 버전 벡터로 판정하면 STALE_VERSION 표시와 재동기화를 요구한다', async () => {
    const stale = scan({ versionVector: vector({ issuedAt: new Date(NOW - 25 * 60 * 60_000).toISOString() }) });
    const r = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [stale] });
    expect(r).toMatchObject({ resyncRequired: true, staleIds: [stale.id] });
    expect(r.flags).toEqual([expect.objectContaining({ kind: 'STALE_VERSION', ticketId: TICKET_A })]);
    expect((await store.changes({ eventId: EVENT, after: 0, limit: 10 })).changes.some((c) => c.kind === 'FLAG')).toBe(true);
  });

  test('허용 시간 안의 버전 벡터는 재동기화를 요구하지 않고, 회차가 다른 벡터는 거절한다', async () => {    const fresh = scan({ versionVector: vector() });
    const r = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [fresh] });
    expect(r).toMatchObject({ resyncRequired: false, staleIds: [] });
    expect(r.flags).toEqual([]);

    const exact = scan({ versionVector: vector({ issuedAt: new Date(NOW - 24 * 60 * 60_000).toISOString() }) });
    const r2 = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [exact] });
    expect(r2).toMatchObject({ resyncRequired: false, staleIds: [] });

    const wrong = scan({ versionVector: vector({ eventId: OTHER }) });
    await expect(gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, body: [wrong] })).rejects.toThrow();
  });

  test('음수 seq·다른 회차 벡터는 모양 검사에서 거절한다', () => {
    expect(() => normalizeVersionVector(vector({ seq: -1 }), EVENT)).toThrow();
    expect(() => normalizeVersionVector(vector({ eventId: OTHER }), EVENT)).toThrow();
    expect(() => normalizeVersionVector({ ...vector(), maxOfflineMs: -1 }, EVENT)).toThrow();
  });
});

describe('ScannerGate 목록·변경분 [GAT-180]', () => {
  test('패키지는 회차 티켓·구역·좌석 표시·상태·lastSeq를 주고, 다른 회차는 403이다', async () => {
    const p = await gate.package(EVENT, EVENT);
    expect(p).toMatchObject({ eventId: EVENT, reentryAllowed: false, gateZones: ['동문', '서문'], lastSeq: 0 });
    expect(p.tickets).toEqual(expect.arrayContaining([
      expect.objectContaining({ ticketId: TICKET_A, seatLabel: 'A-1', gateZone: '동문', status: 'ACTIVE', keys: [] }),
      expect.objectContaining({ ticketId: TICKET_B, seatLabel: 'B-2', gateZone: '서문' }),
      expect.objectContaining({ ticketId: TICKET_CANCELLED, status: 'REFUNDED' }),
    ]));
    expect(p.tickets).toHaveLength(6);
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

  test('changes.lastSeq는 페이지 끝 번호이고, 그 번호를 다음 커서로 이어 받는다(C1-05)', async () => {
    await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [scan({ ticketId: TICKET_A }), scan({ ticketId: TICKET_B })] });
    await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [scan({ ticketId: TICKET_A, direction: 'OUT' })] });
    const p1 = await gate.changes(EVENT, 0, 1, EVENT);
    expect(p1).toMatchObject({ lastSeq: 1, hasMore: true });
    const p2 = await gate.changes(EVENT, p1.lastSeq, 1, EVENT);
    expect(p2).toMatchObject({ lastSeq: 2, hasMore: true });
    const p3 = await gate.changes(EVENT, p2.lastSeq, 5, EVENT);
    expect(p3).toMatchObject({ lastSeq: 3, hasMore: false });
    expect(p3.changes).toEqual([expect.objectContaining({ seq: 3, kind: 'SCAN_STATE' })]);
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
    expect(second).toEqual({ acceptedIds: [s.id], flags: [], resyncRequired: false, staleIds: [] });
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

  test('변경분을 받으면 그 기기의 last_changes_at을 기록한다', async () => {
    const touched: { deviceId: string; atMs: number }[] = [];
    const deviceGate = new ScannerGate({ store, clock: fakeClock({ now: NOW }), devices: { touchChanges: async (deviceId, atMs) => void touched.push({ deviceId, atMs }) } });
    await deviceGate.changes(EVENT, 0, 100, EVENT, DEVICE);
    expect(touched).toEqual([{ deviceId: DEVICE, atMs: NOW }]);
  });

  test('스태프 토큰이 없어도 그 회차에 배치된 기기면 업로드를 받고, 배치가 없으면 403이다', async () => {
    const shifts = new MemoryScannerShiftStore(store);
    await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 0 });
    const deviceGate = new ScannerGate({ store, clock: fakeClock({ now: NOW }), shifts });
    const accepted = await deviceGate.scans({ eventIdRaw: EVENT, sessionEventId: undefined, deviceId: DEVICE, body: [scan()] });
    expect(accepted.acceptedIds).toHaveLength(1);
    expect(accepted.flags).toEqual([expect.objectContaining({ kind: 'OUT_OF_SESSION', status: 'OPEN' })]);
    await expect(deviceGate.scans({ eventIdRaw: EVENT, sessionEventId: undefined, deviceId: '0190f3a1-7c2e-7a00-8000-000000000099', body: [scan()] })).rejects.toBeInstanceOf(ScannerGateForbidden);
  });
});

describe('R-609 C1-01 예외 통과 권한·사후 검토', () => {
  test('gate_lead 본인만 OVERRIDE를 받고 flag·note를 남긴다. 일반 스태프·대리·기기 단독은 403', async () => {
    const s = scan({ method: 'OVERRIDE', overrideNote: '휴대폰 액정 파손', knownSeq: 0 });
    await expect(
      gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_staff', body: [s] }),
    ).rejects.toBeInstanceOf(ScannerGateOverrideForbidden);
    await expect(
      gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', proxy: true, body: [s] }),
    ).rejects.toBeInstanceOf(ScannerGateOverrideForbidden);
    await expect(gate.scans({ eventIdRaw: EVENT, sessionEventId: undefined, deviceId: DEVICE, role: 'scanner_device', body: [s] })).rejects.toBeInstanceOf(ScannerGateOverrideForbidden);

    const ok = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [s] });
    expect(ok.flags).toEqual([expect.objectContaining({ kind: 'OVERRIDE_REVIEW', ticketId: TICKET_A })]);
    expect(store.scans.get(s.id)).toMatchObject({ result: 'PASS', method: 'OVERRIDE', overrideNote: '휴대폰 액정 파손', flag: 'OVERRIDE_REVIEW' });
  });
});

describe('R-610 C1-03·C1-04 중복 입장·취소 시각', () => {
  test('늦게 올라온 더 이른 보정 시각 기록이 정상이 되고, 먼저 통과한 뒤 기록은 DUPLICATE로 내린다', async () => {
    const late = scan({ scannedAtDevice: new Date(NOW + 20_000).toISOString(), deviceSeq: 20 });
    const first = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [late] });
    expect(first.flags).toEqual([]);
    const early = scan({ scannedAtDevice: new Date(NOW + 10_000).toISOString(), deviceSeq: 10 });
    const second = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [early] });
    expect(second.flags).toEqual([expect.objectContaining({ kind: 'DUPLICATE' })]);
    expect(store.scans.get(early.id)).toMatchObject({ result: 'PASS' });
    expect(store.scans.get(late.id)).toMatchObject({ result: 'REJECT', reason: 'ALREADY_IN', flag: 'DUPLICATE' });
  });

  test('취소 접수 시각보다 이른 입장은 PASS이고, 그 뒤 입장만 TICKET_CANCELLED·AFTER_CANCEL이다', async () => {
    const before = scan({ ticketId: TICKET_CANCELLED_AFTER, scannedAtDevice: new Date(NOW + 30_000).toISOString() });
    const ok = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [before] });
    expect(ok.flags).toEqual([]);
    expect(store.scans.get(before.id)).toMatchObject({ result: 'PASS' });

    const after = scan({ ticketId: TICKET_CANCELLED_AFTER, scannedAtDevice: new Date(NOW + 90_000).toISOString() });
    const rejected = await gate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [after] });
    expect(rejected.flags).toEqual([expect.objectContaining({ kind: 'AFTER_CANCEL' })]);
    expect(store.scans.get(after.id)).toMatchObject({ result: 'REJECT', reason: 'TICKET_CANCELLED' });
  });
});

describe('R-609 C1-02·C1-11 서버 재판정', () => {
  const policy = (over: Record<string, unknown> = {}) => ({ get: async () => ({ promoterId: ACCOUNT, reentryAllowed: false, ...over }) });

  test('배치 구역·모드가 다르면 WRONG_ZONE으로 거부한다', async () => {
    const shifts = new MemoryScannerShiftStore(store);
    await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '서문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 0 });
    const placed = new ScannerGate({ store, clock: fakeClock({ now: NOW }), shifts, policy: policy() });
    const wrongZone = await placed.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [scan({ ticketId: TICKET_ZONE })] });
    expect(wrongZone.flags).toEqual([]);
    expect(store.scans.get(wrongZone.acceptedIds[0]!)).toMatchObject({ result: 'REJECT', reason: 'WRONG_ZONE' });

    await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'OUT', setBy: ACCOUNT, atMs: NOW, expectedVersion: 1 });
    const wrongMode = await placed.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [scan({ ticketId: TICKET_A })] });
    expect(store.scans.get(wrongMode.acceptedIds[0]!)).toMatchObject({ result: 'REJECT', reason: 'WRONG_ZONE' });
  });

  test('세션 유효 창 밖·입장 마감 뒤·시계 불확실을 표시하고, 재입장 허용의 IN 다음 IN은 NO_EXIT다', async () => {
    const shifts = new MemoryScannerShiftStore(store);
    await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 0 });
    const placed = new ScannerGate({
      store,
      clock: fakeClock({ now: NOW }),
      shifts,
      policy: policy({ reentryAllowed: true, entryClosesAtMs: NOW - 1_000 }),
      sessions: { check: async () => ({ valid: false, eventId: EVENT, accountId: ACCOUNT, validFromMs: NOW - 1_000, validUntilMs: NOW + 1_000 }) },
    });
    await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 1 });
    const outside = await placed.scans({
      eventIdRaw: EVENT,
      sessionEventId: EVENT,
      deviceId: DEVICE,
      staffAccountId: ACCOUNT,
      sessionId: SESSION,
      role: 'gate_lead',
      sessionValidFromMs: NOW + 3_600_000,
      sessionValidUntilMs: NOW + 7_200_000,
      body: [scan({ clockOffsetMs: 3 * 60_000 })],
    });
    expect(outside.flags.map((f) => f.kind).sort()).toEqual(['AFTER_CLOSE', 'OUT_OF_SESSION', 'TIME_UNCERTAIN']);

    const reentryGate = new ScannerGate({ store, clock: fakeClock({ now: NOW }), shifts, policy: policy({ reentryAllowed: true }) });
    const first = await reentryGate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [scan({ ticketId: TICKET_REENTRY, scannedAtDevice: new Date(NOW + 10_000).toISOString() })] });
    expect(first.flags).toEqual([]);
    const second = await reentryGate.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [scan({ ticketId: TICKET_REENTRY, scannedAtDevice: new Date(NOW + 20_000).toISOString() })] });
    expect(second.flags).toEqual([expect.objectContaining({ kind: 'NO_EXIT' })]);
    expect(store.scans.get(second.acceptedIds[0]!)).toMatchObject({ result: 'CHECK', reason: 'NO_EXIT_RECORD' });
  });

  test('기기 단독 업로드는 scannerSessionId의 계정을 채우고, 기록 시각이 세션 창 안이면 정상이다', async () => {
    const shifts = new MemoryScannerShiftStore(store);
    await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 0 });
    const deviceGate = new ScannerGate({
      store,
      clock: fakeClock({ now: NOW }),
      shifts,
      sessions: { check: async () => ({ valid: false, eventId: EVENT, accountId: ACCOUNT, validFromMs: NOW - 1_000, validUntilMs: NOW + 1_000 }) },
    });
    const s = scan({ scannedAtDevice: new Date(NOW).toISOString() });
    const accepted = await deviceGate.scans({ eventIdRaw: EVENT, sessionEventId: undefined, deviceId: DEVICE, body: [s] });
    expect(accepted.flags).toEqual([]);
    expect(store.scans.get(s.id)).toMatchObject({ result: 'PASS', staffAccountId: ACCOUNT });
  });

  test('목록의 reentryAllowed는 core 정책에서 채운다', async () => {
    const policyGate = new ScannerGate({ store, clock: fakeClock({ now: NOW }), policy: policy({ reentryAllowed: true }) });
    expect((await policyGate.package(EVENT, EVENT)).reentryAllowed).toBe(true);
  });
});
