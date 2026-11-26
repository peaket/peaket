// F-06-3 구현 리뷰 IR-09·22 재현 시험(구현 담당, 2026-11-26).
// 회수 뒤 키 폐기·상태 복원과 같은 승인 동시 호출의 멱등을 메모리 저장소 경계에서 본다.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { fakeClock } from '@peaket/platform';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';

const NOW = Date.parse('2026-11-26T10:00:00+09:00');
const PAYER = randomUUID();
const HOLDER = randomUUID();
const EVENT = randomUUID();
const tickets = new MemoryTicketStore();
const service = new TicketService({ store: tickets, clock: fakeClock({ now: NOW }) });

const seed = async (status: 'ACTIVE' | 'TRANSFER_PENDING' = 'ACTIVE') => {
  const t = await tickets.issue(
    { orderId: randomUUID(), eventId: EVENT, payerAccountId: PAYER, seatIds: [randomUUID()], issueGeneration: 0, eventStartsAtMs: NOW + 86_400_000, fingerprint: randomUUID() },
    [
      {
        ticketId: randomUUID(),
        accountId: HOLDER,
        payerAccountId: PAYER,
        orderId: randomUUID(),
        eventId: EVENT,
        seatId: randomUUID(),
        gateZone: '',
        status,
        issueGeneration: 0,
        qrPayload: 'PEAKET1:x',
        keyHash: 'a'.repeat(64),
        transferPending: status === 'TRANSFER_PENDING',
        version: 0,
        issuedAtMs: NOW,
        eventStartsAtMs: NOW + 86_400_000,
      },
    ],
  );
  return t.tickets[0]!;
};

beforeEach(() => {
  tickets.reclaims.clear();
});

describe('IR-09 회수 뒤 키·상태', () => {
  test('IR-09 보유자를 되돌리면 키를 폐기하고 상태를 ACTIVE로 복원한다', async () => {
    const t = await seed('TRANSFER_PENDING');
    const out = await service.reclaimTransfer({ approvalId: randomUUID(), ticketId: t.ticketId, expectedPayerAccountId: PAYER, expectedHolderAccountId: HOLDER, deadlineMs: NOW + 60_000 });
    expect(out.result).toBe('RECLAIMED');
    const after = tickets.tickets.get(t.ticketId)!;
    expect(after.accountId).toBe(PAYER);
    expect(after.status).toBe('ACTIVE');
    expect(after.transferPending).toBe(false);
    expect(after.keyRevokedAtMs).toBe(NOW);
  });
});

describe('IR-22 같은 승인 동시 호출', () => {
  test('IR-22 같은 승인·같은 티켓 동시 호출은 같은 결과이고 오류가 없다', async () => {
    const t = await seed();
    const input = { approvalId: randomUUID(), ticketId: t.ticketId, expectedPayerAccountId: PAYER, expectedHolderAccountId: HOLDER, deadlineMs: NOW + 60_000 };
    const [a, b] = await Promise.all([service.reclaimTransfer(input), service.reclaimTransfer(input)]);
    expect(a.result).toBe('RECLAIMED');
    expect(b.result).toBe('RECLAIMED');
  });
});
