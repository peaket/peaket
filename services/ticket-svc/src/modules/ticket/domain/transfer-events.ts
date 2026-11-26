// 양도 사건의 Outbox 값(docs/streaming.md §5, docs/data.md §4, 계획 docs/review/plans/F-05-11.md §4).
// `trade.tickets` 한 행의 값은 TicketEvent 모양이고, 같은 (offerId, type)은 재생·재시도에도 같은 eventKey를 쓴다(ADR-0052).
import { createHash } from 'node:crypto';

export type TransferEventType = 'TRANSFER_OFFERED' | 'TRANSFER_ACCEPTED' | 'TRANSFER_REJECTED' | 'TRANSFER_WITHDRAWN' | 'TRANSFER_EXPIRED' | 'TICKET_RETURNED';

/** Outbox 한 행(platform OutboxMessage와 같은 모양). 도메인은 플랫폼을 가져오지 않는다(architecture §3.1) */
export interface TransferOutboxMessage {
  readonly topic: string;
  readonly key: string;
  readonly payload: Uint8Array;
  readonly headers?: Record<string, string>;
}

export interface TransferEventCodec {
  encode(message: object): Uint8Array;
}

export const TRANSFER_EVENT_TOPIC = 'trade.tickets';

const jsonCodec: TransferEventCodec = { encode: (message) => new TextEncoder().encode(JSON.stringify(message)) };

/** 사건 하나를 trade.tickets 한 행으로 만든다. 키는 회차 ID, 값은 TicketEvent 모양이다 */
export class TransferOutbox {
  constructor(private readonly d: { readonly codec?: TransferEventCodec } = {}) {}

  messagesFor(e: TransferEventRecord): readonly TransferOutboxMessage[] {
    const codec = this.d.codec ?? jsonCodec;
    return [{ topic: TRANSFER_EVENT_TOPIC, key: e.eventId, payload: codec.encode(ticketEventOf(e)) }];
  }
}

export interface TransferEventRecord {
  readonly type: TransferEventType;
  readonly offerId: string;
  readonly ticketId: string;
  readonly eventId: string;
  readonly orderId: string;
  /** 그 사건 시각의 보유자 */
  readonly accountId: string;
  readonly occurredAtMs: number;
}

/** (offerId, type)의 SHA-256 앞 16바이트를 UUIDv8(버전 8, variant RFC 4122)로 만든다. 소문자다 */
export function transferEventKeyOf(offerId: string, type: TransferEventType): string {
  const h = createHash('sha256').update(`${offerId}:${type}`, 'utf8').digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** docs/api/avro/peaket/trade/TicketEvent.avsc 모양. `occurredAt`은 timestamp-millis(long)다 */
export function ticketEventOf(e: TransferEventRecord): Record<string, unknown> {
  return {
    ticketId: e.ticketId,
    eventId: e.eventId,
    orderId: e.orderId,
    accountId: e.accountId,
    type: e.type,
    scanId: null,
    scanResult: null,
    reason: null,
    gateZone: null,
    direction: null,
    scannedAt: null,
    occurredAt: e.occurredAtMs,
    eventKey: transferEventKeyOf(e.offerId, e.type),
  };
}
