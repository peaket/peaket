// F-05-4 서버 판정의 보정 시각 시험(시험 리뷰 RV-02, 계획 docs/review/plans/F-05-4.md §2의 4).
// 정본: docs/features/offline-gate.md §7.1 '보정 시각을 두 번 더하지 않는다'(올라온 scannedAtDevice가 이미 보정 시각이고, 순서·취소 뒤·세션 밖·마감 뒤는
// 그 값을 그대로 쓴다. clockOffsetMs는 '시각 불확실'에만), openapi ScanEvent.scannedAtDevice.
// 오차를 ±60,000ms로 골라 두 번 더하면 판정이 뒤집히게 했다(양쪽 방향). 저장소는 진짜 메모리 어댑터, Drizzle 짝은 test-int/scanner-f054.int.test.ts가 같은 꼴로 본다.
import { beforeEach, describe, expect, test } from 'vitest';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import type { ScanEventInput } from '../src/modules/scanner/domain/scanner-gate.js';

const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000f5601';
const TICKET = '0190f3a1-7c2e-7a00-8000-0000000f5602';
const CANCELLED = '0190f3a1-7c2e-7a00-8000-0000000f5603';
const DEVICE = '0190f3a1-7c2e-7a00-8000-0000000f5604';
const SESSION = '0190f3a1-7c2e-7a00-8000-0000000f5605';
const iso = (ms: number) => new Date(ms).toISOString();

let store: MemoryScannerGateStore;
let n = 0;
const scan = (atMs: number, clockOffsetMs: number, over: Partial<ScanEventInput> = {}): ScanEventInput => ({
  id: `0190f3a1-7c2e-7f00-8000-${String(++n).padStart(12, '0')}`,
  eventId: EVENT,
  ticketId: TICKET,
  scannerSessionId: SESSION,
  direction: 'IN',
  method: 'QR',
  result: 'PASS',
  gateZone: '동문',
  scannedAtDevice: iso(atMs),
  clockOffsetMs,
  knownSeq: 0,
  deviceSeq: n,
  ...over,
});
const accept = (scans: ScanEventInput[], o: { validUntilMs?: number; entryClosesAtMs?: number } = {}) =>
  store.acceptScans({
    eventId: EVENT,
    deviceId: DEVICE,
    sessionId: SESSION,
    sessions: { [SESSION]: { accountId: 'acc', validFromMs: T0 - 3_600_000, validUntilMs: o.validUntilMs ?? T0 + 3_600_000 } },
    ...(o.entryClosesAtMs !== undefined ? { entryClosesAtMs: o.entryClosesAtMs } : {}),
    scans,
    nowMs: T0 + 600_000,
  });
const flagOf = (id: string) => store.scans.get(id)!.flag;

beforeEach(() => {
  store = new MemoryScannerGateStore();
  store.seedTicket({ ticketId: TICKET, eventId: EVENT, seatId: 'A-1', gateZone: '동문', status: 'ACTIVE' });
  store.seedTicket({ ticketId: CANCELLED, eventId: EVENT, seatId: 'A-2', gateZone: '동문', status: 'REFUNDED', cancelledAtMs: T0 });
});

describe('보정 시각 = scannedAtDevice [RV-02]', () => {
  test('GAT-160 세션 밖 기록은 scannedAtDevice만으로 정한다(끝 30초 전 + 오차 +60초는 세션 안, 끝 30초 뒤 + 오차 −60초는 세션 밖)', async () => {
    const inside = scan(T0 - 30_000, 60_000);
    await accept([inside], { validUntilMs: T0 });
    expect(flagOf(inside.id)).toBe('NONE');
    const outside = scan(T0 + 30_000, -60_000, { ticketId: '0190f3a1-7c2e-7a00-8000-0000000f5607' });
    store.seedTicket({ ticketId: outside.ticketId, eventId: EVENT, seatId: 'A-4', gateZone: '동문', status: 'ACTIVE' });
    await accept([outside], { validUntilMs: T0 });
    expect(flagOf(outside.id)).toBe('OUT_OF_SESSION');
  });

  test('GAT-160 취소 뒤 입장은 scannedAtDevice로 정한다(취소 30초 전 + 오차 +60초 기록은 취소 전 입장이라 거부·취소 뒤 표시가 없다)', async () => {
    const before = scan(T0 - 30_000, 60_000, { ticketId: CANCELLED });
    await accept([before]);
    expect(store.scans.get(before.id)!.reason).not.toBe('TICKET_CANCELLED');
    expect([...store.flags.values()].filter((f) => f.kind === 'AFTER_CANCEL')).toEqual([]);
    const after = scan(T0 + 30_000, -60_000, { ticketId: CANCELLED });
    await accept([after]);
    expect(store.scans.get(after.id)!.reason).toBe('TICKET_CANCELLED');
  });

  test('GAT-160 중복 입장의 가장 이른 기록은 scannedAtDevice로 고른다(나중에 올라온 더 이른 기록이 정상, 먼저 통과한 기록이 중복)', async () => {
    const later = scan(T0 + 10_000, 0);
    await accept([later]);
    // 기기 시계가 늦어 오차 +60초를 더한 보정 시각 T0+5초: 두 번 더하면 T0+65초가 되어 뒤집힌다
    const earlier = scan(T0 + 5_000, 60_000);
    await accept([earlier]);
    expect(store.scans.get(earlier.id)!.result).toBe('PASS');
    expect(flagOf(later.id)).toBe('DUPLICATE');
  });

  test('GAT-160 마감 뒤 도착은 scannedAtDevice로 정한다(마감 30초 전 + 오차 +60초는 마감 전, 마감 30초 뒤 + 오차 −60초는 마감 뒤)', async () => {
    const s1 = scan(T0 - 30_000, 60_000);
    await accept([s1], { entryClosesAtMs: T0 });
    expect(flagOf(s1.id)).toBe('NONE');
    const s2 = scan(T0 + 30_000, -60_000, { ticketId: '0190f3a1-7c2e-7a00-8000-0000000f5606' });
    store.seedTicket({ ticketId: s2.ticketId, eventId: EVENT, seatId: 'A-3', gateZone: '동문', status: 'ACTIVE' });
    await accept([s2], { entryClosesAtMs: T0 });
    expect(flagOf(s2.id)).toBe('AFTER_CLOSE');
  });

  test('GAT-160 clockOffsetMs는 시각 불확실 판단에만 쓴다(±2분 넘으면 TIME_UNCERTAIN, 회귀 고정)', async () => {
    const s = scan(T0, 150_000);
    await accept([s]);
    expect([...store.flags.values()].map((f) => f.kind)).toContain('TIME_UNCERTAIN');
  });
});
