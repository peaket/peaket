// trade.seats의 EventSaleChanged 처리기(docs/features/queue-admission.md §4 '판매 상태와 Kafka 구독의 첫 구현', asyncapi EventSaleChanged, ADR-0214).
// 플랫폼 키 단위 소비자(KeyedHandler)에 꽂는 면이다. 업무 키는 회차 ID, 중복 제거 키는 eventKey다(판 번호로도 거르므로 다시 받아도 결과가 같다).
// 같은 토픽의 좌석 사건(SeatEvent, type 칸이 있다)은 건너뛴다(키 'skip:' + 메시지 키). 값 해독은 SaleChangedCodec이다: Avro는 BAS-030, 지금은 JSON 대역뿐이다.
// 모양이 틀린 값(type 칸 없는 새 메시지 종류 포함)은 decode가 던지지 않고 bad로 돌려주고 handle이 RangeError로 던진다(던지면 소비자가 업무 키를 메시지 키, 곧 회차 ID로 대신 쓴다).
// 보류 키는 회차 키와 다른 'bad:<회차 ID>'다: 판 번호로 거르므로 차례를 지킬 까닭이 없고, 그 회차의 뒤 정상 판(매진 포함)을 함께 막지 않게 한다(HOT-010 리뷰).
// 회차 ID가 키 조각 모양([A-Za-z0-9_-] 1~64자)이 아니면 메시지 키를 쓴다. 대기열 Redis 일시 장애는 TransientError로 다시 한다.
import { EventSaleChanged } from '@peaket/contracts/asyncapi';
import { type ConsumedMessage, type KeyedHandler, TransientError } from '@peaket/platform';
import { QueueStoreUnavailable } from '../../entry/index.js';
import type { ApplySaleChange } from '../application/apply-sale-change.js';
import type { SaleChangedEvent } from '../domain/sale.js';

export const SEATS_TOPIC = 'trade.seats';
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;

/** Kafka 값 바이트 → 사건 객체(계약 모양인지는 처리기가 Zod로 본다). 읽지 못하면 던진다 */
export interface SaleChangedCodec {
  decode(value: Buffer): unknown;
}

/** JSON 대역(시험·로컬, BAS-030 전까지) */
export const jsonSaleChangedCodec: SaleChangedCodec = {
  decode: (value) => JSON.parse(value.toString('utf8')) as unknown,
};

/** 읽은 값: 판매 상태 사건, 건너뛸 좌석 사건, 모양이 틀린 값 */
export type SaleRecord = { kind: 'sale'; event: SaleChangedEvent } | { kind: 'skip'; key: string } | { kind: 'bad'; key: string; error: string };

export class EventSaleChangedHandler implements KeyedHandler<SaleRecord> {
  constructor(
    private readonly apply: ApplySaleChange,
    private readonly codec: SaleChangedCodec = jsonSaleChangedCodec,
  ) {}

  decode(m: ConsumedMessage): SaleRecord {
    const msgKey = m.key ?? '';
    const bad = (key: string, error: string): SaleRecord => ({ kind: 'bad', key, error });
    if (m.value === null) return bad(`bad:${msgKey}`, 'trade.seats 사건의 값이 없다');
    let v: unknown;
    try {
      v = this.codec.decode(m.value);
    } catch {
      return bad(`bad:${msgKey}`, 'trade.seats 사건의 값을 읽지 못했다');
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return bad(`bad:${msgKey}`, 'trade.seats 사건의 값이 객체가 아니다');
    const o = v as Record<string, unknown>;
    // 좌석 사건(홀드·판매)은 type 칸이 있다. 판매 상태 사건에는 없다
    if ('type' in o) return { kind: 'skip', key: `skip:${msgKey}` };
    const id = typeof o.eventId === 'string' && KEY_PART.test(o.eventId) ? o.eventId : undefined;
    const r = EventSaleChanged.safeParse(o);
    if (!r.success) return bad(`bad:${id ?? msgKey}`, 'EventSaleChanged 계약 모양이 아니다');
    if (!id) return bad(`bad:${msgKey}`, 'EventSaleChanged의 회차 ID가 키 조각 모양이 아니다');
    return { kind: 'sale', event: r.data };
  }

  keyOf(r: SaleRecord, _m?: ConsumedMessage): string {
    return r.kind === 'sale' ? r.event.eventId : r.key;
  }

  eventKeyOf(r: SaleRecord): string | undefined {
    return r.kind === 'sale' ? r.event.eventKey : undefined;
  }

  /** @throws RangeError 모양이 틀린 값(키 단위 소비자가 5회 뒤 보류한다), TransientError 대기열 Redis 일시 장애 */
  async handle(r: SaleRecord, _m?: ConsumedMessage): Promise<void> {
    if (r.kind === 'bad') throw new RangeError(r.error);
    if (r.kind === 'skip') return;
    try {
      await this.apply.run(r.event);
    } catch (err) {
      if (err instanceof QueueStoreUnavailable) throw new TransientError('대기열 Redis를 잠시 쓸 수 없어 판매 상태 사건을 다시 한다', { cause: err });
      throw err;
    }
  }
}
