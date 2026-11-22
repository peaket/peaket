// R-622 독립 회귀 시험: scanner C1-01·C1-02·C1-03·C1-04·C1-05·C1-10·C1-11.
// 감사 보고서(reports/C1.md)와 offline-gate §6.3·§7.1·§7.2, O-T34의 계약을 응용 경계에서 고정한다.
// 이 파일은 R-609·R-610 수정 전 소스에서 실패하고 수정 뒤 통과하는 것을 확인했다(보고서 R-622).
import { fakeClock } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryScannerShiftStore } from '../src/modules/scanner/adapters/memory-scanner-shift-store.js';
import { ScannerGate, ScannerGateForbidden } from '../src/modules/scanner/application/scanner-gate.js';
import type { ScannerEventPolicyProvider } from '../src/modules/scanner/domain/ports.js';
import type { ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';

const NOW = Date.parse('2026-11-15T03:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000001';
const OTHER = '0190f3a1-7c2e-7a00-8000-000000000002';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000010';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000011';
const SESSION = '0190f3a1-7c2e-7a00-8000-000000000012';
const OTHER_SESSION = '0190f3a1-7c2e-7a00-8000-000000000013';
const UNKNOWN_SESSION = '0190f3a1-7c2e-7a00-8000-000000000014';

const ticketId = (n: number): string => `0190f3a1-7c2e-7a00-8000-${String(100 + n).padStart(12, '0')}`;
const T = {
  a: ticketId(1),
  b: ticketId(2),
  c: ticketId(3),
  d: ticketId(4),
  e: ticketId(5),
  f: ticketId(6),
  g: ticketId(7),
  h: ticketId(8),
  reentry: ticketId(9),
  cancelled: ticketId(10),
  idempotent: ticketId(11),
} as const;

let store: MemoryScannerGateStore;
let gate: ScannerGate;
let n = 0;

const scan = (over: Partial<ScanEventInput> = {}): ScanEventInput => ({
  id: `0190f3a1-7c2e-7a00-8000-${String(500 + n++).padStart(12, '0')}`,
  eventId: EVENT,
  ticketId: T.a,
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

/** 스태프 세션으로 올리는 기본 호출. 역할·세션 창은 시험마다 덮어쓴다 */
const upload = (
  body: ScanEventInput[],
  over: Partial<Parameters<ScannerGate['scans']>[0]> = {},
): ReturnType<ScannerGate['scans']> =>
  gate.scans({
    eventIdRaw: EVENT,
    sessionEventId: EVENT,
    deviceId: DEVICE,
    staffAccountId: ACCOUNT,
    sessionId: SESSION,
    role: 'gate_lead',
    body,
    ...over,
  });

beforeEach(() => {
  store = new MemoryScannerGateStore();
  for (const [i, id] of Object.values(T).entries()) {
    store.seedTicket({ ticketId: id, eventId: EVENT, seatId: `S-${i}`, gateZone: '동문', status: 'ACTIVE' });
  }
  // 취소 접수 시각이 있는 티켓. 이보다 이른 입장은 정상이어야 한다(C1-04).
  store.seedTicket({ ticketId: T.cancelled, eventId: EVENT, seatId: 'S-C', gateZone: '동문', status: 'REFUNDED', cancelledAtMs: NOW + 60_000 });
  gate = new ScannerGate({ store, clock: fakeClock({ now: NOW }) });
  n = 0;
});

describe('R-622 C1-01 OVERRIDE는 현장 책임자 본인 세션만 받는다', () => {
  test('I-T25 ① gate_staff·대리 승인·기기 단독은 403이고 아무 기록·표시·변경도 남기지 않는다', async () => {
    const s = scan({ method: 'OVERRIDE', overrideNote: '휴대폰 액정 파손' });
    for (const over of [
      { role: 'gate_staff' as const, proxy: false },
      { role: 'gate_lead' as const, proxy: true },
      { role: 'scanner_device' as const },
    ]) {
      await expect(upload([s], over)).rejects.toMatchObject({ name: 'ScannerGateOverrideForbidden' });
    }
    // 기기 단독 경로(스태프 세션 없음)도 같은 403이다.
    await expect(
      gate.scans({ eventIdRaw: EVENT, sessionEventId: undefined, deviceId: DEVICE, role: 'scanner_device', body: [s] }),
    ).rejects.toMatchObject({ name: 'ScannerGateOverrideForbidden' });

    expect(store.scans.size).toBe(0);
    expect(store.flags.size).toBe(0);
    expect((await store.changes({ eventId: EVENT, after: 0, limit: 10 })).changes).toEqual([]);
  });

  test('I-T25 ② gate_lead 본인의 OVERRIDE는 PASS로 저장하고 승인 계정을 감사 기록에 남긴다', async () => {
    const s = scan({ ticketId: T.b, method: 'OVERRIDE', reason: 'OVERRIDE_CAMERA', overrideNote: '카메라 고장, 신분증 확인' });
    const r = await upload([s], { role: 'gate_lead', proxy: false });
    expect(r.flags).toEqual([expect.objectContaining({ ticketId: T.b, kind: 'OVERRIDE_REVIEW', status: 'OPEN' })]);
    expect(store.scans.get(s.id)).toMatchObject({
      result: 'PASS',
      method: 'OVERRIDE',
      reason: 'OVERRIDE_CAMERA',
      overrideNote: '카메라 고장, 신분증 확인',
      flag: 'OVERRIDE_REVIEW',
      staffAccountId: ACCOUNT,
    });
    const page = await gate.listFlags({ eventIdRaw: EVENT, sessionEventId: EVENT, cursor: undefined, limit: 20 });
    expect(page.items).toEqual([expect.objectContaining({ ticketId: T.b, kind: 'OVERRIDE_REVIEW' })]);
  });

  test('한 묶음에 OVERRIDE가 섞이면 전체를 거절해 부분 저장이 없다', async () => {
    const normal = scan({ ticketId: T.c });
    const override = scan({ ticketId: T.d, method: 'OVERRIDE', overrideNote: '동행 확인' });
    await expect(upload([normal, override], { role: 'gate_staff' })).rejects.toMatchObject({ name: 'ScannerGateOverrideForbidden' });
    expect(store.scans.size).toBe(0);
    expect(store.flags.size).toBe(0);
  });
});

describe('R-622 C1-02 서버 재판정: 배치·구역·모드·세션 창·마감·시계', () => {
  test('배치가 없는 기기의 스태프 업로드는 403이고 기록하지 않는다', async () => {
    const shifts = new MemoryScannerShiftStore(store);
    const placed = new ScannerGate({ store, clock: fakeClock({ now: NOW }), shifts });
    await expect(
      placed.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [scan()] }),
    ).rejects.toBeInstanceOf(ScannerGateForbidden);
    expect(store.scans.size).toBe(0);
  });

  test('티켓 구역·본문 구역·배치 모드가 다르면 WRONG_ZONE으로 거부한다', async () => {
    const shifts = new MemoryScannerShiftStore(store);
    await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '서문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 0 });
    const placed = new ScannerGate({ store, clock: fakeClock({ now: NOW }), shifts });

    const ticketZone = scan({ ticketId: T.e });
    const r1 = await placed.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [ticketZone] });
    expect(store.scans.get(ticketZone.id)).toMatchObject({ result: 'REJECT', reason: 'WRONG_ZONE' });
    expect(r1.flags).toEqual([]);

    await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 1 });
    const bodyZone = scan({ ticketId: T.f, gateZone: '서문' });
    await placed.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [bodyZone] });
    expect(store.scans.get(bodyZone.id)).toMatchObject({ result: 'REJECT', reason: 'WRONG_ZONE' });

    await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'OUT', setBy: ACCOUNT, atMs: NOW, expectedVersion: 2 });
    const wrongMode = scan({ ticketId: T.g });
    await placed.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [wrongMode] });
    expect(store.scans.get(wrongMode.id)).toMatchObject({ result: 'REJECT', reason: 'WRONG_ZONE' });
  });

  test('세션 유효 창·입장 마감·시계 불확실의 경계를 표시한다', async () => {
    const shifts = new MemoryScannerShiftStore(store);
    await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 0 });
    const placedWith = (policy: ScannerEventPolicyProvider) => new ScannerGate({ store, clock: fakeClock({ now: NOW }), shifts, policy });
    const runWith =
      (placed: ScannerGate, over: Partial<Parameters<ScannerGate['scans']>[0]> = {}) =>
      (body: ScanEventInput[]) =>
        placed.scans({
          eventIdRaw: EVENT,
          sessionEventId: EVENT,
          deviceId: DEVICE,
          staffAccountId: ACCOUNT,
          sessionId: SESSION,
          role: 'gate_lead',
          sessionValidFromMs: NOW,
          sessionValidUntilMs: NOW + 10_000,
          ...over,
          body,
        });

    // 세션 유효 창 경계. 마감은 멀리 두어 다른 표시가 섞이지 않게 한다.
    const windowRun = runWith(placedWith({ get: async () => ({ promoterId: ACCOUNT, reentryAllowed: false, entryClosesAtMs: NOW + 60_000 }) }));
    const before = scan({ ticketId: T.a, scannedAtDevice: new Date(NOW - 1).toISOString() });
    expect((await windowRun([before])).flags.map((f) => f.kind)).toEqual(['OUT_OF_SESSION']);
    const atStart = scan({ ticketId: T.b, scannedAtDevice: new Date(NOW).toISOString() });
    expect((await windowRun([atStart])).flags).toEqual([]);
    const atEnd = scan({ ticketId: T.c, scannedAtDevice: new Date(NOW + 10_000).toISOString() });
    expect((await windowRun([atEnd])).flags).toEqual([]);
    const after = scan({ ticketId: T.d, scannedAtDevice: new Date(NOW + 10_001).toISOString() });
    expect((await windowRun([after])).flags.map((f) => f.kind)).toEqual(['OUT_OF_SESSION']);

    // 입장 마감 경계. 세션 창은 넓게 둔다.
    const closeRun = runWith(
      placedWith({ get: async () => ({ promoterId: ACCOUNT, reentryAllowed: false, entryClosesAtMs: NOW + 5_000 }) }),
      { sessionValidFromMs: NOW - 60_000, sessionValidUntilMs: NOW + 60_000 },
    );
    const atClose = scan({ ticketId: T.e, scannedAtDevice: new Date(NOW + 5_000).toISOString() });
    expect((await closeRun([atClose])).flags).toEqual([]);
    const afterClose = scan({ ticketId: T.f, scannedAtDevice: new Date(NOW + 5_001).toISOString() });
    expect((await closeRun([afterClose])).flags.map((f) => f.kind)).toEqual(['AFTER_CLOSE']);

    // 시계 불확실 경계. ±2분 정확히는 표시하지 않고 1ms 넘으면 표시한다.
    const clockRun = runWith(placedWith({ get: async () => ({ promoterId: ACCOUNT, reentryAllowed: false }) }), {
      sessionValidFromMs: NOW - 60_000,
      sessionValidUntilMs: NOW + 600_000,
    });
    const atUncertain = scan({ ticketId: T.g, scannedAtDevice: new Date(NOW + 2_000).toISOString(), clockOffsetMs: 2 * 60_000 });
    expect((await clockRun([atUncertain])).flags).toEqual([]);
    const uncertain = scan({ ticketId: T.h, scannedAtDevice: new Date(NOW + 2_000).toISOString(), clockOffsetMs: 2 * 60_000 + 1 });
    expect((await clockRun([uncertain])).flags.map((f) => f.kind)).toEqual(['TIME_UNCERTAIN']);
  });

  test('재입장 허용 회차의 IN 다음 IN은 NO_EXIT·CHECK다', async () => {
    const shifts = new MemoryScannerShiftStore(store);
    await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 0 });
    const placed = new ScannerGate({
      store,
      clock: fakeClock({ now: NOW }),
      shifts,
      policy: { get: async () => ({ promoterId: ACCOUNT, reentryAllowed: true }) },
    });
    const first = await placed.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [scan({ ticketId: T.reentry, scannedAtDevice: new Date(NOW + 10_000).toISOString() })] });
    expect(first.flags).toEqual([]);
    const second = await placed.scans({ eventIdRaw: EVENT, sessionEventId: EVENT, deviceId: DEVICE, staffAccountId: ACCOUNT, sessionId: SESSION, role: 'gate_lead', body: [scan({ ticketId: T.reentry, scannedAtDevice: new Date(NOW + 20_000).toISOString() })] });
    expect(second.flags).toEqual([expect.objectContaining({ kind: 'NO_EXIT' })]);
    expect(store.scans.get(second.acceptedIds[0]!)).toMatchObject({ result: 'CHECK', reason: 'NO_EXIT_RECORD' });
  });

  test('C1-10 package.reentryAllowed는 core 정책을 따르고, 못 읽으면 닫힌 쪽(false)이다', async () => {
    const open = new ScannerGate({ store, clock: fakeClock({ now: NOW }), policy: { get: async () => ({ promoterId: ACCOUNT, reentryAllowed: true }) } });
    expect((await open.package(EVENT, EVENT)).reentryAllowed).toBe(true);
    const broken = new ScannerGate({ store, clock: fakeClock({ now: NOW }), policy: { get: async () => Promise.reject(new Error('core down')) } });
    expect((await broken.package(EVENT, EVENT)).reentryAllowed).toBe(false);
    const absent = new ScannerGate({ store, clock: fakeClock({ now: NOW }) });
    expect((await absent.package(EVENT, EVENT)).reentryAllowed).toBe(false);
  });
});

describe('R-622 C1-11 기기 단독 업로드는 서버가 세션으로 계정·유효 창을 정한다', () => {
  test('세션 창 안 기록은 계정을 채우고 정상이며, 창 밖·모르는 세션·다른 회차는 OUT_OF_SESSION이다', async () => {
    const shifts = new MemoryScannerShiftStore(store);
    await shifts.putPlacement({ eventId: EVENT, deviceId: DEVICE, gateZone: '동문', mode: 'IN', setBy: ACCOUNT, atMs: NOW, expectedVersion: 0 });
    const calls: { scannerSessionId: string; deviceId: string }[] = [];
    const placed = new ScannerGate({
      store,
      clock: fakeClock({ now: NOW }),
      shifts,
      sessions: {
        check: async (q) => {
          calls.push(q);
          if (q.scannerSessionId === UNKNOWN_SESSION) throw new Error('세션 없음');
          if (q.scannerSessionId === OTHER_SESSION) {
            return { valid: false, eventId: OTHER, accountId: ticketId(99), validFromMs: NOW - 1_000, validUntilMs: NOW + 1_000 };
          }
          if (q.scannerSessionId === SESSION) {
            return { valid: false, eventId: EVENT, accountId: ACCOUNT, validFromMs: NOW - 1_000, validUntilMs: NOW + 1_000 };
          }
          return { valid: false, eventId: EVENT, accountId: ACCOUNT, validFromMs: NOW + 1_000, validUntilMs: NOW + 2_000 };
        },
      },
    });
    const deviceUpload = (s: ScanEventInput) =>
      placed.scans({ eventIdRaw: EVENT, sessionEventId: undefined, deviceId: DEVICE, body: [s] });

    const inWindow = scan({ ticketId: T.a, scannedAtDevice: new Date(NOW).toISOString() });
    const ok = await deviceUpload(inWindow);
    expect(ok.flags).toEqual([]);
    expect(store.scans.get(inWindow.id)).toMatchObject({ result: 'PASS', staffAccountId: ACCOUNT });

    const outWindowSession = '0190f3a1-7c2e-7a00-8000-000000000015';
    const outWindow = scan({ ticketId: T.b, scannerSessionId: outWindowSession, scannedAtDevice: new Date(NOW).toISOString() });
    const flagged = await deviceUpload(outWindow);
    expect(flagged.flags.map((f) => f.kind)).toEqual(['OUT_OF_SESSION']);
    // 창 밖이어도 서버가 세션에서 찾은 계정은 남는다(사람 귀속).
    expect(store.scans.get(outWindow.id)).toMatchObject({ staffAccountId: ACCOUNT });

    const unknown = scan({ ticketId: T.c, scannerSessionId: UNKNOWN_SESSION, scannedAtDevice: new Date(NOW).toISOString() });
    expect((await deviceUpload(unknown)).flags.map((f) => f.kind)).toEqual(['OUT_OF_SESSION']);
    expect(store.scans.get(unknown.id)?.staffAccountId).toBeUndefined();

    const otherEvent = scan({ ticketId: T.d, scannerSessionId: OTHER_SESSION, scannedAtDevice: new Date(NOW).toISOString() });
    expect((await deviceUpload(otherEvent)).flags.map((f) => f.kind)).toEqual(['OUT_OF_SESSION']);
    expect(store.scans.get(otherEvent.id)?.staffAccountId).toBeUndefined();

    expect(calls.every((c) => c.deviceId === DEVICE)).toBe(true);
  });
});

describe('R-622 C1-03 중복 IN은 보정 시각이 가장 이른 기록이 정상이다', () => {
  test('기기 시각+시계 오차가 더 이른 늦은 업로드가 정상이 되고, 먼저 통과한 기록은 DUPLICATE로 내린다', async () => {
    const later = scan({ ticketId: T.a, scannedAtDevice: new Date(NOW + 10_000).toISOString(), deviceSeq: 10 });
    expect((await upload([later])).flags).toEqual([]);
    // 기기 시각은 더 늦지만 -15초 보정으로 실제 입장은 5초로 앞선다.
    const earlier = scan({ ticketId: T.a, scannedAtDevice: new Date(NOW + 20_000).toISOString(), clockOffsetMs: -15_000, deviceSeq: 20 });
    const r = await upload([earlier]);
    expect(r.flags).toEqual([expect.objectContaining({ ticketId: T.a, kind: 'DUPLICATE' })]);
    expect(store.scans.get(earlier.id)).toMatchObject({ result: 'PASS' });
    expect(store.scans.get(later.id)).toMatchObject({ result: 'REJECT', reason: 'ALREADY_IN', flag: 'DUPLICATE' });
  });

  test('보정 시각이 같으면 기기 일련번호가 작은 기록이 정상이다', async () => {
    const highSeq = scan({ ticketId: T.b, scannedAtDevice: new Date(NOW + 10_000).toISOString(), deviceSeq: 5 });
    await upload([highSeq]);
    const lowSeq = scan({ ticketId: T.b, scannedAtDevice: new Date(NOW + 10_000).toISOString(), deviceSeq: 3 });
    await upload([lowSeq]);
    expect(store.scans.get(lowSeq.id)).toMatchObject({ result: 'PASS' });
    expect(store.scans.get(highSeq.id)).toMatchObject({ result: 'REJECT', reason: 'ALREADY_IN' });
  });

  test('더 이른 기록이 거듭 올라오면 앞서 통과한 IN을 모두 DUPLICATE로 내린다', async () => {
    const a = scan({ ticketId: T.c, scannedAtDevice: new Date(NOW + 30_000).toISOString(), deviceSeq: 30 });
    const b = scan({ ticketId: T.c, scannedAtDevice: new Date(NOW + 20_000).toISOString(), deviceSeq: 20 });
    const c = scan({ ticketId: T.c, scannedAtDevice: new Date(NOW + 10_000).toISOString(), deviceSeq: 10 });
    await upload([a]);
    await upload([b]);
    await upload([c]);
    expect(store.scans.get(c.id)).toMatchObject({ result: 'PASS' });
    expect(store.scans.get(b.id)).toMatchObject({ result: 'REJECT', reason: 'ALREADY_IN' });
    expect(store.scans.get(a.id)).toMatchObject({ result: 'REJECT', reason: 'ALREADY_IN' });
    expect([...store.flags.values()].map((f) => f.kind)).toEqual(['DUPLICATE', 'DUPLICATE']);
  });
});

describe('R-622 C1-04 AFTER_CANCEL은 취소 접수 시각과 비교한다', () => {
  test('취소 전 보정 시각의 입장은 PASS, 취소 뒤 입장만 TICKET_CANCELLED·AFTER_CANCEL이다', async () => {
    // 기기 시각은 취소 뒤지만 -40초 보정으로 취소 10초 전 입장이다.
    const before = scan({ ticketId: T.cancelled, scannedAtDevice: new Date(NOW + 90_000).toISOString(), clockOffsetMs: -40_000 });
    expect((await upload([before])).flags).toEqual([]);
    expect(store.scans.get(before.id)).toMatchObject({ result: 'PASS' });

    // 기기 시각은 취소 전이지만 +20초 보정으로 취소 10초 뒤 입장이다.
    const after = scan({ ticketId: T.cancelled, scannedAtDevice: new Date(NOW + 50_000).toISOString(), clockOffsetMs: 20_000 });
    const rejected = await upload([after]);
    expect(rejected.flags).toEqual([expect.objectContaining({ ticketId: T.cancelled, kind: 'AFTER_CANCEL' })]);
    expect(store.scans.get(after.id)).toMatchObject({ result: 'REJECT', reason: 'TICKET_CANCELLED' });
  });
});

describe('R-622 C1-05 changes.lastSeq는 페이지 끝 번호다', () => {
  test('limit 2로 5건을 페이지 끝까지 이어 받으면 빠짐·중복이 없다', async () => {
    const ids = [T.a, T.b, T.c, T.d, T.e];
    for (const [i, id] of ids.entries()) {
      await upload([scan({ ticketId: id, scannedAtDevice: new Date(NOW + (i + 1) * 1_000).toISOString() })]);
    }
    const seen: number[] = [];
    let after = 0;
    let pages = 0;
    let last;
    do {
      last = await gate.changes(EVENT, after, 2, EVENT);
      seen.push(...last.changes.map((c) => c.seq));
      if (last.changes.length > 0) expect(last.lastSeq).toBe(last.changes.at(-1)!.seq);
      after = last.lastSeq;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(5);
    } while (last.hasMore);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3);
  });

  test('같은 scanId 재전송은 처음 저장한 판정을 덮어쓰지 않는다', async () => {
    const s = scan({ ticketId: T.idempotent, result: 'PASS' });
    await upload([s]);
    const conflicting = { ...s, result: 'REJECT' as const, direction: 'OUT' as const, ticketId: T.a };
    const again = await upload([conflicting]);
    expect(again).toMatchObject({ acceptedIds: [s.id], flags: [], resyncRequired: false });
    expect(store.scans.get(s.id)).toMatchObject({ ticketId: T.idempotent, direction: 'IN', result: 'PASS' });
    expect((await store.changes({ eventId: EVENT, after: 0, limit: 10 })).changes).toHaveLength(1);
  });
});
