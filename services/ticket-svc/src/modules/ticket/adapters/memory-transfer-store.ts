// 메모리 양도 저장소(BUILD_ORDER GAT-050·GAT-055 단위 시험). 운영은 adapters/db/drizzle-transfer-store.ts가 쓴다.
// 티켓 상태·키 폐기·표시는 MemoryTicketStore를 그대로 고친다(운영의 행 잠금 자리를 대신한다).
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
  TransferLockOutcome,
  TransferOfferListRow,
  TransferStore,
} from '../domain/transfer-ports.js';
import type { TicketRecord } from '../domain/ticket.js';
import {
  acceptRejectionOf,
  createOfferRejectionOf,
  ENDED_STATUSES,
  lockActiveAt,
  lockResultOf,
  rejectRejectionOf,
  returnRejectionOf,
  type TransferOfferRecord,
  type TransferStatus,
  type TransferTicketSnapshot,
  withdrawRejectionOf,
} from '../domain/transfer.js';
import type { MemoryTicketStore } from './memory-ticket-store.js';

interface LockRow {
  readonly caseId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly locked: boolean;
  readonly version: number;
  readonly expiresAtMs: number;
}

const snapshotOf = (t: TicketRecord): TransferTicketSnapshot => ({
  ticketId: t.ticketId,
  accountId: t.accountId,
  payerAccountId: t.payerAccountId,
  eventId: t.eventId,
  status: t.status,
  transferPending: t.transferPending,
  gateZone: t.gateZone,
  ...(t.eventStartsAtMs === undefined ? {} : { eventStartsAtMs: t.eventStartsAtMs }),
  ...(t.fraudLockCaseId === undefined ? {} : { fraudLockCaseId: t.fraudLockCaseId }),
  ...(t.fraudLockVersion === undefined ? {} : { fraudLockVersion: t.fraudLockVersion }),
});

export class MemoryTransferStore implements TransferStore {
  /** 양도 요청(offerId = Idempotency-Key) */
  readonly offers = new Map<string, TransferOfferRecord>();
  /** (case_id, event_id, account_id) 잠금 행 */
  readonly locks = new Map<string, LockRow>();
  /** 받는 사람 조회 기록(0018 transfer_recipient_lookup의 대역) */
  readonly lookups: { id: string; accountId: string; lookedUpAtMs: number; result: RecipientLookupResult }[] = [];
  /** 돌려주기 멱등 기록(`accountId:key` → ticketId). 0018 ticket_return의 대역 */
  readonly returns = new Map<string, { ticketId: string; returnedAtMs: number }>();

  constructor(private readonly o: { readonly tickets: MemoryTicketStore; readonly revokeKey?: (ticketId: string, nowMs: number) => void }) {
    // 잠금 뒤에 발권한 표도 잠긴다(R-T31 ⑬). MemoryTicketStore가 발권 때 이 함수를 본다
    this.o.tickets.fraudLockLookup = (eventId, payerAccountId, nowMs) => {
      const lock = this.#activeLockRow(eventId, payerAccountId, nowMs);
      return lock ? { caseId: lock.caseId, version: lock.version } : undefined;
    };
    // 월렛 목록의 pendingTransfer는 표 저장소가 이 요청을 읽어 싣는다
    this.o.tickets.openOfferLookup = (ticketId) => {
      const offer = this.#openOfferRecord(ticketId);
      return offer ? { offerId: offer.offerId, expiresAtMs: offer.expiresAtMs } : undefined;
    };
    // 회차 취소·운영자 취소가 표를 끝내는 같은 트랜잭션(메모리라 같은 호출)에서 요청을 거둔다(불변식 D1)
    this.o.tickets.withdrawOpenOffer = (ticketId, reason, nowMs) => this.#withdrawOpenOffer(ticketId, reason, nowMs);
  }

  async ticket(ticketId: string): Promise<TransferTicketSnapshot | undefined> {
    const t = this.o.tickets.tickets.get(ticketId);
    return t ? snapshotOf(t) : undefined;
  }

  async activeTransferLock(eventId: string, payerAccountId: string, nowMs: number): Promise<{ caseId: string; expiresAtMs: number } | undefined> {
    const row = this.#activeLockRow(eventId, payerAccountId, nowMs);
    return row ? { caseId: row.caseId, expiresAtMs: row.expiresAtMs } : undefined;
  }

  async createOffer(offer: TransferOfferRecord, nowMs: number): Promise<CreateOfferOutcome> {
    const existing = this.offers.get(offer.offerId);
    if (existing) return { kind: 'REPLAYED', offer: existing };
    // 기한 지난 요청을 먼저 만료시켜 표시를 푼다(RV-01). 만료 고리가 늦어도 새 요청·취소가 막히지 않는다
    this.#expireTicketOffers(offer.ticketId, nowMs);
    const t = this.o.tickets.tickets.get(offer.ticketId);
    if (!t) return { kind: 'REJECTED', reason: 'NOT_HOLDER' };
    const lock = this.#activeLockRow(t.eventId, t.payerAccountId, nowMs);
    const reason = createOfferRejectionOf(snapshotOf(t), { callerAccountId: offer.fromAccountId, recipientAccountId: offer.toAccountId, nowMs, lockActive: lock !== undefined });
    if (reason) return { kind: 'REJECTED', reason };
    this.offers.set(offer.offerId, offer);
    this.#put({ ...t, status: 'TRANSFER_PENDING', transferPending: true, version: t.version + 1 });
    return { kind: 'CREATED', offer };
  }

  async getOffer(offerId: string): Promise<TransferOfferRecord | undefined> {
    return this.offers.get(offerId);
  }

  async openOffer(ticketId: string): Promise<TransferOfferRecord | undefined> {
    return this.#openOfferRecord(ticketId);
  }

  async listOffers(input: ListTransfersInput): Promise<ListTransfersResult> {
    const wanted = input.statuses.length === 0 ? undefined : new Set<TransferStatus>(input.statuses);
    const rows = [...this.offers.values()]
      .filter((o) => o.toAccountId === input.recipientAccountId && o.fromAccountId !== o.toAccountId && (wanted === undefined || wanted.has(o.status)))
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.offerId.localeCompare(a.offerId))
      .map((o): TransferOfferListRow => ({ ...o, eventId: this.o.tickets.tickets.get(o.ticketId)?.eventId ?? '' }))
      .filter((o) => o.eventId !== '');
    const after =
      input.cursor === undefined
        ? rows
        : rows.filter((o) => o.createdAtMs < input.cursor!.createdAtMs || (o.createdAtMs === input.cursor!.createdAtMs && o.offerId < input.cursor!.offerId));
    const page = after.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      offers: page,
      ...(after.length > input.limit && last ? { nextCursor: { createdAtMs: last.createdAtMs, offerId: last.offerId } } : {}),
    };
  }

  async claimLookup(input: { accountId: string; nowMs: number; windowMs: number; limit: number }): Promise<RecipientLookupClaim> {
    const inWindow = this.lookups.filter((r) => r.accountId === input.accountId && r.result !== 'LIMITED' && r.lookedUpAtMs > input.nowMs - input.windowMs);
    if (inWindow.length >= input.limit) {
      this.lookups.push({ id: randomUUID(), accountId: input.accountId, lookedUpAtMs: input.nowMs, result: 'LIMITED' });
      const oldest = Math.min(...inWindow.map((r) => r.lookedUpAtMs));
      const seconds = Math.max(1, Math.ceil((oldest + input.windowMs - input.nowMs) / 1000));
      return { kind: 'LIMITED', retryAfterSeconds: seconds };
    }
    const id = randomUUID();
    this.lookups.push({ id, accountId: input.accountId, lookedUpAtMs: input.nowMs, result: 'UNAVAILABLE' });
    return { kind: 'ALLOWED', lookupId: id };
  }

  async finishLookup(lookupId: string, result: RecipientLookupResult): Promise<void> {
    const row = this.lookups.find((r) => r.id === lookupId);
    if (row) row.result = result;
  }

  async accept(i: { offerId: string; accountId: string; nowMs: number }): Promise<DecideOutcome> {
    const offer = this.offers.get(i.offerId);
    if (!offer) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
    const t = this.o.tickets.tickets.get(offer.ticketId);
    if (!t) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
    const reason = acceptRejectionOf(offer, { accountId: i.accountId, nowMs: i.nowMs, eventStartsAtMs: t.eventStartsAtMs });
    if (reason) return { kind: 'REJECTED', reason };
    // 이미 수락한 요청의 재생은 표 상태와 상관없이 처음 결과다(멱등)
    if (offer.status === 'ACCEPTED') return { kind: 'OK', offer, replayed: true };
    // 겹친 가드 D2: 요청이 남아 있어도 끝난 표는 받지 않는다(환급된 표가 되살아나지 않게)
    if (ENDED_STATUSES.has(t.status)) return { kind: 'REJECTED', reason: 'ALREADY_ENDED' };
    const decided: TransferOfferRecord = { ...offer, status: 'ACCEPTED', decidedAtMs: i.nowMs };
    this.offers.set(offer.offerId, decided);
    this.o.revokeKey?.(t.ticketId, i.nowMs);
    this.#put({ ...t, accountId: offer.toAccountId, status: 'ACTIVE', transferPending: false, keyRevokedAtMs: i.nowMs, version: t.version + 1 });
    return { kind: 'OK', offer: decided, replayed: false };
  }

  async reject(i: { offerId: string; accountId: string; nowMs: number }): Promise<DecideOutcome> {
    const offer = this.offers.get(i.offerId);
    if (!offer) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
    const t = this.o.tickets.tickets.get(offer.ticketId);
    if (!t) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
    const reason = rejectRejectionOf(offer, { accountId: i.accountId, nowMs: i.nowMs, eventStartsAtMs: t.eventStartsAtMs });
    if (reason) return { kind: 'REJECTED', reason };
    if (offer.status === 'REJECTED') return { kind: 'OK', offer, replayed: true };
    const decided: TransferOfferRecord = { ...offer, status: 'REJECTED', decidedAtMs: i.nowMs };
    this.offers.set(offer.offerId, decided);
    this.#release(t);
    return { kind: 'OK', offer: decided, replayed: false };
  }

  async withdraw(i: { offerId: string; accountId: string; nowMs: number }): Promise<DecideOutcome> {
    const offer = this.offers.get(i.offerId);
    if (!offer) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
    const t = this.o.tickets.tickets.get(offer.ticketId);
    if (!t) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
    const reason = withdrawRejectionOf(offer, { accountId: i.accountId, nowMs: i.nowMs });
    if (reason) return { kind: 'REJECTED', reason };
    if (offer.status === 'WITHDRAWN') return { kind: 'OK', offer, replayed: true };
    const decided: TransferOfferRecord = { ...offer, status: 'WITHDRAWN', withdrawReason: 'SENDER', decidedAtMs: i.nowMs };
    this.offers.set(offer.offerId, decided);
    this.#release(t);
    return { kind: 'OK', offer: decided, replayed: false };
  }

  async returnToPayer(i: { ticketId: string; accountId: string; nowMs: number; idempotencyKey: string }): Promise<ReturnOutcome> {
    const recorded = this.returns.get(`${i.accountId}:${i.idempotencyKey}`);
    if (recorded) return recorded.ticketId === i.ticketId ? { kind: 'OK', ticketId: recorded.ticketId, replayed: true } : { kind: 'REJECTED', reason: 'IDEMPOTENCY_KEY_REUSED' };
    const t = this.o.tickets.tickets.get(i.ticketId);
    if (!t) return { kind: 'REJECTED', reason: 'NOT_FOUND' };
    const reason = returnRejectionOf(snapshotOf(t), {
      accountId: i.accountId,
      nowMs: i.nowMs,
      eventStartsAtMs: t.eventStartsAtMs,
      entryRecorded: this.o.tickets.entries.has(t.ticketId),
    });
    if (reason) return { kind: 'REJECTED', reason };
    this.o.revokeKey?.(t.ticketId, i.nowMs);
    this.#put({ ...t, accountId: t.payerAccountId, status: 'ACTIVE', transferPending: false, keyRevokedAtMs: i.nowMs, version: t.version + 1 });
    this.returns.set(`${i.accountId}:${i.idempotencyKey}`, { ticketId: t.ticketId, returnedAtMs: i.nowMs });
    return { kind: 'OK', ticketId: t.ticketId, replayed: false };
  }

  async expireOffers(nowMs: number, limit: number): Promise<number> {
    let n = 0;
    for (const offer of this.offers.values()) {
      if (n >= limit) break;
      if (offer.status !== 'OFFERED' || nowMs < offer.expiresAtMs) continue;
      this.offers.set(offer.offerId, { ...offer, status: 'EXPIRED', decidedAtMs: nowMs });
      const t = this.o.tickets.tickets.get(offer.ticketId);
      if (t) this.#release(t);
      n++;
    }
    return n;
  }

  async expireFraudLocks(nowMs: number): Promise<number> {
    let n = 0;
    for (const [key, row] of this.locks) {
      const start = this.#eventStartsAt(row.eventId);
      if (lockActiveAt({ locked: row.locked, expiresAtMs: row.expiresAtMs, nowMs, eventStartsAtMs: start })) continue;
      if (!row.locked) continue;
      this.locks.set(key, { ...row, locked: false });
      for (const t of this.o.tickets.tickets.values()) {
        if (t.eventId !== row.eventId || t.payerAccountId !== row.accountId) continue;
        if (t.fraudLockCaseId !== row.caseId) continue;
        this.#put({ ...t, fraudLockCaseId: undefined, fraudLockVersion: row.version + 1 });
        n += 1;
      }
    }
    return n;
  }

  async setTransferLock(input: SetTransferLockInput): Promise<readonly TransferLockOutcome[]> {
    const out: TransferLockOutcome[] = [];
    for (const accountId of input.accountIds) {
      const key = `${input.caseId}:${input.eventId}:${accountId}`;
      const existing = this.locks.get(key);
      const newer = existing === undefined || input.version > existing.version;
      if (newer) {
        this.locks.set(key, {
          caseId: input.caseId,
          eventId: input.eventId,
          accountId,
          locked: input.locked,
          version: input.version,
          // 처음 잠글 때의 기한을 지킨다(더 큰 판으로 다시 잠가도 늘지 않는다, ADR-0173 결정 3)
          expiresAtMs: input.locked ? (existing?.expiresAtMs ?? input.expiresAtMs ?? 0) : (existing?.expiresAtMs ?? 0),
        });
      }
      const targets = [...this.o.tickets.tickets.values()].filter((t) => t.eventId === input.eventId && t.payerAccountId === accountId).sort((a, b) => a.ticketId.localeCompare(b.ticketId));
      for (const t of targets) {
        const result = lockResultOf(snapshotOf(t), {
          caseId: input.caseId,
          version: input.version,
          locked: input.locked,
          nowMs: input.nowMs,
          entryRecorded: this.o.tickets.entries.has(t.ticketId),
        });
        if (result === 'LOCKED' || result === 'UNLOCKED') {
          out.push(this.#applyLock(t, input, result));
        } else if (result === 'UNCHANGED') {
          const locked = t.fraudLockCaseId === input.caseId;
          out.push({ ticketId: t.ticketId, result: locked ? 'LOCKED' : 'UNLOCKED' });
        } else {
          out.push({ ticketId: t.ticketId, result });
        }
      }
    }
    return out;
  }

  async lockActive(ticketId: string, nowMs: number): Promise<boolean> {
    const t = this.o.tickets.tickets.get(ticketId);
    if (!t) return false;
    const row = this.#activeLockRow(t.eventId, t.payerAccountId, nowMs);
    return row !== undefined;
  }

  #applyLock(t: TicketRecord, input: SetTransferLockInput, result: 'LOCKED' | 'UNLOCKED'): TransferLockOutcome {
    if (result === 'UNLOCKED') {
      this.#put({ ...t, fraudLockCaseId: undefined, fraudLockVersion: input.version });
      return { ticketId: t.ticketId, result: 'UNLOCKED' };
    }
    let withdrawnOfferId: string | undefined;
    for (const offer of this.offers.values()) {
      if (offer.ticketId === t.ticketId && offer.status === 'OFFERED') {
        this.offers.set(offer.offerId, { ...offer, status: 'WITHDRAWN', withdrawReason: 'FRAUD_LOCK', decidedAtMs: input.nowMs });
        withdrawnOfferId = offer.offerId;
      }
    }
    this.#put({
      ...t,
      status: t.status === 'TRANSFER_PENDING' ? 'ACTIVE' : t.status,
      transferPending: false,
      fraudLockCaseId: input.caseId,
      fraudLockVersion: input.version,
      version: t.version + 1,
    });
    return {
      ticketId: t.ticketId,
      result: 'LOCKED',
      ...(withdrawnOfferId ? { withdrawnOfferId } : {}),
      ...(t.accountId !== t.payerAccountId ? { holderAccountId: t.accountId } : {}),
    };
  }

  /** 그 티켓의 기한 지난 OFFERED를 EXPIRED로 바꾸고, 남은 요청이 없으면 표시를 끈다(RV-01) */
  #expireTicketOffers(ticketId: string, nowMs: number): void {
    for (const offer of this.offers.values()) {
      if (offer.ticketId !== ticketId || offer.status !== 'OFFERED' || nowMs < offer.expiresAtMs) continue;
      this.offers.set(offer.offerId, { ...offer, status: 'EXPIRED', decidedAtMs: nowMs });
    }
    const t = this.o.tickets.tickets.get(ticketId);
    if (!t || (!t.transferPending && t.status !== 'TRANSFER_PENDING')) return;
    const stillOpen = [...this.offers.values()].some((offer) => offer.ticketId === ticketId && offer.status === 'OFFERED');
    if (!stillOpen) this.#release(t);
  }

  #openOfferRecord(ticketId: string): TransferOfferRecord | undefined {
    for (const o of this.offers.values()) if (o.ticketId === ticketId && o.status === 'OFFERED') return o;
    return undefined;
  }

  #withdrawOpenOffer(ticketId: string, reason: 'EVENT_CANCELLED' | 'FRAUD_LOCK', nowMs: number): string | undefined {
    const offer = this.#openOfferRecord(ticketId);
    if (!offer) return undefined;
    this.offers.set(offer.offerId, { ...offer, status: 'WITHDRAWN', withdrawReason: reason, decidedAtMs: nowMs });
    return offer.offerId;
  }

  #activeLockRow(eventId: string, payerAccountId: string, nowMs: number): LockRow | undefined {
    const start = this.#eventStartsAt(eventId);
    for (const row of this.locks.values()) {
      if (row.eventId !== eventId || row.accountId !== payerAccountId) continue;
      if (lockActiveAt({ locked: row.locked, expiresAtMs: row.expiresAtMs, nowMs, eventStartsAtMs: start })) return row;
    }
    return undefined;
  }

  #eventStartsAt(eventId: string): number | undefined {
    for (const t of this.o.tickets.tickets.values()) if (t.eventId === eventId && t.eventStartsAtMs !== undefined) return t.eventStartsAtMs;
    return undefined;
  }

  /** 양도 표시를 끄고 표를 보낸 사람에게 둔다 */
  #release(t: TicketRecord): void {
    this.#put({ ...t, status: t.status === 'TRANSFER_PENDING' ? 'ACTIVE' : t.status, transferPending: false, version: t.version + 1 });
  }

  #put(t: TicketRecord): void {
    this.o.tickets.tickets.set(t.ticketId, t);
  }
}
