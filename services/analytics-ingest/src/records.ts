// 원본 적재의 레코드 규칙(docs/streaming.md §6.1, docs/features/analytics.md §3.1·§3.3, OPS-200, F-04-3).
// - 허용 목록 = 작업자가 빌드된 계약 판(@peaket/contracts/avro)의 칸 − 조사 칸 일곱 − 사람이 아닌 금지 칸(SettingChanged.actor).
//   생산자가 새 칸을 먼저 내도(쓴 쪽 스키마가 더 새 판) 허용 목록 밖이라 브론즈에 싣지 않는다
// - 식별값 아홉은 회차별 가명(HMAC-SHA256(회차 키, 값)의 256비트 전체, 16진수)으로 바꾼다. 회차 키는 pseudonym.ts가 준다
// - 금지 칸(이름·연락처·이메일·연계정보·IP·User-Agent·결제 토큰·계좌)이 쓴 쪽 값에 있으면 버리고 스키마 위반으로 센다
// - 심장 박동·1초 대기 집계는 건너뛰고(§6 첫 줄), 점검 회차의 사건도 건너뛴다. 건너뛴 위치도 커버리지 표에 남긴다
import { avroSchemas } from '@peaket/contracts/avro';

/** 브론즈 표(레코드마다 하나, analytics §3.1 '브론즈 표(brz_<원천>)') */
export const BRONZE_TABLES = {
  OrderEvent: 'bronze.brz_order_event',
  PaymentEvent: 'bronze.brz_payment_event',
  SeatEvent: 'bronze.brz_seat_event',
  EventSaleChanged: 'bronze.brz_event_sale',
  PurchaseSessionStarted: 'bronze.brz_purchase_session',
  PurchaseSessionEnded: 'bronze.brz_purchase_session',
  TicketEvent: 'bronze.brz_ticket_event',
  SettlementEvent: 'bronze.brz_settlement_event',
  SettingChanged: 'bronze.brz_setting_changed',
  QueueEntryRecord: 'bronze.brz_queue_entry',
  HoldAttempt: 'bronze.brz_hold_attempt',
  TrustVerdict: 'bronze.brz_trust_verdict',
} as const;
export type BronzeRecord = keyof typeof BRONZE_TABLES;
export type BronzeTable = (typeof BRONZE_TABLES)[BronzeRecord];

/** 건너뛰는 레코드(§6 첫 줄: 심장 박동, QueueAggregate는 실시간 표만 쓴다) */
export const SKIPPED_RECORDS = new Set(['PipelinePulse', 'QueueAggregate']);

/** 회차 가명으로 바꾸는 식별값(analytics §3.3 '가명') */
export const PSEUDONYM_FIELDS = ['pid', 'accountId', 'queueEntryId', 'admissionJti', 'sessionId', 'purchaseSessionId', 'orderId', 'ticketId', 'holdId'] as const;

/** 조사 칸 일곱(analytics §3.3 '조사 칸은 싣지 않는다', ADR-0171 결정 2): 가명으로 바꾸지 않고 버린다 */
export const INVESTIGATION_FIELDS = ['journeyId', 'deviceRef', 'contactRef', 'paymentMethodRef', 'cardBin', 'holdKind', 'priorityGrantId'] as const;

/** 계약에 있지만 싣지 않는 칸: SettingChanged.actor(analytics §3.1 control.settings 행 '`actor`는 싣지 않는다') */
export const NOT_LOADED_FIELDS: Readonly<Record<string, readonly string[]>> = { SettingChanged: ['actor'] };

/** 금지 칸 이름(analytics §3.3 '금지 필드'). 쓴 쪽 값에 이 이름이 보이면 버리고 스키마 위반으로 센다(대소문자 무시) */
export const FORBIDDEN_FIELD_NAMES = ['name', 'fullName', 'phone', 'phoneNumber', 'contact', 'email', 'ci', 'di', 'ip', 'ipAddress', 'userAgent', 'paymentKey', 'paymentToken', 'bankAccount', 'accountNumber', 'cardNumber'] as const;
const FORBIDDEN = new Set(FORBIDDEN_FIELD_NAMES.map((n) => n.toLowerCase()));

const DROP = new Set<string>(INVESTIGATION_FIELDS);
const PSEUDO = new Set<string>(PSEUDONYM_FIELDS);

/** 레코드 이름(마지막 조각) → 계약 판 최상위 칸 이름 */
export const CONTRACT_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(avroSchemas).map(([full, s]) => [full.slice(full.lastIndexOf('.') + 1), new Set(((s.fields as { name: string }[] | undefined) ?? []).map((f) => f.name))]),
);

/** 허용 목록: 계약 판 칸 − 조사 칸 − 싣지 않는 칸 */
export function allowListOf(record: string): ReadonlySet<string> {
  const fields = CONTRACT_FIELDS.get(record);
  if (!fields) return new Set();
  const not = new Set(NOT_LOADED_FIELDS[record] ?? []);
  return new Set([...fields].filter((f) => !DROP.has(f) && !not.has(f)));
}
const ALLOW = new Map([...CONTRACT_FIELDS.keys()].map((r) => [r, allowListOf(r)] as const));

/** 사건 시각 칸(브론즈 정렬 키 occurred_at, analytics §5.5) */
const TIME_FIELD: Readonly<Record<BronzeRecord, readonly string[]>> = {
  OrderEvent: ['occurredAt'],
  PaymentEvent: ['occurredAt'],
  SeatEvent: ['occurredAt'],
  EventSaleChanged: ['changedAt'],
  PurchaseSessionStarted: ['startedAt'],
  PurchaseSessionEnded: ['endedAt'],
  TicketEvent: ['occurredAt'],
  SettlementEvent: ['occurredAt'],
  SettingChanged: ['occurredAt'],
  // 대기가 끝날 때 한 번 낸다: 끝난 시각(입장·빠짐), 없으면 진입 시각(추천 적용 2026-11-23, F-04-3 계획)
  QueueEntryRecord: ['admittedAt', 'removedAt', 'enteredAt'],
  HoldAttempt: ['occurredAt'],
  TrustVerdict: ['occurredAt'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 레코드의 회차 ID. 설정 사건은 scope가 회차 UUID일 때만, 상품 정산서는 회차가 없다(빈 글) */
export function eventIdOf(record: string, v: Readonly<Record<string, unknown>>): string {
  if (record === 'SettingChanged') return typeof v.scope === 'string' && UUID.test(v.scope) ? v.scope.toLowerCase() : '';
  return typeof v.eventId === 'string' ? v.eventId : '';
}

const msOf = (v: unknown): number | undefined => {
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

export function occurredAtOf(record: BronzeRecord, v: Readonly<Record<string, unknown>>, fallbackMs: number): number {
  for (const f of TIME_FIELD[record]) {
    const ms = msOf(v[f]);
    if (ms !== undefined) return ms;
  }
  return fallbackMs;
}

/** 값 안의 금지 칸 이름(중첩 포함, 경로) */
export function forbiddenPaths(v: unknown, path = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => forbiddenPaths(x, `${path}[${i}]`));
  if (!v || typeof v !== 'object' || v instanceof Date || Buffer.isBuffer(v)) return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [...(FORBIDDEN.has(k.toLowerCase()) ? [path ? `${path}.${k}` : k] : []), ...forbiddenPaths(x, path ? `${path}.${k}` : k)]);
}

/** 중첩 값의 금지 칸과 조사 칸을 지운다(최상위 허용 목록은 따로 건다) */
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (!v || typeof v !== 'object' || v instanceof Date || Buffer.isBuffer(v)) return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !FORBIDDEN.has(k.toLowerCase()) && !DROP.has(k))
      .map(([k, x]) => [k, scrub(x)]),
  );
}

/** JSON으로 쓸 수 있게(bigint·Date·바이트) */
function jsonable(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.getTime();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (Array.isArray(v)) return v.map(jsonable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonable(x)]));
  return v;
}

export interface Pseudonymize {
  (value: string): string;
}

export interface BronzePayload {
  /** 허용 목록·가명·금지 칸 제거를 거친 값(JSON 글로 싣는다) */
  readonly payload: Record<string, unknown>;
  /** 버린 금지 칸(스키마 위반 경보) */
  readonly forbidden: readonly string[];
  /** 허용 목록 밖이라 버린 칸(조사 칸·새 판 칸 등, 경보 없음) */
  readonly droppedFields: readonly string[];
}

/** 레코드 값 하나를 브론즈 값으로 바꾼다. 식별값은 pseudonymize로, 그 밖은 허용 목록으로 */
export function bronzePayloadOf(record: string, v: Readonly<Record<string, unknown>>, pseudonymize: Pseudonymize): BronzePayload {
  const allow = ALLOW.get(record) ?? new Set<string>();
  const forbidden = forbiddenPaths(v);
  const out: Record<string, unknown> = {};
  const droppedFields: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    if (!allow.has(k)) {
      droppedFields.push(k);
      continue;
    }
    if (PSEUDO.has(k)) {
      out[k] = typeof x === 'string' && x !== '' ? pseudonymize(x) : x;
      continue;
    }
    out[k] = jsonable(scrub(x));
  }
  return { payload: out, forbidden, droppedFields };
}

export function isBronzeRecord(record: string): record is BronzeRecord {
  return Object.hasOwn(BRONZE_TABLES, record);
}
