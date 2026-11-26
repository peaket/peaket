// 계좌 입력 요청 첫 발송·재발송 훑기(F-07-15 I-02, notify §9). 계좌 대기 취소·배상 행을 읽어
// count+1·next_at·Outbox 한 건을 한 트랜잭션에 쓴다(claim). 같은 회차는 claim 0행이라 두 번 나가지 않는다.
import type { EventRefundOutboxMessage } from '../domain/event-refund-ports.js';
import { accountNoticeKey, nextAccountNoticeAt, type AccountNoticeCalendar, type AccountNoticeRow, type AccountNoticeSource } from '../domain/account-request.js';

export type { AccountNoticeRow, AccountNoticeSource } from '../domain/account-request.js';

export interface AccountNoticeCodec {
  encode(message: object): Uint8Array;
}
const jsonCodec: AccountNoticeCodec = { encode: (m) => Buffer.from(JSON.stringify(m), 'utf8') };

export interface AccountRequestNoticesDeps {
  readonly refunds: AccountNoticeSource;
  readonly compensations: AccountNoticeSource;
  readonly calendar: AccountNoticeCalendar;
  readonly clock: { now(): number };
  readonly codec?: AccountNoticeCodec;
}

export class AccountRequestNotices {
  constructor(private readonly d: AccountRequestNoticesDeps) {}

  async run(limit = 50): Promise<{ sent: number; skipped: number }> {
    const nowMs = this.d.clock.now();
    let sent = 0;
    let skipped = 0;
    for (const [kind, source] of [
      ['REFUND', this.d.refunds],
      ['COMPENSATION', this.d.compensations],
    ] as const) {
      let rows: readonly AccountNoticeRow[];
      try {
        rows = await source.listDue(nowMs, limit);
      } catch {
        skipped++;
        continue;
      }
      for (const row of rows) {
        if (row.nextAtMs !== undefined && row.nextAtMs > nowMs) continue;
        const nextAtMs = nextAccountNoticeAt({ requiredAtMs: row.requiredAtMs, sentCount: row.sentCount + 1, calendar: this.d.calendar });
        const outbox = this.#message(kind, row, nextAtMs, nowMs);
        try {
          const claimed = await source.claim({ id: row.id, expectedCount: row.sentCount, nextAtMs, outbox, nowMs });
          if (claimed) sent++;
          else skipped++;
        } catch {
          skipped++;
        }
      }
    }
    return { sent, skipped };
  }

  #message(kind: 'REFUND' | 'COMPENSATION', row: AccountNoticeRow, nextAtMs: number, nowMs: number): EventRefundOutboxMessage {
    const sequence = row.sentCount + 1;
    const payload = {
      eventId: row.eventId,
      orderId: row.orderId,
      accountId: row.accountId,
      type: kind === 'REFUND' ? 'REFUND_ACCOUNT_REQUESTED' : 'COMPENSATION_ACCOUNT_REQUESTED',
      amount: row.amount,
      refundAmount: row.amount,
      ...(kind === 'REFUND' ? { cancellationId: row.id } : { compensationId: row.id }),
      seatIds: [] as string[],
      refMissing: false,
      items: [] as { seatId: string; tierId: string; sectionId: string; price: number }[],
      seatAssignment: 'PICK',
      firstInStage: false,
      occurredAt: new Date(nowMs).toISOString(),
      eventKey: accountNoticeKey(kind, row.id, sequence),
    };
    return { topic: 'trade.orders', key: row.eventId, payload: (this.d.codec ?? jsonCodec).encode(payload) };
  }
}
