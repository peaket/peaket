// trade.purchase-sessions 사건 처리기(BUILD_ORDER PRF-136, docs/features/queue-admission.md §6 '구매 세션 사건', ADR-0183 결정 11, asyncapi PurchaseSessionStarted·PurchaseSessionEnded).
// 플랫폼 키 단위 소비자(KeyedHandler)에 꽂는 면이다. 업무 키는 입장 토큰 jti(한 자리의 시작·종료 사건이 차례를 지키게), 중복 제거 키는 eventKey다.
// 값 해독은 PurchaseSessionCodec이다: Avro(Confluent 형식)는 BAS-030, Kafka 구독 실행은 HOT-010이 만든다. 지금은 JSON 대역(jsonPurchaseSessionCodec)뿐이다.
// 두 종류가 한 토픽에 있어 값의 칸으로 가른다: maxStayUntil·startedAt이 있으면 시작, reason·endedAt이 있으면 종료이고, 둘 다 없거나 섞이면 읽지 못한 값이다.
// 회차 ID가 키 조각 모양이 아니면 읽지 못한 값이다(Redis 키의 해시 태그를 깨는 값이 키로 가지 않게). 대기열 Redis 일시 장애(QueueStoreUnavailable)는 TransientError로 바꿔 던진다:
// 키 단위 소비자가 그 사건을 보류하지 않고 backoff로 다시 한다(그 밖의 오류는 그대로 던져 보류한다, PRF-136 리뷰).
import { PurchaseSessionEnded, type PurchaseSessionEndedOutput, PurchaseSessionStarted, type PurchaseSessionStartedOutput } from '@peaket/contracts/asyncapi';
import { type ConsumedMessage, type KeyedHandler, TransientError } from '@peaket/platform';
import { QueueStoreUnavailable } from '../../entry/index.js';
import type { PurchaseSessionSlots } from '../application/purchase-session-slots.js';

/** 회차 ID는 대기열 Redis 키의 해시 태그(q:{event:E}:…)에 들어간다. 컨트롤러의 KEY_PART와 같은 모양만 받는다 */
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type PurchaseSessionEvent = { kind: 'STARTED'; value: PurchaseSessionStartedOutput } | { kind: 'ENDED'; value: PurchaseSessionEndedOutput };

/** Kafka 값 바이트 → 사건 객체(계약 모양인지는 처리기가 Zod로 본다) */
export interface PurchaseSessionCodec {
  decode(value: Buffer): unknown;
}

/** JSON 대역(시험·로컬). 운영의 Avro 해독기는 BAS-030 */
export const jsonPurchaseSessionCodec: PurchaseSessionCodec = {
  decode: (value) => JSON.parse(value.toString('utf8')) as unknown,
};

export class PurchaseSessionHandler implements KeyedHandler<PurchaseSessionEvent> {
  constructor(
    private readonly slots: PurchaseSessionSlots,
    private readonly codec: PurchaseSessionCodec = jsonPurchaseSessionCodec,
  ) {}

  /** @throws Error 값이 없거나 객체가 아니거나 두 종류 어느 쪽도 아니거나 계약 모양(Zod)이 아니거나 회차 ID가 키 조각 모양이 아님 → 키 단위 소비자가 그 키를 보류한다 */
  decode(m: ConsumedMessage): PurchaseSessionEvent {
    if (m.value === null) throw new Error('구매 세션 사건의 값이 없다');
    const raw = this.codec.decode(m.value);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('구매 세션 사건의 값이 객체가 아니다');
    const o = raw as Record<string, unknown>;
    const isStarted = 'maxStayUntil' in o || 'startedAt' in o;
    const isEnded = 'reason' in o || 'endedAt' in o;
    if (isStarted === isEnded) throw new Error('구매 세션 사건의 종류를 알 수 없다(시작과 종료의 칸이 없거나 섞였다)');
    const e: PurchaseSessionEvent = isStarted ? { kind: 'STARTED', value: PurchaseSessionStarted.parse(o) } : { kind: 'ENDED', value: PurchaseSessionEnded.parse(o) };
    if (!EVENT_ID.test(e.value.eventId)) throw new Error('구매 세션 사건의 회차 ID가 키 조각 모양이 아니다');
    return e;
  }

  keyOf(e: PurchaseSessionEvent, _m?: ConsumedMessage): string {
    return e.value.admissionJti;
  }

  eventKeyOf(e: PurchaseSessionEvent): string {
    return e.value.eventKey;
  }

  /** @throws TransientError 대기열 Redis 일시 장애(원인은 cause). 그 밖의 저장소 오류는 그대로 */
  async handle(e: PurchaseSessionEvent, _m?: ConsumedMessage): Promise<void> {
    try {
      if (e.kind === 'STARTED') await this.slots.started(e.value);
      else await this.slots.ended(e.value);
    } catch (err) {
      if (err instanceof QueueStoreUnavailable) throw new TransientError('대기열 Redis를 잠시 쓸 수 없어 구매 세션 사건을 다시 한다', { cause: err });
      throw err;
    }
  }
}
