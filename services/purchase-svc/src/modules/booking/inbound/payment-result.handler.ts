// 결제 결과 소비자(BUILD_ORDER PRF-163, docs/features/payment.md §2 '주문 Saga 소비자의 키 단위 동시 처리'·'결제 결과 반영의 첫 구현', ADR-0142).
// trade.payments를 키 단위 소비자로 읽는다. 업무 키는 주문 ID다(Kafka 키는 회차라 인기 회차가 한 파티션에 몰려도 주문마다 동시에 처리한다).
// 값은 JSON 대역(Avro는 BAS-030)이다. JSON으로 읽어 계약 zod(@peaket/contracts/asyncapi PaymentEvent)로 검사하고 도메인 사건(PaymentResultEvent)으로 옮긴다.
// 모양이 틀린 값은 decode가 던지지 않고 bad로 돌려준다(inventory seat-hold-ledger.handler.ts와 같은 꼴: 던지면 소비자가 업무 키를 메시지 키로 대신 써
// 그 회차의 다른 주문 사건까지 보류한다). handle이 RangeError로 던진다. 주문 ID를 읽을 수 있으면 그 주문 키로 보류한다(같은 주문의 뒤 사건도 함께).
// 같은 결과일 실패(모양이 틀린 사건, PaymentResultHeld, PaymentResultConflict)는 그대로 던져 KeyedPartition이 5회 뒤 held_event로 보류하고,
// purchase DB 연결 실패·시간 초과는 일시 실패라 파티션을 멈춘다. 다시 받은 사건 거르기는 쓰임새의 순번 조건(payment_event_seq)이 한다.
// 서비스에 붙이는 일(소비자 그룹·토픽 구독·조립)은 PRF-164다.
// 주문 종류(추천 적용 2026-11-18, BAT-600 계획, ADR-0299 결정 4): 같은 토픽에 굿즈·티켓 연동 부가 상품 결제(orderKind MERCH, 회차 eventId 없음)도 실린다.
// orderKind가 TICKET이 아닌 사건(MERCH와 모르는 값)은 반영하지 않고 건너뛰며 payment_result_skipped_total{reason}을 올린다(보류하지 않는다).
// 이 칸 전에 낸 사건(칸 없음)은 TICKET이다. eventId null(Avro null 갈래)은 칸 없음으로 읽는다. TICKET인데 eventId가 없으면 모양이 틀린 사건이다.
import { PaymentEvent, type PaymentEventOutput } from '@peaket/contracts/asyncapi';
import type { ConsumedMessage, KeyedHandler } from '@peaket/platform';
import type { ApplyPaymentResult } from '../application/apply-payment-result.js';
import type { PaymentEventSkipReason, PaymentEventSkipSignals, PaymentResultEvent } from '../domain/payment-result.js';

/** 결제 결과 토픽(asyncapi trade.payments) */
export const TRADE_PAYMENTS_TOPIC = 'trade.payments';

/**
 * 읽은 값: 반영할 결제 사건, 반영하지 않을 다른 주문 종류의 사건(skip, key = 주문 ID), 모양이 틀린 레코드(key = 보류할 업무 키, error = 까닭. 사건 값은 싣지 않는다)
 */
export type PaymentResultRecord =
  | { readonly kind: 'event'; readonly event: PaymentResultEvent }
  | { readonly kind: 'skip'; readonly key: string; readonly eventKey?: string; readonly reason: PaymentEventSkipReason }
  | { readonly kind: 'bad'; readonly key: string; readonly error: string };

/** 계약이 아는 주문 종류(asyncapi PaymentEvent.orderKind). 칸이 없으면 TICKET이다 */
const KNOWN_ORDER_KINDS: ReadonlySet<string> = new Set(['TICKET', 'MERCH']);

export class PaymentResultHandler implements KeyedHandler<PaymentResultRecord> {
  /**
   * @param apply 결제 결과 반영 쓰임새
   * @param skips 건너뛴 사건 지표(없으면 세지 않는다)
   */
  constructor(
    private readonly apply: Pick<ApplyPaymentResult, 'execute'>,
    private readonly skips?: PaymentEventSkipSignals,
  ) {}

  /**
   * 값 → 레코드. 던지지 않는다.
   * 값 없음·JSON 아님·객체 아님·zod 검사 실패는 bad: 키는 orderId 칸이 글이면 그 값, 아니면 'bad:' + 메시지 키.
   * orderKind 칸이 있고 TICKET·MERCH가 아니면(UNRECOGNIZED 포함) zod 전에 skip unrecognized, zod를 지난 MERCH는 skip merch(주문 ID 키, ADR-0299 결정 4).
   * TICKET(칸 없음 포함)인데 eventId가 없으면 bad다. eventId null은 칸 없음으로 본다.
   * zod를 지나면 도메인 사건으로 옮긴다(조사용 가명 칸 paymentMethodRef·cardBin은 버린다, refMissing은 계약 기본값 거짓)
   */
  decode(m: ConsumedMessage): PaymentResultRecord {
    const fallback = `bad:${m.key ?? ''}`;
    const bad = (key: string, error: string): PaymentResultRecord => ({ kind: 'bad', key, error });
    if (m.value === null) return bad(fallback, 'PaymentEvent 값이 없다');
    let v: unknown;
    try {
      v = JSON.parse(m.value.toString('utf8'));
    } catch {
      return bad(fallback, 'PaymentEvent 값이 JSON이 아니다');
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return bad(fallback, 'PaymentEvent 값이 객체가 아니다');
    // eventId null(굿즈, Avro null 갈래)은 칸 없음과 같다(계약 zod는 null을 받지 않는다)
    const { eventId: rawEventId, ...rest } = v as Record<string, unknown>;
    const o: Record<string, unknown> = rawEventId === null || rawEventId === undefined ? rest : { ...rest, eventId: rawEventId };
    // 주문 ID를 읽을 수 있으면 그 주문 키로 보류한다(같은 주문의 뒤 사건도 함께, 회차 키로 다른 주문까지 막지 않는다)
    const key = typeof o.orderId === 'string' ? o.orderId : fallback;
    // 모르는 주문 종류는 모양 검사 전에 건너뛴다(새 판의 생산자가 앞서도 보류 표를 채우지 않는다)
    if (o.orderKind !== undefined && !(typeof o.orderKind === 'string' && KNOWN_ORDER_KINDS.has(o.orderKind))) return skip(key, o, 'unrecognized');
    const parsed = PaymentEvent.safeParse(o);
    if (!parsed.success) return bad(key, issuesOf(parsed.error.issues));
    if (parsed.data.orderKind !== 'TICKET') return skip(key, o, 'merch');
    if (parsed.data.eventId === undefined) return bad(key, 'PaymentEvent 모양이 틀렸다(eventId: TICKET 사건에 회차가 없다)');
    return { kind: 'event', event: toEvent(parsed.data, parsed.data.eventId) };
  }

  /** 업무 키: event면 주문 ID, skip·bad면 decode가 정한 키 */
  keyOf(r: PaymentResultRecord, _m?: ConsumedMessage): string {
    return r.kind === 'event' ? r.event.orderId : r.key;
  }

  /** 다시 받은 사건 거르기 키: event면 eventKey, skip이면 읽은 eventKey(글일 때), bad면 undefined */
  eventKeyOf(r: PaymentResultRecord): string | undefined {
    if (r.kind === 'event') return r.event.eventKey;
    return r.kind === 'skip' ? r.eventKey : undefined;
  }

  /** bad면 RangeError(까닭)를 던진다. skip이면 반영하지 않고 지표만 올린다. event면 ApplyPaymentResult.execute(결과는 버린다, 던진 것은 그대로) */
  async handle(r: PaymentResultRecord, _m?: ConsumedMessage): Promise<void> {
    if (r.kind === 'bad') throw new RangeError(r.error);
    if (r.kind === 'skip') {
      this.skips?.skipped(r.reason);
      return;
    }
    await this.apply.execute(r.event);
  }
}

/** 반영하지 않을 사건 레코드(주문 ID 키, eventKey는 글일 때만) */
function skip(key: string, o: Record<string, unknown>, reason: PaymentEventSkipReason): PaymentResultRecord {
  return { kind: 'skip', key, reason, ...(typeof o.eventKey === 'string' ? { eventKey: o.eventKey } : {}) };
}

/** 검사 실패의 까닭: 칸 이름과 문제 종류만 싣는다(값을 싣지 않는다. 보류 행 error 칸에 남는다) */
function issuesOf(issues: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[]): string {
  const parts = issues.slice(0, MAX_ISSUES).map((i) => `${i.path.map(String).join('.') || '(값)'}: ${i.code}`);
  const more = issues.length > MAX_ISSUES ? ` 외 ${issues.length - MAX_ISSUES}개` : '';
  return `PaymentEvent 모양이 틀렸다(${parts.join(', ')}${more})`;
}

/** 까닭에 싣는 문제 수 상한 */
const MAX_ISSUES = 5;

/**
 * 계약 사건 → 도메인 사건. 선택 칸은 있을 때만 옮기고, 조사용 가명 칸(paymentMethodRef·cardBin)과 계약에 없는 칸은 옮기지 않는다
 */
function toEvent(e: PaymentEventOutput, eventId: string): PaymentResultEvent {
  return {
    eventId,
    orderId: e.orderId,
    pg: e.pg,
    type: e.type,
    amount: e.amount,
    ...(e.payMethodCategory !== undefined ? { payMethodCategory: e.payMethodCategory } : {}),
    refMissing: e.refMissing,
    ...(e.result !== undefined ? { result: e.result } : {}),
    ...(e.failureCategory !== undefined ? { failureCategory: e.failureCategory } : {}),
    attemptNo: e.attemptNo,
    ...(e.latencyMs !== undefined ? { latencyMs: e.latencyMs } : {}),
    occurredAt: e.occurredAt,
    eventSeq: e.eventSeq,
    eventKey: e.eventKey,
    ...(e.depositDueAt !== undefined ? { depositDueAt: e.depositDueAt } : {}),
  };
}
