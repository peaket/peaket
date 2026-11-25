// 양도 사건의 transfer_notice·Outbox 쓰기(업무와 같은 트랜잭션의 마지막 문장, docs/features/notify.md §4.8, docs/data.md §4).
// DrizzleTransferStore와 DrizzleTicketStore(회차 취소)가 같은 규칙을 쓴다. 알림 행을 먼저, Outbox를 마지막에 넣는다.
import { systemClock, writeOutbox, type Clock, type DbTransaction } from '@peaket/platform';
import { noticesOf, type TransferNoticeType } from '../../domain/transfer-notice.js';
import type { TransferEventType } from '../../domain/transfer-events.js';
import type { PublicWithdrawReason } from '../../domain/transfer.js';
import type { TransferOutbox } from '../../domain/transfer-events.js';
import { transferNotice } from './schema.js';

export interface TransferEffectInput {
  readonly ticket: { readonly ticketId: string; readonly eventId: string; readonly orderId: string };
  readonly offerId: string;
  readonly type: TransferEventType;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly accountId: string;
  readonly reason?: PublicWithdrawReason;
  readonly weakReauth?: boolean;
  readonly nowMs: number;
}

/**
 * 한 사건의 알림 행과 Outbox 한 행을 같은 트랜잭션에 넣는다. Outbox가 트랜잭션의 마지막 문장이 되도록
 * 이 함수를 업무 변경 뒤에 부른다. 중복 키(type, offer_id, account_id)는 재전송을 한 행으로 막는다.
 */
export async function writeTransferEffects(tx: DbTransaction, outbox: TransferOutbox, clock: Clock | undefined, e: TransferEffectInput): Promise<void> {
  const rows = noticesOf({
    type: e.type as TransferNoticeType,
    offerId: e.offerId,
    ticketId: e.ticket.ticketId,
    eventId: e.ticket.eventId,
    fromAccountId: e.fromAccountId,
    toAccountId: e.toAccountId,
    ...(e.reason === undefined ? {} : { reason: e.reason }),
    nowMs: e.nowMs,
    ...(e.weakReauth === true ? { weakReauth: true } : {}),
  });
  if (rows.length > 0) {
    await tx
      .insert(transferNotice)
      .values(
        rows.map((n) => ({
          id: n.noticeId,
          type: n.type,
          party: n.party,
          offerId: n.offerId,
          ticketId: n.ticketId,
          eventId: n.eventId,
          accountId: n.accountId,
          reason: n.reason ?? null,
          createdAt: new Date(n.createdAtMs),
          attempts: 0,
          nextAttemptAt: new Date(n.createdAtMs),
        })),
      )
      .onConflictDoNothing();
  }
  await writeOutbox(
    tx,
    clock ?? systemClock,
    outbox.messagesFor({
      type: e.type,
      offerId: e.offerId,
      ticketId: e.ticket.ticketId,
      eventId: e.ticket.eventId,
      orderId: e.ticket.orderId,
      accountId: e.accountId,
      occurredAtMs: e.nowMs,
    }),
  );
}
