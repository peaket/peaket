// F-05-12 O-T2 ② 좌석 이름: 발권할 때 좌석맵 판의 이름을 ticket에 스냅샷하고,
// 스캐너 회차 목록·이상 표시가 그 이름을 주며, 이름이 없는 옛 행은 seatId로 물러난다.
// 정본: docs/features/offline-gate.md O-T2 ②, docs/design/d5 §8.5, openapi ScannerPackageTicket·GateFlag.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryScannerGateStore } from '../src/modules/scanner/adapters/memory-scanner-gate-store.js';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';

const NOW = Date.parse('2026-11-26T03:00:00.000Z');
const ORDER = '0190f3a1-7c2e-7a00-8000-00000000b001';
const EVENT = '0190f3a1-7c2e-7a00-8000-00000000b002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-00000000b003';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-00000000b004';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-00000000b005';

describe('O-T2 ② 좌석 이름', () => {
  test('O-T2 ② 발권에 seat_labels를 주면 ticket에 그 이름이 남고, 없으면 seatId로 물러난다', async () => {
    const clock = fakeClock({ now: NOW });
    const store = new MemoryTicketStore();
    const service = new TicketService({ store, clock });
    const issue = (over: Record<string, unknown>) => service.issue(over as unknown as Parameters<typeof service.issue>[0]); // type-escape: seatLabels는 구현 뒤 생긴다
    const issued = await issue({ orderId: ORDER, eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [SEAT_A, SEAT_B], seatLabels: ['R구역 12열 7번', 'R구역 12열 8번'], issueGeneration: 0 });
    const labelOf = (ticketId: string) => (store.tickets.get(ticketId) as unknown as { seatLabel?: string } | undefined)?.seatLabel;
    const bySeat = new Map(issued.tickets.map((t) => [t.seatId, t]));
    expect(labelOf(bySeat.get(SEAT_A)!.ticketId)).toBe('R구역 12열 7번');
    expect(labelOf(bySeat.get(SEAT_B)!.ticketId)).toBe('R구역 12열 8번');

    const other = await issue({ orderId: '0190f3a1-7c2e-7a00-8000-00000000b006', eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [SEAT_A], issueGeneration: 0 });
    expect(labelOf(other.tickets[0]!.ticketId)).toBeUndefined();
  });

  test('O-T2 ② 스캐너 회차 목록은 좌석 이름을 주고, 이름이 없는 옛 행은 seatId다', async () => {
    const gate = new MemoryScannerGateStore();
    gate.seedTicket({ ticketId: '0190f3a1-7c2e-7a00-8000-00000000b007', eventId: EVENT, seatId: SEAT_A, gateZone: '동문', status: 'ACTIVE' } as unknown as Parameters<typeof gate.seedTicket>[0]); // type-escape: seatLabel은 구현 뒤 생긴다
    gate.seedTicket({ ticketId: '0190f3a1-7c2e-7a00-8000-00000000b008', eventId: EVENT, seatId: SEAT_B, seatLabel: 'R구역 12열 8번', gateZone: '동문', status: 'ACTIVE' } as unknown as Parameters<typeof gate.seedTicket>[0]); // type-escape: seatLabel은 구현 뒤 생긴다
    const pkg = await gate.package({ eventId: EVENT, nowMs: NOW });
    const labels = Object.fromEntries(pkg.tickets.map((t) => [t.ticketId, t.seatLabel]));
    expect(labels['0190f3a1-7c2e-7a00-8000-00000000b007']).toBe(SEAT_A);
    expect(labels['0190f3a1-7c2e-7a00-8000-00000000b008']).toBe('R구역 12열 8번');
  });
});
