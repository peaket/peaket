// F-07-12 RV-02: trade.seats의 EventSaleChanged를 읽어 core의 회차 판매 상태 사본을 채우는 소비자 처리기.
// 정본: docs/api/asyncapi.yaml EventSaleChanged, docs/streaming.md §2.6 'core-svc 소비자'·§4 trade.seats, ADR-0122·ADR-0219 결정 5.
// 업무 키는 회차 ID, 중복 제거 키는 eventKey다(판 번호로도 거르므로 다시 받아도 결과가 같다).
// 같은 토픽의 좌석 사건(SeatEvent, type 칸이 있다)은 건너뛴다. 셈 칸(available·held·paying·soldOutTiers·countedAt·avgTicketsPerOrder)은
// core가 쓰지 않으므로, 그 칸만 틀린 값도 판매 상태 사건은 받는다(queue-svc 선례).
// 모양이 틀린 값은 던지지 않고 bad로 돌려주고 handle이 RangeError로 던진다(플랫폼이 5회 뒤 보류).
// 보류 키는 회차 키와 다른 'bad:<회차 ID>'다: 판 번호로 거르므로 차례를 지킬 까닭이 없고, 그 회차의 뒤 정상 판을 함께 막지 않는다.
// Kafka 구독 실행은 src/consumers가 맡는다(이 파일은 Kafka 클라이언트를 싣지 않는다).
import { EventSaleChanged } from '@peaket/contracts/asyncapi';
import type { ConsumedMessage, KeyedHandler } from '@peaket/platform';
import type { EventSaleState } from '../domain/production.js';
import type { EventSaleStateStore, EventSaleStatusEvent } from '../domain/event-sale-state.js';

export const SEATS_TOPIC = 'trade.seats';
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;

/** core가 읽는 칸만. status는 다섯 값 열거다(계약 EventSaleChanged) */
const EventSaleStatus = EventSaleChanged.pick({ eventId: true, status: true, version: true, changedAt: true, eventKey: true });

/** Kafka 값 바이트 → 사건 객체(계약 모양인지는 처리기가 Zod로 본다). 읽지 못하면 던진다 */
export interface EventSaleChangedCodec {
  decode(value: Buffer): unknown;
}

/** JSON 대역(시험·로컬, BAS-030 전까지 purchase-svc가 JSON으로 낸다) */
export const jsonEventSaleChangedCodec: EventSaleChangedCodec = {
  decode: (value) => JSON.parse(value.toString('utf8')) as unknown,
};

/** 읽은 값: 판매 상태 사건, 건너뛸 좌석 사건, 모양이 틀린 값 */
export type EventSaleRecord =
  | { kind: 'sale'; event: EventSaleStatusEvent; eventKey: string }
  | { kind: 'skip'; key: string }
  | { kind: 'bad'; key: string; error: string };

export class CoreEventSaleChangedHandler implements KeyedHandler<EventSaleRecord> {
  constructor(
    private readonly store: EventSaleStateStore,
    private readonly codec: EventSaleChangedCodec = jsonEventSaleChangedCodec,
    private readonly o: { logger?: { info(o: object, msg?: string): void; warn?(o: object, msg?: string): void } } = {},
  ) {}

  decode(m: ConsumedMessage): EventSaleRecord {
    const msgKey = m.key ?? '';
    const bad = (key: string, error: string): EventSaleRecord => ({ kind: 'bad', key, error });
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
    const parsed = EventSaleStatus.safeParse(o);
    if (!parsed.success) return bad(`bad:${id ?? msgKey}`, 'EventSaleChanged 계약 모양이 아니다');
    if (!id) return bad(`bad:${msgKey}`, 'EventSaleChanged의 회차 ID가 키 조각 모양이 아니다');
    return {
      kind: 'sale',
      event: {
        eventId: id,
        status: parsed.data.status as EventSaleState,
        version: parsed.data.version,
        changedAt: parsed.data.changedAt,
      },
      eventKey: parsed.data.eventKey,
    };
  }

  keyOf(r: EventSaleRecord, _m?: ConsumedMessage): string {
    return r.kind === 'sale' ? r.event.eventId : r.key;
  }

  eventKeyOf(r: EventSaleRecord): string | undefined {
    return r.kind === 'sale' ? r.eventKey : undefined;
  }

  /** @throws RangeError 모양이 틀린 값(키 단위 소비자가 5회 뒤 보류한다). 저장소 오류는 그대로 던져 다시 한다 */
  async handle(r: EventSaleRecord, _m?: ConsumedMessage): Promise<void> {
    if (r.kind === 'bad') throw new RangeError(r.error);
    if (r.kind === 'skip') return;
    const result = await this.store.apply(r.event);
    if (result === 'unknown') {
      // core event 행이 아직 없는 회차다. 다음 판이 오면 반영된다. 던지지 않아 파티션을 막지 않는다
      this.o.logger?.warn?.({ kind: 'event-sale-status-unknown', eventId: r.event.eventId }, 'core에 없는 회차의 판매 상태 사건을 건너뛰었다');
      return;
    }
    this.o.logger?.info(
      { kind: 'event-sale-status-applied', eventId: r.event.eventId, status: r.event.status, version: r.event.version, result },
      result === 'applied' ? '회차 판매 상태 사본을 썼다' : '늦게 온 회차 판매 상태 사건을 건너뛰었다',
    );
  }
}
