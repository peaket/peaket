// 운영 양도 저장소(BUILD_ORDER GAT-050·GAT-055). 티켓·양도 요청 행을 FOR UPDATE 안에서 다시 보고,
// 수락은 보유자 변경·보낸 사람 키 폐기·요청 상태를 한 트랜잭션으로 처리한다(docs/features/transfer-refund.md §3.1·§4).
import type { Database, DbTransaction } from '@peaket/platform';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import type {
  CreateOfferOutcome,
  DecideOutcome,
  ReturnOutcome,
  SetTransferLockInput,
  TransferLockOutcome,
  TransferStore,
} from '../../domain/transfer-ports.js';
import {
  acceptRejectionOf,
  createOfferRejectionOf,
  lockActiveAt,
  lockResultOf,
  rejectRejectionOf,
  returnRejectionOf,
  type TransferOfferRecord,
  type TransferStatus,
  type TransferTicketSnapshot,
  withdrawRejectionOf,
} from '../../domain/transfer.js';
import { type TicketStatus } from '../../domain/ticket.js';
import type { DeviceKeyRevoker } from './drizzle-ticket-store.js';
import { fraudTransferLock, ticket, transferOffer } from './schema.js';

type TicketRow = typeof ticket.$inferSelect;
type OfferRow = typeof transferOffer.$inferSelect;

const ticketStatusOf = (v: string): TicketStatus => v as TicketStatus;
const offerStatusOf = (v: string): TransferStatus => v as TransferStatus;

const snapshotOf = (r: TicketRow): TransferTicketSnapshot => ({
  ticketId: r.id,
  accountId: r.accountId,
  payerAccountId: r.payerAccountId,
  eventId: r.eventId,
  status: ticketStatusOf(r.status),
  transferPending: r.transferPending,
  ...(r.eventStartsAt ? { eventStartsAtMs: r.eventStartsAt.getTime() } : {}),
  ...(r.fraudLockCaseId ? { fraudLockCaseId: r.fraudLockCaseId } : {}),
  fraudLockVersion: Number(r.fraudLockVersion),
});

const recordOf = (r: OfferRow): TransferOfferRecord => ({
  offerId: r.id,
  ticketId: r.ticketId,
  fromAccountId: r.fromAccountId,
  toAccountId: r.toAccountId,
  status: offerStatusOf(r.status),
  ...(r.withdrawReason ? { withdrawReason: r.withdrawReason as TransferOfferRecord['withdrawReason'] } : {}),
  expiresAtMs: r.expiresAt.getTime(),
  createdAtMs: r.createdAt.getTime(),
  ...(r.decidedAt ? { decidedAtMs: r.decidedAt.getTime() } : {}),
});

export interface DrizzleTransferStoreOptions {
  readonly database: Database;
  /** 수락·돌려주기 때 보낸 사람의 유효 기기 키를 폐기한다(없으면 단위 시험) */
  readonly deviceKeys?: DeviceKeyRevoker;
}

export class DrizzleTransferStore implements TransferStore {
  constructor(private readonly o: DrizzleTransferStoreOptions) {}

  async ticket(ticketId: string): Promise<TransferTicketSnapshot | undefined> {
    const [row] = await this.o.database.db.select().from(ticket).where(eq(ticket.id, ticketId)).limit(1);
    return row ? snapshotOf(row) : undefined;
  }

  async activeTransferLock(eventId: string, payerAccountId: string, nowMs: number): Promise<{ caseId: string; expiresAtMs: number } | undefined> {
    return this.#activeLock(this.o.database.db, eventId, payerAccountId, nowMs);
  }

  async createOffer(offer: TransferOfferRecord, nowMs: number): Promise<CreateOfferOutcome> {
    return this.o.database.transaction(async (tx) => {
      const [existing] = await tx.select().from(transferOffer).where(eq(transferOffer.id, offer.offerId)).limit(1);
      if (existing) return { kind: 'REPLAYED', offer: recordOf(existing) };
      const [row] = await tx.select().from(ticket).where(eq(ticket.id, offer.ticketId)).limit(1).for('update');
      if (!row) return { kind: 'REJECTED', reason: 'NOT_HOLDER' };
      // 기한 지난 요청을 먼저 만료시켜 표시를 푼다(RV-01). 만료 고리가 늦어도 새 요청·취소가 막히지 않는다
      await tx
        .update(transferOffer)
        .set({ status: 'EXPIRED', decidedAt: new Date(nowMs) })
        .where(and(eq(transferOffer.ticketId, row.id), eq(transferOffer.status, 'OFFERED'), lte(transferOffer.expiresAt, new Date(nowMs))));
      const open = await tx.select({ id: transferOffer.id }).from(transferOffer).where(and(eq(transferOffer.ticketId, row.id), eq(transferOffer.status, 'OFFERED'))).limit(1);
      // 행 잠금을 기다린 뒤 같은 키의 앞 요청이 먼저 들어갔는지 본다(RV-04)
      const [sameKey] = await tx.select().from(transferOffer).where(eq(transferOffer.id, offer.offerId)).limit(1);
      if (sameKey) return { kind: 'REPLAYED', offer: recordOf(sameKey) };
      let fresh = row;
      if (!open[0] && (row.transferPending || row.status === 'TRANSFER_PENDING')) {
        await tx
          .update(ticket)
          .set({ status: row.status === 'TRANSFER_PENDING' ? 'ACTIVE' : row.status, transferPending: false, version: row.version + 1 })
          .where(eq(ticket.id, row.id));
        const [again] = await tx.select().from(ticket).where(eq(ticket.id, row.id)).limit(1);
        if (again) fresh = again;
      }
      const lock = await this.#activeLock(tx, fresh.eventId, fresh.payerAccountId, nowMs);
      const reason = createOfferRejectionOf(snapshotOf(fresh), { callerAccountId: offer.fromAccountId, nowMs, lockActive: lock !== undefined });
      if (reason) return { kind: 'REJECTED', reason };
      const inserted = await tx
        .insert(transferOffer)
        .values({
          id: offer.offerId,
          ticketId: offer.ticketId,
          fromAccountId: offer.fromAccountId,
          toAccountId: offer.toAccountId,
          status: 'OFFERED',
          expiresAt: new Date(offer.expiresAtMs),
          createdAt: new Date(offer.createdAtMs),
        })
        .onConflictDoNothing()
        .returning({ id: transferOffer.id });
      if (inserted.length === 0) {
        // 같은 키의 동시 요청이거나 다른 요청이 진행 중이다. 같은 키면 처음 결과(REPLAYED), 아니면 409다(RV-04)
        const [sameKey] = await tx.select().from(transferOffer).where(eq(transferOffer.id, offer.offerId)).limit(1);
        if (sameKey) return { kind: 'REPLAYED', offer: recordOf(sameKey) };
        return { kind: 'REJECTED', reason: 'TRANSFER_PENDING' };
      }
      await tx
        .update(ticket)
        .set({ status: 'TRANSFER_PENDING', transferPending: true, version: fresh.version + 1 })
        .where(eq(ticket.id, fresh.id));
      return { kind: 'CREATED', offer };
    });
  }

  async getOffer(offerId: string): Promise<TransferOfferRecord | undefined> {
    const [row] = await this.o.database.db.select().from(transferOffer).where(eq(transferOffer.id, offerId)).limit(1);
    return row ? recordOf(row) : undefined;
  }

  async accept(i: { offerId: string; accountId: string; nowMs: number }): Promise<DecideOutcome> {
    return this.o.database.transaction(async (tx) => {
      // 행 잠금 차례는 티켓 → 요청이다. setTransferLock과 같은 차례로 교착을 막는다(RV-02)
      const [peek] = await tx.select().from(transferOffer).where(eq(transferOffer.id, i.offerId)).limit(1);
      if (!peek) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
      const [t] = await tx.select().from(ticket).where(eq(ticket.id, peek.ticketId)).limit(1).for('update');
      if (!t) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
      const [offerRow] = await tx.select().from(transferOffer).where(eq(transferOffer.id, i.offerId)).limit(1).for('update');
      if (!offerRow) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
      const current = recordOf(offerRow);
      if (current.toAccountId !== i.accountId) return { kind: 'REJECTED', reason: 'NOT_RECIPIENT' };
      const reason = acceptRejectionOf(current, { accountId: i.accountId, nowMs: i.nowMs, eventStartsAtMs: t.eventStartsAt?.getTime() });
      if (reason) return { kind: 'REJECTED', reason };
      if (current.status === 'ACCEPTED') return { kind: 'OK', offer: current, replayed: true };
      if (t.accountId !== current.fromAccountId) return { kind: 'REJECTED', reason: 'NOT_OFFERED' };
      await tx.update(transferOffer).set({ status: 'ACCEPTED', decidedAt: new Date(i.nowMs) }).where(eq(transferOffer.id, i.offerId));
      await this.o.deviceKeys?.revokeActiveInTx(tx, t.id, i.nowMs);
      await tx
        .update(ticket)
        .set({ accountId: current.toAccountId, status: 'ACTIVE', transferPending: false, keyRevokedAt: new Date(i.nowMs), version: t.version + 1 })
        .where(eq(ticket.id, t.id));
      return { kind: 'OK', offer: { ...current, status: 'ACCEPTED', decidedAtMs: i.nowMs }, replayed: false };
    });
  }

  async reject(i: { offerId: string; accountId: string; nowMs: number }): Promise<DecideOutcome> {
    return this.o.database.transaction(async (tx) => {
      const [peek] = await tx.select().from(transferOffer).where(eq(transferOffer.id, i.offerId)).limit(1);
      if (!peek) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
      const [t] = await tx.select().from(ticket).where(eq(ticket.id, peek.ticketId)).limit(1).for('update');
      if (!t) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
      const [offerRow] = await tx.select().from(transferOffer).where(eq(transferOffer.id, i.offerId)).limit(1).for('update');
      if (!offerRow) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
      const offer = recordOf(offerRow);
      const reason = rejectRejectionOf(offer, { accountId: i.accountId, nowMs: i.nowMs, eventStartsAtMs: t.eventStartsAt?.getTime() });
      if (reason) return { kind: 'REJECTED', reason };
      if (offer.status === 'REJECTED') return { kind: 'OK', offer, replayed: true };
      await tx.update(transferOffer).set({ status: 'REJECTED', decidedAt: new Date(i.nowMs) }).where(eq(transferOffer.id, i.offerId));
      await tx
        .update(ticket)
        .set({ status: t.status === 'TRANSFER_PENDING' ? 'ACTIVE' : t.status, transferPending: false, version: t.version + 1 })
        .where(eq(ticket.id, t.id));
      return { kind: 'OK', offer: { ...offer, status: 'REJECTED', decidedAtMs: i.nowMs }, replayed: false };
    });
  }

  async withdraw(i: { offerId: string; accountId: string; nowMs: number }): Promise<DecideOutcome> {
    return this.o.database.transaction(async (tx) => {
      const [peek] = await tx.select().from(transferOffer).where(eq(transferOffer.id, i.offerId)).limit(1);
      if (!peek) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
      const [t] = await tx.select().from(ticket).where(eq(ticket.id, peek.ticketId)).limit(1).for('update');
      if (!t) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
      const [offerRow] = await tx.select().from(transferOffer).where(eq(transferOffer.id, i.offerId)).limit(1).for('update');
      if (!offerRow) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
      const offer = recordOf(offerRow);
      const reason = withdrawRejectionOf(offer, { accountId: i.accountId, nowMs: i.nowMs });
      if (reason) return { kind: 'REJECTED', reason };
      if (offer.status === 'WITHDRAWN') return { kind: 'OK', offer, replayed: true };
      await tx.update(transferOffer).set({ status: 'WITHDRAWN', withdrawReason: 'SENDER', decidedAt: new Date(i.nowMs) }).where(eq(transferOffer.id, i.offerId));
      await tx
        .update(ticket)
        .set({ status: t.status === 'TRANSFER_PENDING' ? 'ACTIVE' : t.status, transferPending: false, version: t.version + 1 })
        .where(eq(ticket.id, t.id));
      return { kind: 'OK', offer: { ...offer, status: 'WITHDRAWN', withdrawReason: 'SENDER', decidedAtMs: i.nowMs }, replayed: false };
    });
  }

  async returnToPayer(i: { ticketId: string; accountId: string; nowMs: number; idempotencyKey: string }): Promise<ReturnOutcome> {
    return this.o.database.transaction(async (tx) => {
      const [t] = await tx.select().from(ticket).where(eq(ticket.id, i.ticketId)).limit(1).for('update');
      if (!t) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
      const entry = (await tx.execute(sql`select 1 from scan_event where event_id = ${t.eventId}::uuid and ticket_id = ${t.id}::uuid and direction = 'IN' and result = 'PASS' limit 1`)).rows.length > 0;
      const reason = returnRejectionOf(snapshotOf(t), { accountId: i.accountId, nowMs: i.nowMs, eventStartsAtMs: t.eventStartsAt?.getTime(), entryRecorded: entry });
      if (reason) return { kind: 'REJECTED', reason };
      await this.o.deviceKeys?.revokeActiveInTx(tx, t.id, i.nowMs);
      await tx
        .update(ticket)
        .set({ accountId: t.payerAccountId, status: 'ACTIVE', transferPending: false, keyRevokedAt: new Date(i.nowMs), version: t.version + 1 })
        .where(eq(ticket.id, t.id));
      return { kind: 'OK', ticketId: t.id, replayed: false };
    });
  }

  async expireOffers(nowMs: number, limit: number): Promise<number> {
    return this.o.database.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(transferOffer)
        .where(and(eq(transferOffer.status, 'OFFERED'), lte(transferOffer.expiresAt, new Date(nowMs))))
        .orderBy(asc(transferOffer.expiresAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      for (const r of rows) {
        await tx.update(transferOffer).set({ status: 'EXPIRED', decidedAt: new Date(nowMs) }).where(eq(transferOffer.id, r.id));
        // 표시를 끄고 TRANSFER_PENDING이면 ACTIVE로 되돌린다(다른 상태는 그대로)
        await tx.execute(
          sql`update ticket set transfer_pending = false, status = case when status = 'TRANSFER_PENDING' then 'ACTIVE' else status end, version = version + 1 where id = ${r.ticketId}::uuid`,
        );
      }
      return rows.length;
    });
  }

  async setTransferLock(input: SetTransferLockInput): Promise<readonly TransferLockOutcome[]> {
    return this.o.database.transaction(async (tx) => {
      const out: TransferLockOutcome[] = [];
      for (const accountId of [...input.accountIds].sort()) {
        const [existing] = await tx
          .select()
          .from(fraudTransferLock)
          .where(and(eq(fraudTransferLock.caseId, input.caseId), eq(fraudTransferLock.eventId, input.eventId), eq(fraudTransferLock.accountId, accountId)))
          .limit(1)
          .for('update');
        // 잠금 행은 같은 사건의 더 큰 판만 반영한다(처음 기한은 늘리지 않는다, ADR-0173 결정 3)
        if (!existing) {
          if (input.locked) {
            await tx.insert(fraudTransferLock).values({
              caseId: input.caseId,
              eventId: input.eventId,
              accountId,
              locked: true,
              version: input.version,
              expiresAt: new Date(input.expiresAtMs ?? input.nowMs),
              changedAt: new Date(input.nowMs),
            });
          }
        } else if (input.version > Number(existing.version)) {
          await tx
            .update(fraudTransferLock)
            .set({ locked: input.locked, version: input.version, changedAt: new Date(input.nowMs) })
            .where(and(eq(fraudTransferLock.caseId, input.caseId), eq(fraudTransferLock.eventId, input.eventId), eq(fraudTransferLock.accountId, accountId)));
        }
        const rows = await tx
          .select()
          .from(ticket)
          .where(and(eq(ticket.eventId, input.eventId), eq(ticket.payerAccountId, accountId)))
          .orderBy(asc(ticket.id))
          .for('update');
        for (const row of rows) {
          const result = lockResultOf(snapshotOf(row), {
            caseId: input.caseId,
            version: input.version,
            locked: input.locked,
            nowMs: input.nowMs,
            entryRecorded: false,
          });
          if (result === 'LOCKED') out.push(await this.#lockTicket(tx, row, input));
          else if (result === 'UNLOCKED') {
            await tx.update(ticket).set({ fraudLockCaseId: null, fraudLockVersion: input.version, version: row.version + 1 }).where(eq(ticket.id, row.id));
            out.push({ ticketId: row.id, result: 'UNLOCKED' });
          } else if (result === 'UNCHANGED') out.push({ ticketId: row.id, result: row.fraudLockCaseId === input.caseId ? 'LOCKED' : 'UNLOCKED' });
          else out.push({ ticketId: row.id, result });
        }
      }
      return out;
    });
  }

  async lockActive(ticketId: string, nowMs: number): Promise<boolean> {
    const [t] = await this.o.database.db.select({ eventId: ticket.eventId, payer: ticket.payerAccountId }).from(ticket).where(eq(ticket.id, ticketId)).limit(1);
    if (!t) return false;
    return (await this.#activeLock(this.o.database.db, t.eventId, t.payer, nowMs)) !== undefined;
  }

  async #lockTicket(tx: DbTransaction, row: TicketRow, input: SetTransferLockInput): Promise<TransferLockOutcome> {
    const withdrawn = await tx
      .update(transferOffer)
      .set({ status: 'WITHDRAWN', withdrawReason: 'FRAUD_LOCK', decidedAt: new Date(input.nowMs) })
      .where(and(eq(transferOffer.ticketId, row.id), eq(transferOffer.status, 'OFFERED')))
      .returning({ id: transferOffer.id });
    await tx
      .update(ticket)
      .set({
        status: row.status === 'TRANSFER_PENDING' ? 'ACTIVE' : row.status,
        transferPending: false,
        fraudLockCaseId: input.caseId,
        fraudLockVersion: input.version,
        version: row.version + 1,
      })
      .where(eq(ticket.id, row.id));
    return {
      ticketId: row.id,
      result: 'LOCKED',
      ...(withdrawn[0] ? { withdrawnOfferId: withdrawn[0].id } : {}),
      ...(row.accountId !== row.payerAccountId ? { holderAccountId: row.accountId } : {}),
    };
  }

  async #activeLock(db: Database['db'] | DbTransaction, eventId: string, payerAccountId: string, nowMs: number): Promise<{ caseId: string; expiresAtMs: number } | undefined> {
    const rows = await db
      .select({ caseId: fraudTransferLock.caseId, expiresAt: fraudTransferLock.expiresAt })
      .from(fraudTransferLock)
      .where(and(eq(fraudTransferLock.eventId, eventId), eq(fraudTransferLock.accountId, payerAccountId), eq(fraudTransferLock.locked, true)))
      .orderBy(desc(fraudTransferLock.version))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    const [start] = await db
      .select({ eventStartsAt: ticket.eventStartsAt })
      .from(ticket)
      .where(eq(ticket.eventId, eventId))
      .orderBy(asc(ticket.createdAt))
      .limit(1);
    const startsAt = start?.eventStartsAt?.getTime();
    if (!lockActiveAt({ locked: true, expiresAtMs: row.expiresAt.getTime(), nowMs, eventStartsAtMs: startsAt })) return undefined;
    return { caseId: row.caseId, expiresAtMs: row.expiresAt.getTime() };
  }
}
