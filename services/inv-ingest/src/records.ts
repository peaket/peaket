// 조사 저장소 inv 적재 규칙(docs/streaming.md §6.4, docs/data.md '부정 예매 사후 조사의 표', LCH-240, F-04-10).
// - 원천 열 개를 표 넷에 나눈다. 가명 처리는 하지 않는다(조사 갈래는 실명 계정·주문·결제·접속 기록으로 조치하는 갈래다, ADR-0171 결정 2).
// - 조사용 가명 값(invRef)은 생산자가 만든 문자열을 그대로 싣고, 생산자가 계산하지 못했으면(refMissing) inv_link 행을 만들지 않는다.
// - 사건 열에는 공연일이 없어 retain_until은 배포 값(PEAKET_INV_EVENT_DATES)으로 정한다. 모르는 회차는 싣지 않는다.
// - 정수 범위·IP 형·열거 값은 여기서 확인하고 어긋난 사건만 버린다(ASVS 1.4.2·1.5.2·2.2.1).
import { isIP } from 'node:net';
import type { InvestigationRefs } from './refs.js';

export const INV_TABLES = ['inv.inv_request', 'inv.inv_step', 'inv.inv_behavior', 'inv.inv_link'] as const;
export type InvTable = (typeof INV_TABLES)[number];

/** 원천 이름(계약 레코드 이름 마지막 조각, 투자 요청은 JSON이라 따로 이름을 쓴다) */
export const RECORD_TARGET: Readonly<Record<string, InvTable | 'progress'>> = {
  InvestigationRequest: 'inv.inv_request',
  QueueEntryRecord: 'inv.inv_step',
  PurchaseSessionStarted: 'progress',
  HoldAttempt: 'inv.inv_step',
  SeatEvent: 'inv.inv_step',
  OrderEvent: 'inv.inv_step',
  PaymentEvent: 'inv.inv_step',
  TicketEvent: 'inv.inv_step',
  BehaviorSignal: 'inv.inv_behavior',
  TrustVerdict: 'inv.inv_link',
};

/** 싣지 않는 레코드(§6.4: 심장 박동·1초 집계) */
export const SKIPPED_RECORDS = new Set(['PipelinePulse', 'QueueAggregate']);

export const GATEWAYS = ['GW_QUEUE', 'GW_FAN'] as const;
export const ROUTE_KINDS = [
  'LOBBY_ENTRY',
  'PREVERIFY',
  'QUEUE_ENTRY',
  'ADMISSION',
  'VERIFICATION',
  'SEATMAP_SNAPSHOT',
  'HOLD',
  'HOLD_RELEASE',
  'HOLD_EXTENSION',
  'ORDER',
  'PAYMENT_ATTEMPT',
  'PAYMENT_ACCEPTANCE',
  'TRANSFER',
  'TICKET_RETURN',
] as const;
export const NET_CLASSES = ['HOSTING', 'PROXY', 'OTHER'] as const;
export type NetClass = (typeof NET_CLASSES)[number];
export const SCREENS = ['LOBBY', 'EVENT_DETAIL', 'SEAT', 'PAYMENT'] as const;

export interface AsnTable {
  version: number;
  hosting: number[];
  proxy: number[];
}

export interface InvContext {
  /** 적재 시각(밀리초). 한 묶음은 같은 값을 쓴다 */
  ingestedAt: number;
  /** 회차 ID → 공연일(YYYY-MM-DD) */
  eventDates: ReadonlyMap<string, string>;
  asnTable: AsnTable;
  /** 계정 연결 값(identity-svc BatchGetInvestigationRefs). 없으면 링크를 더하지 않는다 */
  refs?: ReadonlyMap<string, InvestigationRefs>;
}

export interface InvRow {
  table: InvTable;
  row: Record<string, unknown>;
}

export type Outcome = 'LOADED' | 'SKIPPED' | 'REJECTED';

export interface MappedEvent {
  rows: InvRow[];
  outcome: Outcome;
  reason?: string;
}

const U64_MAX = 18_446_744_073_709_551_615n;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const UINT32_MAX = 4_294_967_295;
const MAX_LABELS = 32;
const MAX_STRING = 512;

export const stepOf = (eventKey: string, step: string) => `${eventKey}:${step}`;

/** 판 칸: UInt64 최댓값 − 적재 시각(밀리초). 합칠 때 가장 이른 행이 남는다 */
export const ingestRankOf = (ingestedAt: number): string => String(U64_MAX - BigInt(Math.trunc(ingestedAt)));

/** 공연일 + 30일(UTC 자정 기준). 모양이 틀리면 null */
export function retainUntilOf(performanceDate: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(performanceDate);
  if (!m) return null;
  const t = Date.parse(`${performanceDate}T00:00:00.000Z`);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3])) return null;
  return new Date(t + 30 * 24 * 60 * 60 * 1000).toISOString();
}

export function asnClassOf(asn: number, table: AsnTable): NetClass {
  if (!Number.isInteger(asn) || asn <= 0) return 'OTHER';
  if (table.hosting.includes(asn)) return 'HOSTING';
  if (table.proxy.includes(asn)) return 'PROXY';
  return 'OTHER';
}

/** 원문 IP를 ClickHouse IPv6 형으로. IPv4는 매핑 주소로 바꾼다. 형식이 틀리면 null */
export function ipv6Of(ip: unknown): string | null {
  if (typeof ip !== 'string') return null;
  const kind = isIP(ip);
  if (kind === 4) return `::ffff:${ip}`;
  if (kind === 6) return ip.toLowerCase();
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
const msOf = (v: unknown): number | undefined => {
  const n = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};
const iso = (ms: number) => new Date(ms).toISOString();
const str = (v: unknown, max = MAX_STRING): string => (typeof v === 'string' && v.length <= max ? v : '');
const int = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number.NaN;
  return Number.isInteger(n) ? n : undefined;
};
const bool01 = (v: unknown): number => (v === true ? 1 : 0);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOf = (v: unknown): string => (typeof v === 'string' && uuid.test(v) ? v.toLowerCase() : '');
const arrayOfStrings = (v: unknown, max = 64): string[] | null => {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  if (!v.every((x) => typeof x === 'string' && x.length <= 256)) return null;
  return v as string[];
};

/** 같은 표·같은 행을 가리키는 정렬 키(ReplacingMergeTree가 지우는 단위) */
export function invRowKey(table: InvTable, row: Record<string, unknown>): string {
  const s = (k: string) => String(row[k] ?? '');
  if (table === 'inv.inv_request') return `${s('event_id')}|${s('request_id')}`;
  if (table === 'inv.inv_step') return `${s('event_id')}|${s('source_key')}`;
  if (table === 'inv.inv_behavior') return `${s('event_id')}|${s('event_key')}`;
  return `${s('event_id')}|${s('kind')}|${s('value')}|${s('account_id')}|${s('pid')}|${s('journey_id')}`;
}

interface Base {
  eventId: string;
  ts: number;
  ingestedAt: number;
  retainUntil: string;
  rank: string;
}

const baseOf = (eventId: string, ts: number, ctx: InvContext, retainUntil: string): Base => ({
  eventId,
  ts,
  ingestedAt: ctx.ingestedAt,
  retainUntil,
  rank: ingestRankOf(ctx.ingestedAt),
});

const linkOf = (b: Base, kind: string, value: string, a: string, p: string, j: string, source: string): InvRow => ({
  table: 'inv.inv_link',
  row: {
    event_id: b.eventId,
    kind,
    value,
    account_id: a,
    pid: p,
    journey_id: j,
    source,
    first_seen_at: iso(b.ts),
    last_seen_at: iso(b.ts),
    ingested_at: iso(b.ingestedAt),
    retain_until: b.retainUntil,
    ingest_rank: b.rank,
  },
});

const stepRow = (b: Base, o: Record<string, unknown>): InvRow => ({
  table: 'inv.inv_step',
  row: {
    event_id: b.eventId,
    ts: iso(b.ts),
    ingested_at: iso(b.ingestedAt),
    retain_until: b.retainUntil,
    ingest_rank: b.rank,
    journey_id: '',
    step: '',
    pid: '',
    account_id: '',
    queue_entry_id: '',
    purchase_session_id: '',
    order_id: '',
    ticket_id: '',
    seat_ids: [],
    held_at: '',
    result: '',
    verify_route: '',
    payment_method_ref: '',
    card_bin: '',
    ref_missing: 0,
    ...o,
  },
});

const orderStep = (type: string): string | null => (type === 'CREATED' ? 'ORDER' : type === 'CONFIRMED' ? 'SALE' : type === 'REFUNDED' || type === 'PARTIALLY_REFUNDED' ? 'CANCEL' : null);
const ticketStep = (type: string): string | null => {
  if (['TRANSFER_OFFERED', 'TRANSFER_ACCEPTED', 'TRANSFER_REJECTED', 'TRANSFER_WITHDRAWN', 'TRANSFER_EXPIRED', 'TRANSFERRED', 'TICKET_RETURNED', 'TICKET_RECLAIMED'].includes(type)) return 'TRANSFER';
  if (['ENTRY_SCANNED', 'SCAN_FLAGGED', 'SCAN_FLAG_RESOLVED', 'ENTRY_CLOSED'].includes(type)) return 'ENTRY_SCAN';
  if (['CANCEL_REQUESTED', 'REFUNDED', 'VOIDED'].includes(type)) return 'CANCEL';
  return null;
};

const reject = (reason: string): MappedEvent => ({ rows: [], outcome: 'REJECTED', reason });
const skip = (reason: string): MappedEvent => ({ rows: [], outcome: 'SKIPPED', reason });

/** 계정 연결 값을 더한다(같은 계정·여정의 CONTACT·DEVICE). 계산하지 못한 값은 빼고 refMissing만 남긴다 */
function refLinks(b: Base, accountId: string, journeyId: string, ctx: InvContext, out: InvRow[]): void {
  if (!accountId) return;
  const refs = ctx.refs?.get(accountId);
  if (!refs) return;
  for (const v of refs.contactRefs) if (v) out.push(linkOf(b, 'CONTACT', v, accountId, '', journeyId, 'identity'));
  for (const v of refs.deviceRefs) if (v) out.push(linkOf(b, 'DEVICE', v, accountId, '', journeyId, 'identity'));
}

/** 계정 연결 값을 물을 계정(묶음 하나의 계정 목록) */
export function accountIdsOf(record: string, value: Readonly<Record<string, unknown>>): string[] {
  const id = str(value.accountId, 128);
  if (!id) return [];
  if (record === 'InvestigationRequest' || record === 'OrderEvent') return [id];
  return [];
}

export function mapEvent(record: string, rawValue: Readonly<Record<string, unknown>>, ctx: InvContext): MappedEvent {
  if (SKIPPED_RECORDS.has(record)) return skip(record);
  if (!RECORD_TARGET[record]) return skip(`UNLOADED_RECORD:${record}`);
  const v = rawValue as Record<string, unknown>;
  if (record === 'InvestigationRequest') return mapRequest(v, ctx);
  const eventId = str(v.eventId, 64);
  if (!eventId) return skip('NO_EVENT');
  const perf = ctx.eventDates.get(eventId);
  const retain = perf ? retainUntilOf(perf) : null;
  if (!retain) return reject('EVENT_DATE_MISSING');

  if (record === 'QueueEntryRecord') {
    const enteredAt = msOf(v.enteredAt);
    const eventKey = uuidOf(v.eventKey);
    if (enteredAt === undefined || !eventKey) return reject('MISSING_FIELD');
    const journey = uuidOf(v.journeyId);
    const pid = str(v.pid, 128);
    const qe = str(v.queueEntryId, 128);
    const verify = (ROUTE_KINDS.includes(v.verifyRoute as never) || ['DIRECT', 'CHALLENGE_PASSED', 'CHALLENGE_FAILED', 'BLOCKED'].includes(String(v.verifyRoute))) ? String(v.verifyRoute) : '';
    const b = baseOf(eventId, enteredAt, ctx, retain);
    const out: InvRow[] = [stepRow(b, { source_key: stepOf(eventKey, 'QUEUE_ENTER'), ts: iso(enteredAt), journey_id: journey, step: 'QUEUE_ENTER', pid, queue_entry_id: qe, verify_route: verify })];
    const admittedAt = msOf(v.admittedAt);
    if (admittedAt !== undefined) out.push(stepRow({ ...b, ts: admittedAt }, { source_key: stepOf(eventKey, 'ADMIT'), ts: iso(admittedAt), journey_id: journey, step: 'ADMIT', pid, queue_entry_id: qe }));
    if (pid) out.push(linkOf(b, 'PID', pid, '', pid, journey, 'telemetry.queue'));
    return { rows: out, outcome: 'LOADED' };
  }

  if (record === 'PurchaseSessionStarted') return skip('NO_LINK_KIND');

  if (record === 'HoldAttempt') {
    const at = msOf(v.occurredAt);
    const eventKey = uuidOf(v.eventKey);
    const latency = int(v.latencyMs);
    const seats = arrayOfStrings(v.seatIds);
    if (at === undefined || !eventKey || latency === undefined || latency < 0 || latency > 65_535 || seats === null) return reject(latency !== undefined && (latency < 0 || latency > 65_535) ? 'BAD_LATENCY' : 'MISSING_FIELD');
    const heldAt = msOf(v.heldAt);
    const b = baseOf(eventId, at, ctx, retain);
    return {
      rows: [stepRow(b, { source_key: stepOf(eventKey, 'HOLD_TRY'), ts: iso(at), journey_id: uuidOf(v.journeyId), step: 'HOLD_TRY', purchase_session_id: str(v.purchaseSessionId, 128), seat_ids: seats, held_at: heldAt === undefined ? '' : iso(heldAt), result: str(v.result, 64) })],
      outcome: 'LOADED',
    };
  }

  if (record === 'SeatEvent') {
    const at = msOf(v.occurredAt);
    const eventKey = uuidOf(v.eventKey);
    const type = str(v.type, 64);
    const seat = str(v.seatId, 64);
    if (at === undefined || !eventKey || !seat) return reject('MISSING_FIELD');
    if (type !== 'RELEASED' && type !== 'EXPIRED') return skip('SEAT_EVENT_TYPE');
    const b = baseOf(eventId, at, ctx, retain);
    return {
      rows: [stepRow(b, { source_key: stepOf(eventKey, 'HOLD_END'), ts: iso(at), journey_id: '', step: 'HOLD_END', account_id: str(v.accountId, 128), purchase_session_id: str(v.purchaseSessionId, 128), seat_ids: [seat], result: type })],
      outcome: 'LOADED',
    };
  }

  if (record === 'OrderEvent') {
    const at = msOf(v.occurredAt);
    const eventKey = uuidOf(v.eventKey);
    const type = str(v.type, 64);
    const step = orderStep(type);
    const seats = arrayOfStrings(v.seatIds);
    if (at === undefined || !eventKey || seats === null) return reject('MISSING_FIELD');
    if (!step) return skip('ORDER_EVENT_TYPE');
    const b = baseOf(eventId, at, ctx, retain);
    const account = str(v.accountId, 128);
    const journey = uuidOf(v.journeyId);
    const refMissing = v.refMissing === true;
    const out: InvRow[] = [
      stepRow(b, {
        source_key: stepOf(eventKey, step),
        ts: iso(at),
        journey_id: journey,
        step,
        account_id: account,
        purchase_session_id: str(v.purchaseSessionId, 128),
        order_id: str(v.orderId, 128),
        seat_ids: seats,
        result: type,
        ref_missing: bool01(refMissing),
      }),
    ];
    if (step === 'ORDER') {
      if (account) out.push(linkOf(b, 'ACCOUNT', account, account, '', journey, 'trade.orders'));
      const contact = str(v.contactRef, 256);
      if (!refMissing && contact) out.push(linkOf(b, 'CONTACT', contact, account, '', journey, 'trade.orders'));
      refLinks(b, account, journey, ctx, out);
    }
    return { rows: out, outcome: 'LOADED' };
  }

  if (record === 'PaymentEvent') {
    const at = msOf(v.occurredAt);
    const eventKey = uuidOf(v.eventKey);
    if (at === undefined || !eventKey) return reject('MISSING_FIELD');
    const b = baseOf(eventId, at, ctx, retain);
    return {
      rows: [
        stepRow(b, {
          source_key: stepOf(eventKey, 'PAY_TRY'),
          ts: iso(at),
          step: 'PAY_TRY',
          order_id: str(v.orderId, 128),
          purchase_session_id: '',
          payment_method_ref: str(v.paymentMethodRef, 256),
          card_bin: str(v.cardBin, 8),
          result: str(v.result, 64),
          ref_missing: bool01(v.refMissing === true),
        }),
      ],
      outcome: 'LOADED',
    };
  }

  if (record === 'TicketEvent') {
    const at = msOf(v.occurredAt);
    const eventKey = uuidOf(v.eventKey);
    const type = str(v.type, 64);
    const step = ticketStep(type);
    if (at === undefined || !eventKey) return reject('MISSING_FIELD');
    if (!step) return skip('TICKET_EVENT_TYPE');
    const b = baseOf(eventId, at, ctx, retain);
    return {
      rows: [stepRow(b, { source_key: stepOf(eventKey, step), ts: iso(at), step, account_id: str(v.accountId, 128), order_id: str(v.orderId, 128), ticket_id: str(v.ticketId, 128), result: type })],
      outcome: 'LOADED',
    };
  }

  if (record === 'BehaviorSignal') {
    const at = msOf(v.ts);
    const eventKey = uuidOf(v.eventKey);
    if (at === undefined || !eventKey) return reject('MISSING_FIELD');
    const f = isObj(v.features) ? v.features : {};
    const asn = int(v.asn) ?? 0;
    if (asn < 0 || asn > UINT32_MAX) return reject('BAD_ASN');
    const net = NET_CLASSES.includes(v.netClass as never) ? String(v.netClass) : asnClassOf(asn, ctx.asnTable);
    const entropy = typeof f.pointerEntropy === 'number' && Number.isFinite(f.pointerEntropy) ? f.pointerEntropy : null;
    const b = baseOf(eventId, at, ctx, retain);
    return {
      rows: [
        {
          table: 'inv.inv_behavior',
          row: {
            event_id: eventId,
            event_key: eventKey,
            ts: iso(at),
            ingested_at: iso(b.ingestedAt),
            journey_id: uuidOf(v.journeyId),
            pid: str(v.pid, 128),
            screen: SCREENS.includes(v.screen as never) ? String(v.screen) : '',
            device_ref: str(v.deviceRef, 256),
            ref_missing: bool01(v.refMissing === true),
            net_class: net,
            asn,
            v: int(f.v) ?? 0,
            window_ms: int(f.windowMs) ?? 0,
            pointer_moves: int(f.pointerMoves) ?? 0,
            pointer_entropy: entropy,
            input_interval_mean_ms: typeof f.inputIntervalMeanMs === 'number' ? f.inputIntervalMeanMs : 0,
            input_interval_std_ms: typeof f.inputIntervalStdMs === 'number' ? f.inputIntervalStdMs : 0,
            scroll_events: int(f.scrollEvents) ?? 0,
            scroll_distance_px: int(f.scrollDistancePx) ?? 0,
            retain_until: retain,
            ingest_rank: b.rank,
          },
        },
      ],
      outcome: 'LOADED',
    };
  }

  if (record === 'TrustVerdict') {
    const at = msOf(v.occurredAt);
    const eventKey = uuidOf(v.eventKey);
    if (at === undefined || !eventKey) return reject('MISSING_FIELD');
    const b = baseOf(eventId, at, ctx, retain);
    const out: InvRow[] = [];
    const pid = str(v.pid, 128);
    const journey = uuidOf(v.journeyId);
    const account = '';
    if (pid) out.push(linkOf(b, 'PID', pid, account, pid, journey, 'telemetry.trust-verdicts'));
    const device = str(v.deviceRef, 256);
    if (!v.refMissing && device) out.push(linkOf(b, 'DEVICE', device, account, pid, journey, 'telemetry.trust-verdicts'));
    return { rows: out, outcome: out.length ? 'LOADED' : 'SKIPPED', ...(out.length ? {} : { reason: 'NO_LINK' }) };
  }

  return skip(`UNLOADED_RECORD:${record}`);
}

function mapRequest(v: Record<string, unknown>, ctx: InvContext): MappedEvent {
  if (Object.prototype.hasOwnProperty.call(v, '__proto__') || Object.prototype.hasOwnProperty.call(v, 'constructor')) return reject('BAD_JSON');
  const required = ['ts', 'requestId', 'gateway', 'routeKind', 'status', 'ip'];
  for (const k of required) if (v[k] === undefined || v[k] === null || v[k] === '') return reject('MISSING_FIELD');
  const at = typeof v.ts === 'string' ? Date.parse(v.ts) : undefined;
  if (at === undefined || !Number.isFinite(at)) return reject('MISSING_FIELD');
  const status = int(v.status);
  if (status === undefined || status < 100 || status > 599) return reject('BAD_STATUS');
  const asn = v.asn === undefined ? 0 : int(v.asn);
  if (asn === undefined || asn < 0 || asn > UINT32_MAX) return reject('BAD_ASN');
  const ip = ipv6Of(v.ip);
  if (!ip) return reject('BAD_IP');
  if (!GATEWAYS.includes(v.gateway as never)) return reject('BAD_GATEWAY');
  if (!ROUTE_KINDS.includes(v.routeKind as never)) return reject('BAD_ROUTE');
  const labels = arrayOfStrings(v.edgeBotLabels, MAX_LABELS);
  if (labels === null) return reject('BAD_LABELS');
  const eventId = str(v.eventId, 64);
  if (!eventId) return skip('NO_EVENT');
  const perf = ctx.eventDates.get(eventId);
  const retain = perf ? retainUntilOf(perf) : null;
  if (!retain) return reject('EVENT_DATE_MISSING');
  const b = baseOf(eventId, at, ctx, retain);
  const pid = str(v.pid, 128);
  const account = str(v.accountId, 128);
  const journey = uuidOf(v.journeyId);
  const row: InvRow = {
    table: 'inv.inv_request',
    row: {
      event_id: eventId,
      request_id: str(v.requestId, 128),
      ts: iso(at),
      ingested_at: iso(b.ingestedAt),
      journey_id: journey,
      gateway: v.gateway,
      route_kind: v.routeKind,
      status,
      account_id: account,
      pid,
      ip,
      asn,
      net_class: asnClassOf(asn, ctx.asnTable),
      ja4: str(v.ja4, 128),
      edge_bot_labels: labels,
      device_ref: '',
      retain_until: retain,
      ingest_rank: b.rank,
    },
  };
  const out = [row];
  if (pid) out.push(linkOf(b, 'PID', pid, account, pid, journey, 'investigation.requests'));
  if (account) out.push(linkOf(b, 'ACCOUNT', account, account, pid, journey, 'investigation.requests'));
  refLinks(b, account, journey, ctx, out);
  return { rows: out, outcome: 'LOADED' };
}

/** 밀리초가 Int32 범위 안인지(사건 시각은 판매 시작 기준 밀리초) */
export const inInt32 = (n: number): boolean => Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX;
