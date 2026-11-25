// 운영 양도 저장소(BUILD_ORDER GAT-050·GAT-055). 티켓·양도 요청 행을 FOR UPDATE 안에서 다시 보고,
// 수락은 보유자 변경·보낸 사람 키 폐기·요청 상태를 한 트랜잭션으로 처리한다(docs/features/transfer-refund.md §3.1·§4).
import type { Clock, Database, DbTransaction } from '@peaket/platform';
import { systemClock } from '@peaket/platform';
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type {
  CreateOfferOutcome,
  DecideOutcome,
  ListTransfersInput,
  ListTransfersResult,
  RecipientLookupClaim,
  RecipientLookupResult,
  ReturnOutcome,
  SetTransferLockInput,
  StoredTransferNotice,
  TransferLockOutcome,
  TransferNoticeStore,
  TransferOfferListRow,
  TransferStore,
} from '../../domain/transfer-ports.js';
import {
  acceptRejectionOf,
  createOfferRejectionOf,
  ENDED_STATUSES,
  lockActiveAt,
  lockResultOf,
  ownershipFrozen,
  publicWithdrawReasonOf,
  rejectRejectionOf,
  returnRejectionOf,
  type TransferOfferRecord,
  type TransferStatus,
  type TransferTicketSnapshot,
  withdrawRejectionOf,
} from '../../domain/transfer.js';
import { type TicketStatus } from '../../domain/ticket.js';
import type { DeviceKeyRevoker } from './drizzle-ticket-store.js';
import { fraudTransferLock, ticket, ticketReturn, transferNotice, transferOffer, transferRecipientLookup } from './schema.js';
import { TransferOutbox, type TransferEventCodec } from '../../domain/transfer-events.js';
import { writeTransferEffects } from './transfer-effects.js';

type TicketRow = typeof ticket.$inferSelect;
type OfferRow = typeof transferOffer.$inferSelect;

const ticketStatusOf = (v: string): TicketStatus => v as TicketStatus;
const offerStatusOf = (v: string): TransferStatus => v as TransferStatus;

const snapshotOf = (r: TicketRow, entryClosesAtMs?: number): TransferTicketSnapshot => ({
  ticketId: r.id,
  accountId: r.accountId,
  payerAccountId: r.payerAccountId,
  eventId: r.eventId,
  status: ticketStatusOf(r.status),
  transferPending: r.transferPending,
  gateZone: r.gateZone,
  ...(r.eventStartsAt ? { eventStartsAtMs: r.eventStartsAt.getTime() } : {}),
  ...(entryClosesAtMs === undefined ? {} : { entryClosesAtMs }),
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
  /** Outbox ID(uuidv7)에 쓰는 시계. 없으면 시스템 시계(시험은 가짜 시계) */
  readonly clock?: Clock;
  /** trade.tickets 값 코덱. 없으면 JSON 대역(시험) */
  readonly outboxCodec?: TransferEventCodec;
}

export class DrizzleTransferStore implements TransferStore, TransferNoticeStore {
  readonly #outbox: TransferOutbox;
  constructor(private readonly o: DrizzleTransferStoreOptions) {
    this.#outbox = new TransferOutbox(o.outboxCodec === undefined ? {} : { codec: o.outboxCodec });
  }

  #clock(): Clock {
    return this.o.clock ?? systemClock;
  }

  async ticket(ticketId: string): Promise<TransferTicketSnapshot | undefined> {
    const [row] = await this.o.database.db.select().from(ticket).where(eq(ticket.id, ticketId)).limit(1);
    if (!row) return undefined;
    return snapshotOf(row, await this.#entryClose(this.o.database.db, row.eventId));
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
      const reason = createOfferRejectionOf(snapshotOf(fresh), { callerAccountId: offer.fromAccountId, recipientAccountId: offer.toAccountId, nowMs, lockActive: lock !== undefined });
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
      await writeTransferEffects(tx, this.#outbox, this.#clock(), {
        ticket: { ticketId: fresh.id, eventId: fresh.eventId, orderId: fresh.orderId },
        offerId: offer.offerId,
        type: 'TRANSFER_OFFERED',
        fromAccountId: offer.fromAccountId,
        toAccountId: offer.toAccountId,
        accountId: offer.fromAccountId,
        nowMs,
        ...(offer.weakReauth === true ? { weakReauth: true } : {}),
      });
      return { kind: 'CREATED', offer };
    });
  }

  async getOffer(offerId: string): Promise<TransferOfferRecord | undefined> {
    const [row] = await this.o.database.db.select().from(transferOffer).where(eq(transferOffer.id, offerId)).limit(1);
    return row ? recordOf(row) : undefined;
  }

  async openOffer(ticketId: string): Promise<TransferOfferRecord | undefined> {
    const [row] = await this.o.database.db
      .select()
      .from(transferOffer)
      .where(and(eq(transferOffer.ticketId, ticketId), eq(transferOffer.status, 'OFFERED')))
      .limit(1);
    return row ? recordOf(row) : undefined;
  }

  async listOffers(input: ListTransfersInput): Promise<ListTransfersResult> {
    const where = and(
      eq(transferOffer.toAccountId, input.recipientAccountId),
      // 자기 양도(옛 데이터 포함)는 받은 요청 목록에 넣지 않는다. role이 SENDER로 어긋나고 수락하면 재발급 통제를 우회한다
      sql`${transferOffer.fromAccountId} <> ${transferOffer.toAccountId}`,
      input.statuses.length === 0 ? undefined : inArray(transferOffer.status, [...input.statuses]),
      input.cursor === undefined
        ? undefined
        : or(
            lt(transferOffer.createdAt, new Date(input.cursor.createdAtMs)),
            and(eq(transferOffer.createdAt, new Date(input.cursor.createdAtMs)), lt(transferOffer.id, input.cursor.offerId)),
          ),
    );
    const rows = await this.o.database.db
      .select({ offer: transferOffer, eventId: ticket.eventId })
      .from(transferOffer)
      .innerJoin(ticket, eq(ticket.id, transferOffer.ticketId))
      .where(where)
      .orderBy(desc(transferOffer.createdAt), desc(transferOffer.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      offers: page.map((r): TransferOfferListRow => ({ ...recordOf(r.offer), eventId: r.eventId })),
      ...(rows.length > input.limit && last ? { nextCursor: { createdAtMs: last.offer.createdAt.getTime(), offerId: last.offer.id } } : {}),
    };
  }

  async claimLookup(input: { accountId: string; nowMs: number; windowMs: number; limit: number }): Promise<RecipientLookupClaim> {
    return this.o.database.transaction(async (tx) => {
      // 같은 계정의 동시 조회를 한 차례로 만든다(동시 12건이 10·2로 갈리는 시험 T7 ③)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.accountId}::text, 0))`);
      const [counted] = await tx
        .select({
          n: sql<number>`count(*)::int`,
          oldest: sql<Date | string | null>`min(${transferRecipientLookup.lookedUpAt})`,
        })
        .from(transferRecipientLookup)
        .where(
          and(
            eq(transferRecipientLookup.accountId, input.accountId),
            gt(transferRecipientLookup.lookedUpAt, new Date(input.nowMs - input.windowMs)),
            sql`${transferRecipientLookup.result} <> 'LIMITED'`,
          ),
        );
      if (Number(counted?.n ?? 0) >= input.limit) {
        await tx.insert(transferRecipientLookup).values({ id: randomUUID(), accountId: input.accountId, lookedUpAt: new Date(input.nowMs), result: 'LIMITED' });
        const oldest = counted?.oldest === null || counted?.oldest === undefined ? input.nowMs : new Date(counted.oldest).getTime();
        return { kind: 'LIMITED', retryAfterSeconds: Math.max(1, Math.ceil((oldest + input.windowMs - input.nowMs) / 1000)) };
      }
      const id = randomUUID();
      await tx.insert(transferRecipientLookup).values({ id, accountId: input.accountId, lookedUpAt: new Date(input.nowMs), result: 'UNAVAILABLE' });
      return { kind: 'ALLOWED', lookupId: id };
    });
  }

  async finishLookup(lookupId: string, result: RecipientLookupResult): Promise<void> {
    await this.o.database.db.update(transferRecipientLookup).set({ result }).where(eq(transferRecipientLookup.id, lookupId));
  }

  async accept(i: { offerId: string; accountId: string; nowMs: number }): Promise<DecideOutcome> {
    // 같은 표를 노리는 수락이 몰려 풀 대기(server-busy)가 나면 한 트랜잭션도 시작하지 않은 상태라 두 번까지 다시 잡는다.
    // 경합 시험 T3 ④처럼 30개가 한꺼번에 와도 수락 하나가 429로 새지 않게 하는 것이다(운영에서도 같은 뜻).
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.o.database.transaction(async (tx) => {
          // 행 잠금 차례는 티켓 → 요청이다. setTransferLock과 같은 차례로 교착을 막는다(RV-02).
          // 요청의 티켓을 한 문장으로 찾으며 바로 잠근다(요청 조회를 앞에 두지 않아 같은 순간에 들어온 수락이 행 잠금을 먼저 잡는다).
          const [t] = await tx
            .select()
            .from(ticket)
            .where(sql`${ticket.id} = (select ticket_id from transfer_offer where id = ${i.offerId})`)
            .limit(1)
            .for('update');
          if (!t) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
          const [offerRow] = await tx.select().from(transferOffer).where(eq(transferOffer.id, i.offerId)).limit(1).for('update');
          if (!offerRow) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
          const current = recordOf(offerRow);
          if (current.toAccountId !== i.accountId) return { kind: 'REJECTED', reason: 'NOT_RECIPIENT' };
          const reason = acceptRejectionOf(current, { accountId: i.accountId, nowMs: i.nowMs, eventStartsAtMs: t.eventStartsAt?.getTime() });
          if (reason) return { kind: 'REJECTED', reason };
          // 이미 수락한 요청의 재생은 표 상태와 상관없이 처음 결과다(멱등)
          if (current.status === 'ACCEPTED') return { kind: 'OK', offer: current, replayed: true };
          // 겹친 가드 D2: 요청이 남아 있어도 끝난 표(환급·무효·취소 접수·부정 표시)는 받지 않는다
          if (ENDED_STATUSES.has(ticketStatusOf(t.status))) return { kind: 'REJECTED', reason: 'ALREADY_ENDED' };
          if (t.accountId !== current.fromAccountId) return { kind: 'REJECTED', reason: 'NOT_OFFERED' };
          await tx.update(transferOffer).set({ status: 'ACCEPTED', decidedAt: new Date(i.nowMs) }).where(eq(transferOffer.id, i.offerId));
          await this.o.deviceKeys?.revokeActiveInTx(tx, t.id, i.nowMs);
          await tx
            .update(ticket)
            .set({ accountId: current.toAccountId, status: 'ACTIVE', transferPending: false, keyRevokedAt: new Date(i.nowMs), version: t.version + 1 })
            .where(eq(ticket.id, t.id));
          await writeTransferEffects(tx, this.#outbox, this.#clock(), {
            ticket: { ticketId: t.id, eventId: t.eventId, orderId: t.orderId },
            offerId: current.offerId,
            type: 'TRANSFER_ACCEPTED',
            fromAccountId: current.fromAccountId,
            toAccountId: current.toAccountId,
            accountId: current.toAccountId,
            nowMs: i.nowMs,
          });
          return { kind: 'OK', offer: { ...current, status: 'ACCEPTED', decidedAtMs: i.nowMs }, replayed: false };
        });
      } catch (e) {
        const busy = typeof e === 'object' && e !== null && (e as { slug?: unknown }).slug === 'server-busy';
        if (busy && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
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
      await writeTransferEffects(tx, this.#outbox, this.#clock(), {
        ticket: { ticketId: t.id, eventId: t.eventId, orderId: t.orderId },
        offerId: offer.offerId,
        type: 'TRANSFER_REJECTED',
        fromAccountId: offer.fromAccountId,
        toAccountId: offer.toAccountId,
        accountId: offer.fromAccountId,
        nowMs: i.nowMs,
      });
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
      await writeTransferEffects(tx, this.#outbox, this.#clock(), {
        ticket: { ticketId: t.id, eventId: t.eventId, orderId: t.orderId },
        offerId: offer.offerId,
        type: 'TRANSFER_WITHDRAWN',
        fromAccountId: offer.fromAccountId,
        toAccountId: offer.toAccountId,
        accountId: offer.fromAccountId,
        reason: 'SENDER',
        nowMs: i.nowMs,
      });
      return { kind: 'OK', offer: { ...offer, status: 'WITHDRAWN', withdrawReason: 'SENDER', decidedAtMs: i.nowMs }, replayed: false };
    });
  }

  async returnToPayer(i: { ticketId: string; accountId: string; nowMs: number; idempotencyKey: string }): Promise<ReturnOutcome> {
    return this.o.database.transaction(async (tx) => {
      // 표 행 잠금이 같은 표의 동시 돌려주기를 한 차례로 만든다. 재생은 판정보다 먼저 본다(같은 키·같은 표)
      const [t] = await tx.select().from(ticket).where(eq(ticket.id, i.ticketId)).limit(1).for('update');
      if (!t) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
      const [recorded] = await tx
        .select({ ticketId: ticketReturn.ticketId })
        .from(ticketReturn)
        .where(and(eq(ticketReturn.accountId, i.accountId), eq(ticketReturn.idempotencyKey, i.idempotencyKey)))
        .limit(1);
      if (recorded) return recorded.ticketId === i.ticketId ? { kind: 'OK', ticketId: recorded.ticketId, replayed: true } : { kind: 'REJECTED', reason: 'IDEMPOTENCY_KEY_REUSED' };
      const entry = (await tx.execute(sql`select 1 from scan_event where event_id = ${t.eventId}::uuid and ticket_id = ${t.id}::uuid and direction = 'IN' and result = 'PASS' limit 1`)).rows.length > 0;
      const entryClose = await this.#entryClose(tx, t.eventId);
      const reason = returnRejectionOf(snapshotOf(t, entryClose), {
        accountId: i.accountId,
        nowMs: i.nowMs,
        eventStartsAtMs: t.eventStartsAt?.getTime(),
        ...(entryClose === undefined ? {} : { entryClosesAtMs: entryClose }),
        entryRecorded: entry,
      });
      if (reason) return { kind: 'REJECTED', reason };
      // 기록을 표 변경과 같은 트랜잭션에 쓴다. 쓰기가 실패하면 보유자·키·표시가 모두 되돌아간다(T8 ②)
      const inserted = await tx
        .insert(ticketReturn)
        .values({ idempotencyKey: i.idempotencyKey, accountId: i.accountId, ticketId: t.id, returnedAt: new Date(i.nowMs) })
        .onConflictDoNothing()
        .returning({ ticketId: ticketReturn.ticketId });
      if (inserted.length === 0) {
        // 같은 키로 다른 표를 동시에 돌려준 경우(표 행이 달라 함께 들어왔다)
        const [other] = await tx
          .select({ ticketId: ticketReturn.ticketId })
          .from(ticketReturn)
          .where(and(eq(ticketReturn.accountId, i.accountId), eq(ticketReturn.idempotencyKey, i.idempotencyKey)))
          .limit(1);
        return other && other.ticketId !== i.ticketId ? { kind: 'REJECTED', reason: 'IDEMPOTENCY_KEY_REUSED' } : { kind: 'OK', ticketId: t.id, replayed: true };
      }
      await this.o.deviceKeys?.revokeActiveInTx(tx, t.id, i.nowMs);
      await tx
        .update(ticket)
        .set({ accountId: t.payerAccountId, status: 'ACTIVE', transferPending: false, keyRevokedAt: new Date(i.nowMs), version: t.version + 1 })
        .where(eq(ticket.id, t.id));
      const offerId = await this.#lastOfferId(tx, t.id);
      await writeTransferEffects(tx, this.#outbox, this.#clock(), {
        ticket: { ticketId: t.id, eventId: t.eventId, orderId: t.orderId },
        offerId,
        type: 'TICKET_RETURNED',
        fromAccountId: t.accountId,
        toAccountId: t.payerAccountId,
        accountId: t.payerAccountId,
        nowMs: i.nowMs,
      });
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
        const [t] = await tx
          .select({ id: ticket.id, eventId: ticket.eventId, orderId: ticket.orderId })
          .from(ticket)
          .where(eq(ticket.id, r.ticketId))
          .limit(1);
        if (t) {
          await writeTransferEffects(tx, this.#outbox, this.#clock(), {
            ticket: { ticketId: t.id, eventId: t.eventId, orderId: t.orderId },
            offerId: r.id,
            type: 'TRANSFER_EXPIRED',
            fromAccountId: r.fromAccountId,
            toAccountId: r.toAccountId,
            accountId: r.fromAccountId,
            nowMs,
          });
        }
      }
      return rows.length;
    });
  }

  // ---- F-05-11: 연기 철회·탈퇴 참여자 ----

  async withdrawForEvent(i: { eventId: string; reason: 'EVENT_POSTPONED'; nowMs: number }): Promise<{ withdrawn: readonly string[] }> {
    return this.o.database.transaction(async (tx) => {
      const rows = await tx
        .select({ offer: transferOffer, t: ticket })
        .from(transferOffer)
        .innerJoin(ticket, eq(ticket.id, transferOffer.ticketId))
        .where(and(eq(ticket.eventId, i.eventId), eq(transferOffer.status, 'OFFERED')))
        .orderBy(asc(transferOffer.createdAt), asc(transferOffer.id))
        .for('update');
      const withdrawn: string[] = [];
      for (const { offer, t } of rows) {
        await tx.update(transferOffer).set({ status: 'WITHDRAWN', withdrawReason: i.reason, decidedAt: new Date(i.nowMs) }).where(eq(transferOffer.id, offer.id));
        await this.#releaseTicket(tx, t.id, i.nowMs);
        await writeTransferEffects(tx, this.#outbox, this.#clock(), {
          ticket: { ticketId: t.id, eventId: t.eventId, orderId: t.orderId },
          offerId: offer.id,
          type: 'TRANSFER_WITHDRAWN',
          fromAccountId: offer.fromAccountId,
          toAccountId: offer.toAccountId,
          accountId: offer.fromAccountId,
          reason: 'EVENT_POSTPONED',
          nowMs: i.nowMs,
        });
        withdrawn.push(offer.id);
      }
      return { withdrawn };
    });
  }

  async accountTransfers(i: { accountId: string }): Promise<{ heldReceived: readonly string[]; sentOffers: readonly string[]; receivedOffers: readonly string[] }> {
    const held = await this.o.database.db
      .select({ id: ticket.id, status: ticket.status })
      .from(ticket)
      .where(and(eq(ticket.accountId, i.accountId), sql`${ticket.payerAccountId} <> ${i.accountId}`))
      .orderBy(asc(ticket.id));
    const heldReceived = held.filter((t) => !ENDED_STATUSES.has(ticketStatusOf(t.status))).map((t) => t.id);
    const sent = await this.o.database.db
      .select({ id: transferOffer.id })
      .from(transferOffer)
      .where(and(eq(transferOffer.fromAccountId, i.accountId), eq(transferOffer.status, 'OFFERED')))
      .orderBy(asc(transferOffer.id));
    const received = await this.o.database.db
      .select({ id: transferOffer.id })
      .from(transferOffer)
      .where(and(eq(transferOffer.toAccountId, i.accountId), eq(transferOffer.status, 'OFFERED'), sql`${transferOffer.fromAccountId} <> ${transferOffer.toAccountId}`))
      .orderBy(asc(transferOffer.id));
    return { heldReceived, sentOffers: sent.map((o) => o.id), receivedOffers: received.map((o) => o.id) };
  }

  async returnForAccount(i: { ticketId: string; accountId: string; nowMs: number }): Promise<'RETURNED' | 'FROZEN'> {
    return this.o.database.transaction(async (tx) => {
      const [t] = await tx.select().from(ticket).where(eq(ticket.id, i.ticketId)).limit(1).for('update');
      if (!t || t.accountId !== i.accountId || t.payerAccountId === i.accountId) throw new Error('돌려줄 받은 표가 아니다');
      if (ENDED_STATUSES.has(ticketStatusOf(t.status))) throw new Error('이미 끝난 표다');
      const entryClose = await this.#entryClose(tx, t.eventId);
      if (ownershipFrozen(t.eventStartsAt?.getTime(), entryClose, i.nowMs)) {
        await this.o.deviceKeys?.revokeActiveInTx(tx, t.id, i.nowMs);
        return 'FROZEN';
      }
      await this.o.deviceKeys?.revokeActiveInTx(tx, t.id, i.nowMs);
      await tx
        .update(ticket)
        .set({ accountId: t.payerAccountId, status: 'ACTIVE', transferPending: false, keyRevokedAt: new Date(i.nowMs), version: t.version + 1 })
        .where(eq(ticket.id, t.id));
      const offerId = await this.#lastOfferId(tx, t.id);
      await writeTransferEffects(tx, this.#outbox, this.#clock(), {
        ticket: { ticketId: t.id, eventId: t.eventId, orderId: t.orderId },
        offerId,
        type: 'TICKET_RETURNED',
        fromAccountId: t.accountId,
        toAccountId: t.payerAccountId,
        accountId: t.payerAccountId,
        nowMs: i.nowMs,
      });
      return 'RETURNED';
    });
  }

  async withdrawForAccount(i: { offerId: string; accountId: string; nowMs: number }): Promise<void> {
    await this.o.database.transaction(async (tx) => {
      const [row] = await tx
        .select({ offer: transferOffer, t: ticket })
        .from(transferOffer)
        .innerJoin(ticket, eq(ticket.id, transferOffer.ticketId))
        .where(eq(transferOffer.id, i.offerId))
        .limit(1)
        .for('update');
      if (!row || row.offer.fromAccountId !== i.accountId || row.offer.status !== 'OFFERED') return;
      await tx.update(transferOffer).set({ status: 'WITHDRAWN', withdrawReason: 'ACCOUNT_DELETED', decidedAt: new Date(i.nowMs) }).where(eq(transferOffer.id, i.offerId));
      await this.#releaseTicket(tx, row.t.id, i.nowMs);
      await writeTransferEffects(tx, this.#outbox, this.#clock(), {
        ticket: { ticketId: row.t.id, eventId: row.t.eventId, orderId: row.t.orderId },
        offerId: i.offerId,
        type: 'TRANSFER_WITHDRAWN',
        fromAccountId: row.offer.fromAccountId,
        toAccountId: row.offer.toAccountId,
        accountId: row.offer.fromAccountId,
        reason: 'OTHER',
        nowMs: i.nowMs,
      });
    });
  }

  async rejectForAccount(i: { offerId: string; accountId: string; nowMs: number }): Promise<void> {
    await this.o.database.transaction(async (tx) => {
      const [row] = await tx
        .select({ offer: transferOffer, t: ticket })
        .from(transferOffer)
        .innerJoin(ticket, eq(ticket.id, transferOffer.ticketId))
        .where(eq(transferOffer.id, i.offerId))
        .limit(1)
        .for('update');
      if (!row || row.offer.toAccountId !== i.accountId || row.offer.status !== 'OFFERED') return;
      await tx.update(transferOffer).set({ status: 'REJECTED', decidedAt: new Date(i.nowMs) }).where(eq(transferOffer.id, i.offerId));
      await this.#releaseTicket(tx, row.t.id, i.nowMs);
      await writeTransferEffects(tx, this.#outbox, this.#clock(), {
        ticket: { ticketId: row.t.id, eventId: row.t.eventId, orderId: row.t.orderId },
        offerId: i.offerId,
        type: 'TRANSFER_REJECTED',
        fromAccountId: row.offer.fromAccountId,
        toAccountId: row.offer.toAccountId,
        accountId: row.offer.fromAccountId,
        nowMs: i.nowMs,
      });
    });
  }

  // ---- transfer_notice 보내기 표(TransferNoticeStore) ----

  async claimDue(nowMs: number, limit: number, leaseMs: number): Promise<readonly StoredTransferNotice[]> {
    const rows = (await this.o.database.db.execute(sql`
      with due as (
        select id from transfer_notice
        where sent_at is null and next_attempt_at <= ${new Date(nowMs)}
        order by next_attempt_at, created_at
        limit ${limit}
        for update skip locked
      )
      update transfer_notice n
      set attempts = n.attempts + 1, next_attempt_at = ${new Date(nowMs + leaseMs)}
      from due
      where n.id = due.id
      returning n.id, n.type, n.party, n.offer_id, n.ticket_id, n.event_id, n.account_id, n.reason, n.created_at, n.attempts`)).rows as {
      id: string;
      type: string;
      party: string;
      offer_id: string;
      ticket_id: string;
      event_id: string;
      account_id: string;
      reason: string | null;
      created_at: Date | string;
      attempts: number;
    }[];
    return rows.map((r) => ({
      noticeId: r.id,
      type: r.type as StoredTransferNotice['type'],
      party: r.party as StoredTransferNotice['party'],
      offerId: r.offer_id,
      ticketId: r.ticket_id,
      eventId: r.event_id,
      accountId: r.account_id,
      createdAtMs: new Date(r.created_at).getTime(),
      attempts: Number(r.attempts),
      ...(r.reason === null ? {} : { reason: r.reason as NonNullable<StoredTransferNotice['reason']> }),
    }));
  }

  async markSent(noticeId: string, nowMs: number): Promise<void> {
    await this.o.database.db.update(transferNotice).set({ sentAt: new Date(nowMs) }).where(and(eq(transferNotice.id, noticeId), isNull(transferNotice.sentAt)));
  }

  async reschedule(noticeId: string, nextAttemptAtMs: number): Promise<void> {
    await this.o.database.db.update(transferNotice).set({ nextAttemptAt: new Date(nextAttemptAtMs) }).where(and(eq(transferNotice.id, noticeId), isNull(transferNotice.sentAt)));
  }

  async purgeSent(beforeMs: number): Promise<number> {
    // 보낸 지 7일이 되는 순간 지운다(경계 0ms 포함)
    const rows = await this.o.database.db.delete(transferNotice).where(and(sql`${transferNotice.sentAt} is not null`, lte(transferNotice.sentAt, new Date(beforeMs)))).returning({ id: transferNotice.id });
    return rows.length;
  }

  async backlog(): Promise<{ count: number; oldestCreatedAtMs?: number }> {
    const rows = (await this.o.database.db.execute(sql`select count(*)::int as n, min(created_at) as oldest from transfer_notice where sent_at is null`)).rows as { n: number; oldest: Date | string | null }[];
    const n = Number(rows[0]?.n ?? 0);
    const oldest = rows[0]?.oldest;
    return n > 0 && oldest !== null && oldest !== undefined ? { count: n, oldestCreatedAtMs: new Date(oldest).getTime() } : { count: n };
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

  /** 그 회차 entry_close.closed_at. 없으면 undefined(도메인이 시작 + 50시간을 쓴다) */
  async #entryClose(db: Database['db'] | DbTransaction, eventId: string): Promise<number | undefined> {
    const r = await db.execute(sql`select closed_at from entry_close where event_id = ${eventId}::uuid limit 1`);
    const row = (r.rows as { closed_at: Date | string }[])[0];
    return row === undefined ? undefined : new Date(row.closed_at).getTime();
  }

  async #lastOfferId(tx: DbTransaction, ticketId: string): Promise<string> {
    const [row] = await tx.select({ id: transferOffer.id }).from(transferOffer).where(eq(transferOffer.ticketId, ticketId)).orderBy(desc(transferOffer.createdAt), desc(transferOffer.id)).limit(1);
    return row?.id ?? ticketId;
  }

  /** 양도 표시를 끄고 TRANSFER_PENDING이면 ACTIVE로 되돌린다(다른 상태는 그대로) */
  async #releaseTicket(tx: DbTransaction, ticketId: string, _nowMs: number): Promise<void> {
    await tx.execute(
      sql`update ticket set transfer_pending = false, status = case when status = 'TRANSFER_PENDING' then 'ACTIVE' else status end, version = version + 1 where id = ${ticketId}::uuid`,
    );
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
