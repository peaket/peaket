// 사건 → 관제 실시간 표 원시 행(docs/streaming.md §4.2 표, OPS-160, F-04-1). 집계하지 않고 거르고 옮기기만 한다.
// - 사람 식별값(pid·계정·대기 참여·구매 세션·주문·티켓 ID)은 싣지 않는다(§4.2). '처음' 표시는 생산자가 실은 값을 그대로 옮긴다
// - 모르는 열거 기호(UNRECOGNIZED)는 '모르는 상태'로 싣는다(§2.6). 거르기 목록에 없으니 버리지 않는다
// - 점검 회차 목록에 든 회차의 사건은 싣지 않는다(§4.2, analytics §3.1, Q-T50)
// - 같은 토픽에 실리는 다른 레코드(EventSaleChanged·QueueEntryRecord 등)는 건너뛴다(ADR-0122)
import type { BatchRecord } from '@peaket/platform';

export const RT_TABLES = ['rt.sale_event', 'rt.queue_aggregate', 'rt.hold_attempt', 'rt.verdict', 'rt.pulse'] as const;
export type RtTable = (typeof RT_TABLES)[number];

/** 읽은 레코드(실행기가 넘기는 값). record는 레코드 이름의 마지막 조각(SeatEvent 등), key는 Kafka 키(UTF-8) */
export interface DecodedEvent {
  readonly record: string;
  readonly key: string | null;
  readonly value: Readonly<Record<string, unknown>>;
}

export type RtRow = Record<string, string | number | boolean>;

export interface RtRowOut {
  readonly table: RtTable;
  readonly row: RtRow;
}

const UNRECOGNIZED = 'UNRECOGNIZED';
/** §4.2 거르기: 싣는 종류(모르는 기호도 싣는다) */
const SEAT_TYPES = new Set(['PENDING', 'SOLD', 'RETURNED', UNRECOGNIZED]);
const ORDER_TYPES = new Set(['ACCEPTED', 'APPROVED', 'CONFIRMED', 'DEPOSIT_REVERSED', UNRECOGNIZED]);
const PAYMENT_TYPES = new Set(['APPROVED', 'DEPOSIT_REVERSED', UNRECOGNIZED]);
const TICKET_TYPES = new Set(['ISSUED', 'VOIDED', UNRECOGNIZED]);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const bool = (v: unknown): boolean => v === true;
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : typeof v === 'bigint' ? Number(v) : 0);

/** 사건 시각(timestamp-millis: avsc가 수나 Date로 준다) → ISO 글(ClickHouse best_effort로 읽는다) */
export function isoOf(v: unknown): string | undefined {
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number.NaN;
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** 레코드 전체 이름(peaket.trade.SeatEvent)의 마지막 조각 */
export const recordShortName = (fullName: string): string => fullName.slice(fullName.lastIndexOf('.') + 1);

/**
 * 레코드 하나를 원시 행으로 바꾼다. 싣지 않는 레코드는 빈 목록이다.
 * probeEvents: 배포 설정의 점검 회차 목록(소문자 비교)
 */
export function rowsOf(rec: BatchRecord<DecodedEvent>, probeEvents: ReadonlySet<string>): RtRowOut[] {
  const { record, key, value: v } = rec.value;
  const eventId = str(v.eventId);
  if (record !== 'PipelinePulse') {
    if (!eventId || probeEvents.has(eventId.toLowerCase())) return [];
  }
  const occurredAt = isoOf(v.occurredAt);
  const eventKey = str(v.eventKey);
  const sale = (source: 'SEAT' | 'ORDER' | 'PAYMENT' | 'TICKET', extra: Partial<RtRow>): RtRowOut[] => {
    if (!occurredAt || !eventKey) return [];
    return [
      {
        table: 'rt.sale_event',
        row: {
          event_id: eventId,
          event_key: eventKey,
          source,
          type: str(v.type),
          seat_id: '',
          tier_id: '',
          section_id: '',
          amount: 0,
          first_in_stage: false,
          occurred_at: occurredAt,
          kafka_partition: rec.partition,
          kafka_offset: rec.offset,
          ...extra,
        } as RtRow,
      },
    ];
  };
  switch (record) {
    case 'SeatEvent':
      if (!SEAT_TYPES.has(str(v.type))) return [];
      return sale('SEAT', { seat_id: str(v.seatId), tier_id: str(v.tierId), section_id: str(v.sectionId) });
    case 'OrderEvent':
      if (!ORDER_TYPES.has(str(v.type))) return [];
      return sale('ORDER', { first_in_stage: bool(v.firstInStage) });
    case 'PaymentEvent':
      // 상품(MERCH) 결제는 회차 판매 금액이 아니다(추천 적용 2026-11-23, F-04-1 계획). 회차 ID가 없는 결제도 싣지 않는다
      if (!PAYMENT_TYPES.has(str(v.type)) || str(v.orderKind) === 'MERCH') return [];
      return sale('PAYMENT', { amount: int(v.amount) });
    case 'TicketEvent':
      if (!TICKET_TYPES.has(str(v.type))) return [];
      return sale('TICKET', {});
    case 'QueueAggregate': {
      const second = isoOf(v.second);
      if (!second || !eventKey) return [];
      // 파드는 메시지 키 '회차:파드'의 ':' 뒤(계약에 pod 필드가 없다, ADR-0146 결정 8)
      const pod = key && key.includes(':') ? key.slice(key.indexOf(':') + 1) : '';
      return [{ table: 'rt.queue_aggregate', row: { event_id: eventId, event_key: eventKey, pod, second, entries: int(v.entries), admissions: int(v.admissions), removed: int(v.removed) } }];
    }
    case 'HoldAttempt':
      if (!occurredAt || !eventKey) return [];
      return [{ table: 'rt.hold_attempt', row: { event_id: eventId, event_key: eventKey, result: str(v.result), tier_id: str(v.tierId), first_held_in_session: bool(v.firstHeldInSession), occurred_at: occurredAt } }];
    case 'TrustVerdict':
      if (v.shadow === true || !occurredAt || !eventKey) return [];
      return [{ table: 'rt.verdict', row: { event_id: eventId, event_key: eventKey, category: str(v.category), occurred_at: occurredAt } }];
    case 'PipelinePulse': {
      const producedAt = isoOf(v.producedAt);
      if (!producedAt || str(v.kind) !== 'PULSE') return [];
      return [{ table: 'rt.pulse', row: { topic: str(v.topic), kafka_partition: int(v.partition), produced_at: producedAt } }];
    }
    default:
      return [];
  }
}

/** 묶음의 레코드를 표마다 모은다(표 차례는 RT_TABLES) */
export function groupRows(records: readonly BatchRecord<DecodedEvent>[], probeEvents: ReadonlySet<string>): Map<RtTable, RtRow[]> {
  const out = new Map<RtTable, RtRow[]>();
  for (const r of records) {
    for (const { table, row } of rowsOf(r, probeEvents)) {
      const list = out.get(table) ?? [];
      list.push(row);
      out.set(table, list);
    }
  }
  return new Map(RT_TABLES.filter((t) => out.has(t)).map((t) => [t, out.get(t)!]));
}
