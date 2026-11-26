// F-04-14 C-T70 서버 가드(동결 로컬, LCH-290). F-04-13의 양도 잠금 위에서
// 새 양도 409·돌려주기 성공·돌아온 표의 잠금 유지·14일 뒤 스스로 해제를 실제 ticket-svc 경계로 본다.
// 정본: docs/features/control-tower.md:556 C-T70, docs/features/transfer-refund.md §4.1, docs/features/forensic-replay.md C13·C17.
import { fakeClock } from '@peaket/platform';
import { describe, expect, it } from 'vitest';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { MemoryTransferStore } from '../src/modules/ticket/adapters/memory-transfer-store.js';
import { Transfers, type TransferReauthGate } from '../src/modules/ticket/application/transfers.js';
import { signRecipientRef } from '../src/modules/ticket/domain/transfer.js';
import type { TicketRecord } from '../src/modules/ticket/domain/ticket.js';

const NOW = Date.parse('2026-11-26T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SECRET = 'test-secret';
const PAYER = '0194b242-0000-7000-8000-0000000000a1';
const FRIEND = '0194b242-0000-7000-8000-0000000000b2';
const EVENT = '0194b242-0000-7000-8000-0000000000e1';
const CASE = '0194b242-0000-7000-8000-0000000000aa';

const ticketRecord = (n: number, o: Partial<TicketRecord> = {}): TicketRecord => ({
  ticketId: `0194b242-0000-7000-8000-${String(n).padStart(12, '0')}`,
  accountId: PAYER,
  payerAccountId: PAYER,
  orderId: `0194b242-0000-7001-8000-${String(n).padStart(12, '0')}`,
  eventId: EVENT,
  seatId: `0194b242-0000-7002-8000-${String(n).padStart(12, '0')}`,
  gateZone: '',
  status: 'ACTIVE',
  issueGeneration: 0,
  qrPayload: `PEAKET1:${n}`,
  keyHash: 'a'.repeat(64),
  transferPending: false,
  version: 0,
  issuedAtMs: NOW - DAY,
  eventStartsAtMs: NOW + 72 * HOUR,
  ...o,
});

const setup = () => {
  const tickets = new MemoryTicketStore();
  const store = new MemoryTransferStore({ tickets, revokeKey: () => undefined });
  const gate: TransferReauthGate = { verify: async () => true };
  const clock = fakeClock({ now: NOW });
  const transfers = new Transfers({
    store,
    reauth: gate,
    recipientRefSecret: SECRET,
    clock,
    directory: { resolveMemberCode: async () => ({ accountId: FRIEND, nickname: '친구' }) },
  });
  return { tickets, store, transfers, clock };
};

const seed = (tickets: MemoryTicketStore, n: number, o: Partial<TicketRecord> = {}) => {
  const t = ticketRecord(n, o);
  tickets.tickets.set(t.ticketId, t);
  return t;
};

const ref = () => signRecipientRef({ secret: SECRET, accountId: FRIEND, expiresAtMs: NOW + 10 * 60_000 });

describe('F-04-14 C-T70 양도 잠금 서버 가드', () => {
  it('C-T70 ① 잠긴 표는 새 양도가 409 TRANSFER_LOCKED이고 돌려주기는 성공하며 돌아온 표는 잠긴 채다', async () => {
    const { tickets, store, transfers } = setup();
    const payerTicket = seed(tickets, 1);
    await store.setTransferLock({ caseId: CASE, version: 1, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * DAY, nowMs: NOW });
    await expect(
      transfers.createOffer({ ticketId: payerTicket.ticketId, accountId: PAYER, sessionId: 's1', reauthToken: 'r', recipientRef: ref(), idempotencyKey: '0194b242-0000-7003-8000-000000000001' }),
    ).rejects.toMatchObject({ code: 'TRANSFER_LOCKED' });

    const held = seed(tickets, 2, { accountId: FRIEND, payerAccountId: PAYER });
    await store.setTransferLock({ caseId: CASE, version: 2, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * DAY, nowMs: NOW });
    expect(tickets.tickets.get(held.ticketId)?.fraudLockCaseId).toBe(CASE);
    const returned = await transfers.returnToPayer({ ticketId: held.ticketId, accountId: FRIEND, sessionId: 's1', reauthToken: 'r', idempotencyKey: '0194b242-0000-7004-8000-000000000002' });
    expect(returned).toEqual({ ticketId: held.ticketId, status: 'RETURNED' });
    expect(tickets.tickets.get(held.ticketId)?.accountId).toBe(PAYER);
    expect(tickets.tickets.get(held.ticketId)?.fraudLockCaseId).toBe(CASE);
    expect((await transfers.lockState(held.ticketId, NOW))?.locked).toBe(true);
  });

  it('C-T70 ② 14일이 지나면 ops-svc 호출 없이 ticket-svc가 잠금을 풀고 표시도 지운다', async () => {
    const { tickets, store, transfers } = setup();
    const t = seed(tickets, 3, { eventStartsAtMs: NOW + 30 * DAY });
    await store.setTransferLock({ caseId: CASE, version: 1, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * DAY, nowMs: NOW });
    await transfers.expireFraudLocks(NOW + 14 * DAY - 1);
    expect(tickets.tickets.get(t.ticketId)?.fraudLockCaseId).toBe(CASE);
    expect(await store.activeTransferLock(EVENT, PAYER, NOW + 14 * DAY - 1)).toBeDefined();
    await transfers.expireFraudLocks(NOW + 14 * DAY);
    expect(tickets.tickets.get(t.ticketId)?.fraudLockCaseId).toBeUndefined();
    expect(await store.activeTransferLock(EVENT, PAYER, NOW + 14 * DAY)).toBeUndefined();
    expect((await transfers.lockState(t.ticketId, NOW + 14 * DAY))?.locked).toBe(false);
  });
});
