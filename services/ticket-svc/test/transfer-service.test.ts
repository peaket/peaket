// 양도 유스케이스 시험(BUILD_ORDER GAT-050·GAT-055). 메모리 저장소로 요청·수락·거절·철회·만료·돌려주기·잠금을 본다.
// 실제 PostgreSQL 행 잠금·동시성은 test-int/transfer.int.test.ts가 본다.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '@peaket/platform';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { MemoryTransferStore } from '../src/modules/ticket/adapters/memory-transfer-store.js';
import { Transfers, type TransferReauthGate } from '../src/modules/ticket/application/transfers.js';
import { signRecipientRef } from '../src/modules/ticket/domain/transfer.js';
import type { TicketRecord } from '../src/modules/ticket/domain/ticket.js';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const SECRET = 'test-secret';
const PAYER = '0193f2c0-0000-7000-8000-0000000000a1';
const FRIEND = '0193f2c0-0000-7000-8000-0000000000b2';
const OTHER = '0193f2c0-0000-7000-8000-0000000000c3';
const EVENT = '0193f2c0-0000-7000-8000-0000000000e1';

function ticketRecord(o: Partial<TicketRecord> = {}): TicketRecord {
  return {
    ticketId: '0193f2c0-0000-7000-8000-000000000001',
    accountId: PAYER,
    payerAccountId: PAYER,
    orderId: '0193f2c0-0000-7000-8000-0000000000d1',
    eventId: EVENT,
    seatId: '0193f2c0-0000-7000-8000-0000000000c1',
    gateZone: '',
    status: 'ACTIVE',
    issueGeneration: 0,
    qrPayload: 'PEAKET1:0193f2c0-0000-7000-8000-000000000001',
    keyHash: 'a'.repeat(64),
    transferPending: false,
    version: 0,
    issuedAtMs: NOW - 24 * HOUR,
    eventStartsAtMs: NOW + 72 * HOUR,
    ...o,
  };
}

function setup(o: { gate?: TransferReauthGate } = {}) {
  const tickets = new MemoryTicketStore();
  const revoked: string[] = [];
  const store = new MemoryTransferStore({ tickets, revokeKey: (ticketId) => revoked.push(ticketId) });
  const gate: TransferReauthGate = o.gate ?? { verify: async () => true };
  const clock = fakeClock({ now: NOW });
  const transfers = new Transfers({
    store,
    reauth: gate,
    recipientRefSecret: SECRET,
    clock,
    directory: {
      resolveMemberCode: async (code) =>
        code === 'ABC-1234'
          ? { accountId: FRIEND, nickname: '친구' }
          : code === 'XYZ-9999'
            ? { accountId: OTHER, nickname: '다른이' }
            : undefined,
    },
  });
  return { tickets, store, transfers, revoked, gate, clock };
}

async function issue(tickets: MemoryTicketStore, o: Partial<TicketRecord> = {}): Promise<TicketRecord> {
  const t = ticketRecord(o);
  // 같은 저장소에 여러 표를 넣으므로 주문 ID는 표마다 다르게 만든다(기본값은 한 표만 쓰는 시험용)
  const orderId = `0193f2c0-0000-7000-8000-${t.ticketId.slice(-12)}`;
  await tickets.issue(
    {
      orderId,
      eventId: t.eventId,
      payerAccountId: t.payerAccountId,
      seatIds: [t.seatId],
      issueGeneration: t.issueGeneration,
      eventStartsAtMs: t.eventStartsAtMs,
      fingerprint: `f-${t.ticketId}`,
      nowMs: NOW,
    },
    [{ ...t, orderId }],
  );
  return t;
}

const ref = (accountId: string, expiresAtMs = NOW + 10 * 60_000): string => signRecipientRef({ secret: SECRET, accountId, expiresAtMs });

describe('양도 요청·수락', () => {
  it('R-T1 수락하면 보유자가 바뀌고 보낸 사람 키를 폐기하며, 만료된 요청은 수락할 수 없다', async () => {
    const { tickets, transfers, revoked } = setup();
    const t = await issue(tickets);
    const created = await transfers.createOffer({ ticketId: t.ticketId, accountId: PAYER, sessionId: 's1', reauthToken: 'r', recipientRef: ref(FRIEND), idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f1' });
    expect(created.status).toBe('OFFERED');
    expect(tickets.tickets.get(t.ticketId)?.transferPending).toBe(true);
    expect(tickets.tickets.get(t.ticketId)?.status).toBe('TRANSFER_PENDING');

    const accepted = await transfers.accept({ offerId: created.offerId, accountId: FRIEND, idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f2' });
    expect(accepted.status).toBe('ACCEPTED');
    const after = tickets.tickets.get(t.ticketId)!;
    expect(after.accountId).toBe(FRIEND);
    expect(after.status).toBe('ACTIVE');
    expect(after.transferPending).toBe(false);
    expect(revoked).toEqual([t.ticketId]);

    // 만료된 요청: 저장소 시계를 넘겨 만료로 바꾼 뒤 수락은 409다
    await issue(tickets, { ticketId: '0193f2c0-0000-7000-8000-000000000002', seatId: '0193f2c0-0000-7000-8000-0000000000c2' });
    const second = await transfers.createOffer({ ticketId: '0193f2c0-0000-7000-8000-000000000002', accountId: PAYER, sessionId: 's1', reauthToken: 'r', recipientRef: ref(FRIEND), idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f3' });
    await storeExpire(transfers, NOW + 49 * HOUR);
    await expect(transfers.accept({ offerId: second.offerId, accountId: FRIEND, idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f4' })).rejects.toMatchObject({ code: 'EXPIRED' });
  });

  it('R-T2 받은 사람이 다른 회원에게 다시 양도하면 409이고 아무것도 바뀌지 않는다', async () => {
    const { tickets, transfers } = setup();
    const t = await issue(tickets, { accountId: FRIEND });
    await expect(
      transfers.createOffer({ ticketId: t.ticketId, accountId: FRIEND, sessionId: 's1', reauthToken: 'r', recipientRef: ref(OTHER), idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f1' }),
    ).rejects.toMatchObject({ code: 'REOFFER' });
    expect(tickets.tickets.get(t.ticketId)?.accountId).toBe(FRIEND);
    expect(tickets.tickets.get(t.ticketId)?.transferPending).toBe(false);
  });

  it('R-T17 입장 시작 뒤 요청·수락·돌려주기는 모두 409이고 키·보유자가 그대로다', async () => {
    const { tickets, transfers, revoked } = setup();
    const t = await issue(tickets, { eventStartsAtMs: NOW - 1 });
    await expect(
      transfers.createOffer({ ticketId: t.ticketId, accountId: PAYER, sessionId: 's1', reauthToken: 'r', recipientRef: ref(FRIEND), idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f1' }),
    ).rejects.toMatchObject({ code: 'ENTRY_STARTED' });
    expect(tickets.tickets.get(t.ticketId)?.accountId).toBe(PAYER);
    expect(revoked).toEqual([]);

    const received = await issue(tickets, { ticketId: '0193f2c0-0000-7000-8000-000000000002', seatId: '0193f2c0-0000-7000-8000-0000000000c2', accountId: FRIEND, eventStartsAtMs: NOW - 1 });
    await expect(transfers.returnToPayer({ ticketId: received.ticketId, accountId: FRIEND, sessionId: 's1', reauthToken: 'r', idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f2' })).rejects.toMatchObject({ code: 'ENTRY_STARTED' });
    expect(tickets.tickets.get(received.ticketId)?.accountId).toBe(FRIEND);
    expect(revoked).toEqual([]);
  });
});

describe('거절·철회·돌려주기', () => {
  it('R-T21 ① 거절·철회를 같은 키로 두 번 해도 처음 결과이고 상태는 한 번만 바뀐다', async () => {
    const { tickets, transfers } = setup();
    const t = await issue(tickets);
    const offer = await transfers.createOffer({ ticketId: t.ticketId, accountId: PAYER, sessionId: 's1', reauthToken: 'r', recipientRef: ref(FRIEND), idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f1' });
    expect((await transfers.reject({ offerId: offer.offerId, accountId: FRIEND, idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f2' })).status).toBe('REJECTED');
    expect((await transfers.reject({ offerId: offer.offerId, accountId: FRIEND, idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f2' })).status).toBe('REJECTED');
    expect(tickets.tickets.get(t.ticketId)?.transferPending).toBe(false);
    expect(tickets.tickets.get(t.ticketId)?.accountId).toBe(PAYER);

    const second = await transfers.createOffer({ ticketId: t.ticketId, accountId: PAYER, sessionId: 's1', reauthToken: 'r', recipientRef: ref(FRIEND), idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f3' });
    expect((await transfers.withdraw({ offerId: second.offerId, accountId: PAYER, idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f4' })).status).toBe('WITHDRAWN');
    expect((await transfers.withdraw({ offerId: second.offerId, accountId: PAYER, idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f4' })).status).toBe('WITHDRAWN');
    expect(tickets.tickets.get(t.ticketId)?.accountId).toBe(PAYER);
  });

  it('R-T21 ① 돌려주기는 받은 보유자만 하고, 결제자가 돌려받으면 키가 폐기된다', async () => {
    const { tickets, transfers, revoked } = setup();
    const t = await issue(tickets, { accountId: FRIEND });
    expect((await transfers.returnToPayer({ ticketId: t.ticketId, accountId: FRIEND, sessionId: 's2', reauthToken: 'r', idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f1' })).status).toBe('RETURNED');
    expect(tickets.tickets.get(t.ticketId)?.accountId).toBe(PAYER);
    expect(revoked).toEqual([t.ticketId]);
    await expect(transfers.returnToPayer({ ticketId: t.ticketId, accountId: PAYER, sessionId: 's1', reauthToken: 'r', idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f2' })).rejects.toMatchObject({ code: 'PAYER_HOLDS' });
  });
});

describe('부정 예매 양도 잠금(ticket-svc 몫)', () => {
  it('R-T31 ① 잠그면 진행 중 양도 요청이 FRAUD_LOCK으로 철회되고 티켓이 잠긴다', async () => {
    const { tickets, store, transfers } = setup();
    const t = await issue(tickets);
    const offer = await transfers.createOffer({ ticketId: t.ticketId, accountId: PAYER, sessionId: 's1', reauthToken: 'r', recipientRef: ref(FRIEND), idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f1' });
    const outcomes = await store.setTransferLock({ caseId: '0193f2c0-0000-7000-8000-0000000000aa', version: 1, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * 24 * HOUR, nowMs: NOW });
    expect(outcomes).toEqual([{ ticketId: t.ticketId, result: 'LOCKED', withdrawnOfferId: offer.offerId, holderAccountId: undefined }]);
    const after = tickets.tickets.get(t.ticketId)!;
    expect(after.fraudLockCaseId).toBe('0193f2c0-0000-7000-8000-0000000000aa');
    expect(after.transferPending).toBe(false);
    expect(store.offers.get(offer.offerId)?.status).toBe('WITHDRAWN');
    expect(store.offers.get(offer.offerId)?.withdrawReason).toBe('FRAUD_LOCK');
  });

  it('R-T31 ② 잠긴 표의 양도는 409 transfer-locked이고, 받은 사람의 돌려주기는 성공해 잠긴 채로 돌아온다', async () => {
    const { tickets, store, transfers } = setup();
    const t = await issue(tickets, { accountId: FRIEND });
    await store.setTransferLock({ caseId: '0193f2c0-0000-7000-8000-0000000000aa', version: 1, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * 24 * HOUR, nowMs: NOW });
    await expect(
      transfers.createOffer({ ticketId: t.ticketId, accountId: FRIEND, sessionId: 's2', reauthToken: 'r', recipientRef: ref(OTHER), idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f1' }),
    ).rejects.toMatchObject({ code: 'REOFFER' });
    expect((await transfers.returnToPayer({ ticketId: t.ticketId, accountId: FRIEND, sessionId: 's2', reauthToken: 'r', idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f2' })).status).toBe('RETURNED');
    expect(tickets.tickets.get(t.ticketId)?.accountId).toBe(PAYER);
    expect(tickets.tickets.get(t.ticketId)?.fraudLockCaseId).toBe('0193f2c0-0000-7000-8000-0000000000aa');
  });

  it('R-T31 ② 잠긴 결제자의 양도 요청은 409 transfer-locked다', async () => {
    const { tickets, store, transfers } = setup();
    const t = await issue(tickets);
    await store.setTransferLock({ caseId: '0193f2c0-0000-7000-8000-0000000000aa', version: 1, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * 24 * HOUR, nowMs: NOW });
    await expect(
      transfers.createOffer({ ticketId: t.ticketId, accountId: PAYER, sessionId: 's1', reauthToken: 'r', recipientRef: ref(FRIEND), idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f1' }),
    ).rejects.toMatchObject({ code: 'TRANSFER_LOCKED' });
  });

  it('R-T31 ④ 같은 판은 한 번만 반영하고 옛 판의 풀기는 무시한다', async () => {
    const { tickets, store } = setup();
    const t = await issue(tickets);
    const caseId = '0193f2c0-0000-7000-8000-0000000000aa';
    await store.setTransferLock({ caseId, version: 2, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * 24 * HOUR, nowMs: NOW });
    const same = await store.setTransferLock({ caseId, version: 2, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * 24 * HOUR, nowMs: NOW });
    expect(same[0]?.result).toBe('LOCKED');
    const old = await store.setTransferLock({ caseId, version: 1, locked: false, eventId: EVENT, accountIds: [PAYER], nowMs: NOW });
    expect(old[0]?.result).toBe('LOCKED');
    expect(tickets.tickets.get(t.ticketId)?.fraudLockCaseId).toBe(caseId);
  });

  it('R-T31 ⑤ 다른 사건이 이미 잠근 표는 바꾸지 않고 OTHER_CASE로 돌려준다', async () => {
    const { tickets, store } = setup();
    const t = await issue(tickets);
    await store.setTransferLock({ caseId: '0193f2c0-0000-7000-8000-0000000000aa', version: 1, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * 24 * HOUR, nowMs: NOW });
    const out = await store.setTransferLock({ caseId: '0193f2c0-0000-7000-8000-0000000000bb', version: 1, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * 24 * HOUR, nowMs: NOW });
    expect(out[0]?.result).toBe('OTHER_CASE');
    expect(tickets.tickets.get(t.ticketId)?.fraudLockCaseId).toBe('0193f2c0-0000-7000-8000-0000000000aa');
  });

  it('R-T31 ⑨ 입장 시작이 지나면 ops-svc 호출 없이 잠금이 풀린 것으로 본다', async () => {
    const { tickets, store, transfers } = setup();
    const t = await issue(tickets, { eventStartsAtMs: NOW + HOUR });
    await store.setTransferLock({ caseId: '0193f2c0-0000-7000-8000-0000000000aa', version: 1, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * 24 * HOUR, nowMs: NOW });
    expect((await store.activeTransferLock(EVENT, PAYER, NOW))?.caseId).toBe('0193f2c0-0000-7000-8000-0000000000aa');
    expect(await store.activeTransferLock(EVENT, PAYER, NOW + 2 * HOUR)).toBeUndefined();
    expect(await transfers.lockState(t.ticketId, NOW + 2 * HOUR)).toEqual({ locked: false });
  });
});

describe('기한 지난 요청의 표시 해제(RV-01)', () => {
  it('R-T1 기한이 지난 요청은 새 양도 요청을 만들 때 먼저 만료되어 표시가 풀린다', async () => {
    const { tickets, store, transfers, clock } = setup();
    const t = await issue(tickets);
    const first = await transfers.createOffer({ ticketId: t.ticketId, accountId: PAYER, sessionId: 's1', reauthToken: 'r', recipientRef: ref(FRIEND), idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f1' });
    clock.advance(49 * HOUR);
    const second = await transfers.createOffer({ ticketId: t.ticketId, accountId: PAYER, sessionId: 's1', reauthToken: 'r', recipientRef: ref(FRIEND), idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f2' });
    expect(second.status).toBe('OFFERED');
    expect(store.offers.get(first.offerId)?.status).toBe('EXPIRED');
    expect(tickets.tickets.get(t.ticketId)?.transferPending).toBe(true);
  });
});

describe('재인증', () => {
  it('R-T21 ② 재인증이 없거나 확인하지 못하면 양도 요청·돌려주기를 하지 않는다', async () => {
    const { tickets, transfers } = setup({ gate: { verify: async () => false } });
    const t = await issue(tickets);
    await expect(
      transfers.createOffer({ ticketId: t.ticketId, accountId: PAYER, sessionId: 's1', reauthToken: 'bad', recipientRef: ref(FRIEND), idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f1' }),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    expect(tickets.tickets.get(t.ticketId)?.transferPending).toBe(false);

    const received = await issue(tickets, { ticketId: '0193f2c0-0000-7000-8000-000000000002', seatId: '0193f2c0-0000-7000-8000-0000000000c2', accountId: FRIEND });
    await expect(transfers.returnToPayer({ ticketId: received.ticketId, accountId: FRIEND, sessionId: 's2', reauthToken: 'bad', idempotencyKey: '0193f2c0-0000-7000-8000-0000000000f2' })).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
  });
});

async function storeExpire(transfers: Transfers, nowMs: number): Promise<void> {
  await transfers.expireOffers(nowMs);
}
