// F-04-8 발생기의 Avro 값 만들기(docs/api/avro, ADR-0357 결정 4, docs/streaming.md §2.6).
// 계약의 고정 스키마 ID(localSchemaIds)와 avsc로 Confluent 형식 바이트를 만든다. 실행 중 레지스트리를 부르지 않는다.
// 값은 결정적이다: 같은 index면 같은 금액·결과가 나와 강제 종료 뒤 합계를 식으로 대조할 수 있다.
import { randomUUID } from 'node:crypto';
import { loadAvro, loadAvsc, loadContracts } from './modules.mjs';

/** 레코드 종류 → 토픽·계약 이름. localSchemaIds의 키는 `<토픽>-<계약 이름>`이다 */
export const SPEC = Object.freeze({
  seat: { topic: 'trade.seats', full: 'peaket.trade.SeatEvent' },
  order: { topic: 'trade.orders', full: 'peaket.trade.OrderEvent' },
  payment: { topic: 'trade.payments', full: 'peaket.trade.PaymentEvent' },
  ticket: { topic: 'trade.tickets', full: 'peaket.trade.TicketEvent' },
  hold: { topic: 'telemetry.purchase', full: 'peaket.telemetry.HoldAttempt' },
  verdict: { topic: 'telemetry.trust-verdicts', full: 'peaket.telemetry.TrustVerdict' },
  queue: { topic: 'telemetry.queue', full: 'peaket.telemetry.QueueEntryRecord' },
});

export const WORKER_TOPICS = Object.freeze([
  'trade.orders',
  'trade.payments',
  'trade.seats',
  'trade.purchase-sessions',
  'trade.tickets',
  'trade.settlements',
  'control.settings',
  'telemetry.queue',
  'telemetry.purchase',
  'telemetry.trust-verdicts',
]);

const FIXED_UUID = '00000000-0000-4000-8000-000000000042';

/** 계약의 필수 칸을 빈 값으로 채운다(union은 null 또는 첫 형, enum은 UNRECOGNIZED가 아닌 첫 기호) */
function blank(type) {
  if (Array.isArray(type)) return type.includes('null') ? null : blank(type[0]);
  if (typeof type === 'string') {
    if (type === 'string') return '';
    if (type === 'long' || type === 'int') return 0;
    if (type === 'boolean') return false;
    if (type === 'double' || type === 'float') return 0;
    if (type === 'bytes') return Buffer.alloc(0);
    return null;
  }
  const o = type;
  if (o.type === 'enum') return o.symbols.find((s) => s !== 'UNRECOGNIZED') ?? 'UNRECOGNIZED';
  if (o.type === 'array') return [];
  if (o.type === 'map') return {};
  if (o.type === 'record') return Object.fromEntries(o.fields.map((f) => [f.name, blank(f.type)]));
  if (o.logicalType === 'uuid') return FIXED_UUID;
  if (o.logicalType === 'timestamp-millis') return 0;
  return blank(o.type);
}

function templateOf(schema) {
  return Object.fromEntries(schema.fields.map((f) => [f.name, blank(f.type)]));
}

/**
 * 인코더를 만든다. build 전에 contracts·avro dist가 있어야 한다.
 * @returns {Promise<{encode:(kind:string, value:Record<string,unknown>)=>{topic:string,value:Buffer}}>}
 */
export async function createEncoder() {
  const [{ avroSchemas, localSchemaIds }, { encodeConfluent }, avsc] = await Promise.all([loadContracts(), loadAvro(), loadAvsc()]);
  const entries = Object.entries(SPEC).map(([kind, s]) => {
    const schema = avroSchemas[s.full];
    const id = localSchemaIds[`${s.topic}-${s.full}`];
    if (!schema) throw new Error(`계약에 ${s.full}가 없다`);
    if (!id) throw new Error(`고정 스키마 ID에 ${s.topic}-${s.full}가 없다`);
    const type = avsc.Type.forSchema(schema);
    return [kind, { ...s, id, type, base: templateOf(schema) }];
  });
  const byKind = Object.fromEntries(entries);
  return {
    encode(kind, value) {
      const s = byKind[kind];
      if (!s) throw new Error(`모르는 레코드 ${kind}`);
      return { topic: s.topic, value: encodeConfluent(s.id, s.type.toBuffer({ ...s.base, ...value })) };
    },
  };
}

/** 발생기 문맥: 회차 ID와 금액·결과의 결정적 규칙 */
export function contextOf(o) {
  return {
    partitions: o.partitions,
    partitionMode: o.partitionMode ?? 'hash',
    hot: o.hot === true,
    hotEventId: o.hotEventId,
    backgroundEventIds: o.backgroundEventIds ?? [],
    fixedJourneyId: o.fixedJourneyId ?? FIXED_UUID,
  };
}

/** 이 레코드가 갈 파티션. 기본은 토픽마다 파티션 0(한 회차 = 한 파티션, 키 쏠림)이다 */
export function partitionOf(ctx, kind, index) {
  if (ctx.hot) {
    if (kind === 'seat' || kind === 'order') return 0;
    const eventIndex = index % Math.max(1, ctx.backgroundEvents ?? ctx.backgroundEventIds?.length ?? 1);
    return 1 + (eventIndex % Math.max(1, ctx.partitions - 1));
  }
  return ctx.partitionMode === 'spread' ? index % ctx.partitions : 0;
}

/** i번째 레코드의 회차 ID. 핫 모드의 배경은 11개 회차를 돌려 쓴다 */
export function eventIdOf(ctx, kind, index) {
  if (!ctx.hot) return ctx.hotEventId;
  if (kind === 'seat' || kind === 'order') return ctx.hotEventId;
  return ctx.backgroundEventIds[index % Math.max(1, ctx.backgroundEventIds.length)] ?? ctx.hotEventId;
}

/**
 * i번째 레코드 값. `at`은 사건 시각(ms)이다.
 * @param {string} kind
 * @param {number} i
 * @param {ReturnType<typeof contextOf>} ctx
 * @param {number} at
 */
export function eventOf(kind, i, ctx, at) {
  const eventId = eventIdOf(ctx, kind, i);
  const eventKey = randomUUID();
  const common = { occurredAt: at, eventKey };
  switch (kind) {
    case 'seat':
      return {
        eventId,
        seatId: `S-${i}`,
        tierId: i % 3 === 0 ? 'R' : 'S',
        sectionId: i % 2 === 0 ? 'A' : 'B',
        type: 'SOLD',
        fencingToken: i,
        sectionVersion: 1,
        seatEpoch: 1,
        holdId: `H-${i}`,
        holdKind: 'FAN',
        purchaseSessionId: `PS-${i}`,
        priorityGrantId: null,
        accountId: `ACC-${i % 10_000}`,
        expiresAt: null,
        holdLimit: null,
        ...common,
      };
    case 'order':
      return {
        eventId,
        orderId: `O-${i}`,
        accountId: `ACC-${i % 10_000}`,
        type: 'CONFIRMED',
        amount: 10_000 + (i % 7) * 1_000,
        refundAmount: null,
        fanNoticeReason: null,
        postponedTo: null,
        refundWindowClosesAt: null,
        seatIds: [],
        purchaseSessionId: `PS-${i}`,
        journeyId: null,
        contactRef: null,
        refMissing: false,
        items: [],
        seatAssignment: 'PICK',
        firstInStage: i % 3 === 0,
        ...common,
      };
    case 'payment':
      return {
        eventId,
        orderId: `O-${i}`,
        pg: 'SIMULATOR',
        type: 'APPROVED',
        amount: 30_000 + (i % 5) * 1_000,
        payMethodCategory: 'CARD',
        paymentMethodRef: null,
        cardBin: null,
        refMissing: false,
        result: 'APPROVED',
        failureCategory: null,
        attemptNo: 1,
        latencyMs: 12,
        eventSeq: i,
        depositDueAt: null,
        orderKind: 'TICKET',
        ...common,
      };
    case 'ticket':
      return {
        ticketId: `T-${i}`,
        eventId,
        orderId: `O-${i}`,
        accountId: `ACC-${i % 10_000}`,
        type: 'ISSUED',
        scanId: null,
        scanResult: null,
        reason: null,
        gateZone: null,
        direction: null,
        scannedAt: null,
        ...common,
      };
    case 'hold':
      return {
        eventId,
        purchaseSessionId: `PS-${i}`,
        journeyId: ctx.fixedJourneyId,
        mode: 'PICK',
        tierId: 'R',
        sectionId: 'A',
        seatIds: [`S-${i}`],
        result: i % 10 < 8 ? 'HELD' : 'CONFLICT',
        autoResult: null,
        heldAt: at,
        firstHeldInSession: i % 2 === 0,
        retryNo: 0,
        latencyMs: 8,
        ...common,
      };
    case 'verdict':
      return {
        eventId,
        queueEntryId: `Q-${i}`,
        pid: `PID-${i % 10_000}`,
        journeyId: ctx.fixedJourneyId,
        deviceRef: null,
        refMissing: false,
        category: 'PASS',
        action: 'ALLOW',
        source: 'REALTIME',
        shadow: false,
        reviewBatch: null,
        appliedVerdict: null,
        pairedEventKey: null,
        ...common,
      };
    case 'queue':
      return {
        eventId,
        queueEntryId: `Q-${i}`,
        journeyId: ctx.fixedJourneyId,
        pid: `PID-${i % 10_000}`,
        number: null,
        entryMode: 'LOBBY',
        enteredAt: at,
        firstEtaSec: null,
        turnAt: null,
        admittedAt: null,
        admissionJti: null,
        removedAt: null,
        removeReason: null,
        verifyRoute: 'DIRECT',
        ...common,
      };
    default:
      throw new Error(`모르는 레코드 ${kind}`);
  }
}

/** 기대 합계를 manifest에 적기 위한 레코드별 합계 */
export function sumOf(kind, value) {
  if (kind === 'order' || kind === 'payment') return Number(value.amount);
  return 0;
}

/** 홀드 결과별 기대 수 */
export function resultOf(kind, value) {
  if (kind === 'hold') return value.result;
  if (kind === 'verdict') return value.category;
  return null;
}
