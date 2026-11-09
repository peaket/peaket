// 홀드 원장 적재 소비자(BUILD_ORDER PRF-141, docs/features/seat-hold.md §6 '적재 소비자', ADR-0142). trade.seats를 키 단위 소비자로 읽는다.
// 업무 키는 '회차 ID:좌석 ID'다(좌석 ID는 공연장 좌석이라 같은 공연장의 다른 회차가 같은 값을 쓴다, 코드 리뷰 2026-11-04). 판매 사건과 EventSaleChanged는 건너뛴다(키 'skip:' + 메시지 키).
// 값은 JSON 대역(Avro는 BAS-030)이다. 모양이 틀린 값은 decode가 던지지 않고 bad로 돌려준다(던지면 소비자가 업무 키를 회차 키로 대신 써 그 회차의 다른 사건까지 보류한다). handle이 RangeError로 던진다.
// 같은 결과일 실패(모양이 틀린 사건, 파티션 없는 회차)는 그대로 던져 KeyedPartition이 5회 뒤 held_event로 보류하고, DB 연결 실패·시간 초과는 일시 실패다.
import type { ConsumedMessage, KeyedHandler } from '@peaket/platform';
import type { SeatHoldLedger } from '../domain/ports.js';
import { toLedgerHoldEvent, type LedgerHoldEvent } from '../domain/seat-event.js';

/** 읽은 값: 원장에 쓸 홀드 사건이거나 건너뛸 레코드 */
export type LedgerRecord = { kind: 'hold'; event: LedgerHoldEvent } | { kind: 'skip'; key: string } | { kind: 'bad'; key: string; error: string };

export class SeatHoldLedgerHandler implements KeyedHandler<LedgerRecord> {
  constructor(private readonly ledger: SeatHoldLedger) {}

  decode(m: ConsumedMessage): LedgerRecord {
    const msgKey = m.key ?? '';
    const bad = (key: string, error: string): LedgerRecord => ({ kind: 'bad', key, error });
    if (m.value === null) return bad(`bad:${msgKey}`, 'SeatEvent 값이 없다');
    let v: unknown;
    try {
      v = JSON.parse(m.value.toString('utf8'));
    } catch {
      return bad(`bad:${msgKey}`, 'SeatEvent 값이 JSON이 아니다');
    }
    if (typeof v !== 'object' || v === null) return bad(`bad:${msgKey}`, 'SeatEvent 값이 객체가 아니다');
    const o = v as Record<string, unknown>;
    const skip: LedgerRecord = { kind: 'skip', key: `skip:${msgKey}` };
    // EventSaleChanged(같은 토픽, type 칸이 없다)와 판매 사건은 건너뛴다
    if (typeof o.type !== 'string') return skip;
    try {
      const event = toLedgerHoldEvent(o);
      return event ? { kind: 'hold', event } : skip;
    } catch (err) {
      // 회차·좌석을 읽을 수 있으면 그 좌석의 키로 보류한다(같은 좌석의 뒤 사건도 함께 보류된다)
      const key = typeof o.eventId === 'string' && typeof o.seatId === 'string' ? `${o.eventId}:${o.seatId}` : `bad:${msgKey}`;
      return bad(key, err instanceof Error ? err.message : String(err));
    }
  }

  keyOf(r: LedgerRecord, _m?: ConsumedMessage): string {
    return r.kind === 'hold' ? `${r.event.eventId}:${r.event.seatId}` : r.key;
  }

  eventKeyOf(r: LedgerRecord): string | undefined {
    return r.kind === 'hold' ? r.event.eventKey : undefined;
  }

  async handle(r: LedgerRecord, _m?: ConsumedMessage): Promise<void> {
    if (r.kind === 'bad') throw new RangeError(r.error);
    if (r.kind === 'hold') await this.ledger.apply(r.event);
  }
}
