// F-04-13 ticket-svc 부정 예매 양도 잠금 만료·경합 시험(동결 로컬, LCH-270·LCH-280, FX-T15).
// 정본: docs/features/forensic-replay.md §6.7.4 C13·C17, docs/features/transfer-refund.md §4.1.
// [ASVS v5.0.0-15.4.2] 잠금과 양도 수락의 TOCTOU.
import { readFileSync } from 'node:fs';
import { fakeClock } from '@peaket/platform';
import { describe, expect, it } from 'vitest';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { MemoryTransferStore } from '../src/modules/ticket/adapters/memory-transfer-store.js';
import { Transfers, type TransferReauthGate } from '../src/modules/ticket/application/transfers.js';
import { signRecipientRef } from '../src/modules/ticket/domain/transfer.js';
import type { TicketRecord } from '../src/modules/ticket/domain/ticket.js';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SECRET = 'test-secret';
const PAYER = '0193f2c0-0000-7000-8000-0000000000a1';
const FRIEND = '0193f2c0-0000-7000-8000-0000000000b2';
const EVENT = '0193f2c0-0000-7000-8000-0000000000e1';
const CASE = '0193f2c0-0000-7000-8000-0000000000aa';

const ticketRecord = (n: number, o: Partial<TicketRecord> = {}): TicketRecord => ({
  ticketId: `0193f2c0-0000-7000-8000-${String(n).padStart(12, '0')}`,
  accountId: PAYER,
  payerAccountId: PAYER,
  orderId: `0193f2c0-0000-7001-8000-${String(n).padStart(12, '0')}`,
  eventId: EVENT,
  seatId: `0193f2c0-0000-7002-8000-${String(n).padStart(12, '0')}`,
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
  const revoked: string[] = [];
  const store = new MemoryTransferStore({ tickets, revokeKey: (ticketId) => revoked.push(ticketId) });
  const gate: TransferReauthGate = { verify: async () => true };
  const clock = fakeClock({ now: NOW });
  const transfers = new Transfers({
    store,
    reauth: gate,
    recipientRefSecret: SECRET,
    clock,
    directory: { resolveMemberCode: async () => ({ accountId: FRIEND, nickname: '친구' }) },
  });
  return { tickets, store, transfers, revoked, clock };
};

const seed = (tickets: MemoryTicketStore, n: number, o: Partial<TicketRecord> = {}) => {
  const t = ticketRecord(n, o);
  tickets.tickets.set(t.ticketId, t);
  return t;
};

const ref = (expiresAtMs = NOW + 10 * 60_000) => signRecipientRef({ secret: SECRET, accountId: FRIEND, expiresAtMs });

describe('F-04-13 양도 잠금 만료·경합', () => {
  it('FX-T15 ⑭ 입장 시작에는 ops-svc가 멈춰도 ticket-svc가 잠금을 풀고 표시하지 않는다', async () => {
    const { tickets, store, transfers } = setup();
    const t = seed(tickets, 1, { eventStartsAtMs: NOW + HOUR });
    await store.setTransferLock({ caseId: CASE, version: 1, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * DAY, nowMs: NOW });
    expect(tickets.tickets.get(t.ticketId)?.fraudLockCaseId).toBe(CASE);
    const sweep = (transfers as unknown as { expireFraudLocks(nowMs: number): Promise<number> }).expireFraudLocks;
    expect(sweep).toBeTypeOf('function');
    await sweep.call(transfers, NOW + 2 * HOUR);
    expect(tickets.tickets.get(t.ticketId)?.fraudLockCaseId).toBeUndefined();
    expect(await store.activeTransferLock(EVENT, PAYER, NOW + 2 * HOUR)).toBeUndefined();
    expect(await transfers.lockState(t.ticketId, NOW + 2 * HOUR)).toEqual({ locked: false });
  });

  it('FX-T15 ⑮ 잠금 최대 기한에는 ops-svc가 멈춰도 ticket-svc가 잠금을 푼다', async () => {
    const { tickets, store, transfers } = setup();
    const t = seed(tickets, 2, { eventStartsAtMs: NOW + 72 * HOUR });
    await store.setTransferLock({ caseId: CASE, version: 1, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * DAY, nowMs: NOW });
    const sweep = (transfers as unknown as { expireFraudLocks(nowMs: number): Promise<number> }).expireFraudLocks;
    expect(sweep).toBeTypeOf('function');
    await sweep.call(transfers, NOW + 14 * DAY);
    expect(tickets.tickets.get(t.ticketId)?.fraudLockCaseId).toBeUndefined();
    expect(await store.activeTransferLock(EVENT, PAYER, NOW + 14 * DAY)).toBeUndefined();
  });

  it('FX-T15 ⑯ [ASVS v5.0.0-15.4.2] 잠금과 양도 수락을 1,000번 동시에 넣어도 잠금 커밋 뒤 소유권이 바뀐 표가 0장이다', async () => {
    const { tickets, store, transfers } = setup();
    const count = 1_000;
    const rows = Array.from({ length: count }, (_, i) => {
      const payer = `0193f2c0-0000-7005-8000-${String(i).padStart(12, '0')}`;
      return { payer, ticket: seed(tickets, 10_000 + i, { accountId: payer, payerAccountId: payer, eventStartsAtMs: NOW + 72 * HOUR }) };
    });
    let changed = 0;
    let lockSuccesses = 0;
    let acceptRejected = 0;
    for (let i = 0; i < count; i++) {
      const { payer, ticket: t } = rows[i]!;
      const created = await transfers.createOffer({
        ticketId: t.ticketId,
        accountId: payer,
        sessionId: 's1',
        reauthToken: 'r',
        recipientRef: ref(),
        idempotencyKey: `0193f2c0-0000-7003-8000-${String(i).padStart(12, '0')}`,
      });
      const [lockOutcome, accepted] = await Promise.all([
        store.setTransferLock({ caseId: CASE, version: i + 1, locked: true, eventId: EVENT, accountIds: [payer], expiresAtMs: NOW + 14 * DAY, nowMs: NOW }),
        transfers.accept({ offerId: created.offerId, accountId: FRIEND, idempotencyKey: `0193f2c0-0000-7004-8000-${String(i).padStart(12, '0')}` }).then(
          (v) => v,
          (e: any) => ({ status: e?.code === 'TRANSFER_LOCKED' ? 'TRANSFER_LOCKED' : 'REJECTED' }),
        ),
      ]);
      if (lockOutcome[0]?.result === 'LOCKED') lockSuccesses += 1;
      if (accepted.status === 'TRANSFER_LOCKED' || accepted.status === 'REJECTED') acceptRejected += 1;
      const ticket = tickets.tickets.get(t.ticketId)!;
      if (lockOutcome[0]?.result === 'LOCKED' && ticket.accountId !== payer) changed += 1;
    }
    expect(lockSuccesses).toBeGreaterThan(0);
    expect(acceptRejected).toBeGreaterThan(0);
    expect(changed).toBe(0);
  }, 120_000);

  it('FX-T15 ⑲ 만료 경계 직전에는 잠금이 남고 경계와 계정별 격리에서만 풀린다', async () => {
    const { tickets, store, transfers } = setup();
    const entry = seed(tickets, 20, { eventStartsAtMs: NOW + HOUR });
    const max = seed(tickets, 21, { eventStartsAtMs: NOW + 30 * DAY });
    await store.setTransferLock({ caseId: CASE, version: 1, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * DAY, nowMs: NOW });
    const sweep = (transfers as unknown as { expireFraudLocks(nowMs: number): Promise<number> }).expireFraudLocks;
    expect(sweep).toBeTypeOf('function');
    await sweep.call(transfers, NOW + HOUR - 1);
    expect(tickets.tickets.get(entry.ticketId)?.fraudLockCaseId).toBe(CASE);
    expect(tickets.tickets.get(max.ticketId)?.fraudLockCaseId).toBe(CASE);
    await sweep.call(transfers, NOW + HOUR);
    expect(tickets.tickets.get(entry.ticketId)?.fraudLockCaseId).toBeUndefined();
    expect(tickets.tickets.get(max.ticketId)?.fraudLockCaseId).toBe(CASE);
    await sweep.call(transfers, NOW + 14 * DAY - 1);
    expect(tickets.tickets.get(max.ticketId)?.fraudLockCaseId).toBe(CASE);
    await sweep.call(transfers, NOW + 14 * DAY);
    expect(tickets.tickets.get(max.ticketId)?.fraudLockCaseId).toBeUndefined();
  });

  it('FX-T15 ⑳ 조립된 1분 정비 작업은 Transfers.expireFraudLocks를 부른다', async () => {
    const sweepModulePath = '../src/fraud-lock-sweep.js';
    const sweepModule = (await import(sweepModulePath)) as unknown as Record<string, any>;
    const start = sweepModule.startFraudLockSweep;
    expect(start).toBeTypeOf('function');
    const calls: number[] = [];
    const sweep = start({ transfers: { expireFraudLocks: async (nowMs: number) => { calls.push(nowMs); return 1; } }, intervalMs: 60_000, now: () => NOW });
    await sweep.tick();
    expect(calls).toEqual([NOW]);
    sweep.stop();
    const source = readFileSync(new URL('../src/start.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/startFraudLockSweep/);
    expect(source).toMatch(/60_000|60 \* 1000|FRAUD_LOCK_SWEEP_MS/);
  });

  it('FX-T15 ⑰ 옛 판의 잠금·풀기가 늦게 와도 새 상태를 덮지 않는다', async () => {
    const { tickets, store } = setup();
    const t = seed(tickets, 3, { eventStartsAtMs: NOW + 72 * HOUR });
    await store.setTransferLock({ caseId: CASE, version: 3, locked: true, eventId: EVENT, accountIds: [PAYER], expiresAtMs: NOW + 14 * DAY, nowMs: NOW });
    const old = await store.setTransferLock({ caseId: CASE, version: 2, locked: false, eventId: EVENT, accountIds: [PAYER], nowMs: NOW });
    expect(old[0]?.result).toBe('LOCKED');
    expect(tickets.tickets.get(t.ticketId)?.fraudLockCaseId).toBe(CASE);
  });
});
