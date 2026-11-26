// F-04-9 사건 형식 v2의 열·메타데이터·검증. 정본: docs/features/forensic-replay.md §4.1~§4.3,
// docs/security/asvs/forensic-replay.md v5.0.0-1.4.1·1.4.2·1.5.2·2.2.1·5.2.1·5.2.2·5.2.3.
// 파일 전체를 거절하는 규칙과, 그 사건만 버리는 일관성 규칙을 나눈다. 화면·저장소를 직접 만지지 않는다.

export const SCHEMA_NAME = 'peaket-forensics-v2';
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_EVENTS = 3_000_000;
export const MIN_SEATS = 1_000;
export const MAX_SEATS = 100_000;
export const MAX_WINDOW_MS = 30 * 60 * 1000;
export const LOBBY_MS = 10 * 60 * 1000;
export const NO_SEAT = 0xffffffff;

export const EVENT_KIND = {
  ADMIT: 1,
  HOLD_TRY: 2,
  HOLD_END: 3,
  PAY_TRY: 4,
  SALE: 5,
  PAY_FAIL: 6,
  QUEUE_ENTER: 7,
} as const;

/** 홀드·결제 결과. 정본은 뜻만 정하고 값 목록이 없어 로컬 상수로 둔다(F-04-9 계획 §1.1). */
export const RESULT = {
  NONE: 0,
  HELD: 1,
  CONFLICT: 2,
  LIMIT: 3,
  ERROR: 4,
  PAID: 5,
  FAILED: 6,
} as const;

/** 네트워크 유형. 정본은 0(없음)만 정하고 값 목록이 없어 로컬 상수로 둔다(F-04-9 계획 §1.1). */
export const NET_TYPE = {
  NONE: 0,
  MOBILE: 1,
  WIFI: 2,
  HOSTING: 3,
  PROXY: 4,
} as const;

/** 열 값 허용 목록. 정본 §4.1·§4.2과 이 계획 §1.1·§7.13에서 온다. 시험은 같은 값을 따로 적어 대조한다. */
export const ALLOWED_KINDS: readonly number[] = Object.values(EVENT_KIND);
export const ALLOWED_RESULTS: readonly number[] = Object.values(RESULT);
export const ALLOWED_NET_TYPES: readonly number[] = Object.values(NET_TYPE);
export const MAX_BOT_TIER = 3;
export const MAX_FLAG_VALUE = 1;
export const SEATLESS_SECTION = 0;

/** 체크포인트가 담는 좌석 상태. 경합 표시는 재생할 때 앞뒤 1초로 계산하고 저장하지 않는다(§3.4). */
export const SEAT_STATE = {
  EMPTY: 0,
  HELD: 1,
  PAYING: 2,
  SOLD: 3,
} as const;

export const COLUMN_SPECS = [
  { name: 't_ms', type: 'int32' },
  { name: 'kind', type: 'uint8' },
  { name: 'seat', type: 'uint32' },
  { name: 'section', type: 'uint16' },
  { name: 'session', type: 'uint32' },
  { name: 'result', type: 'uint8' },
  { name: 'retry', type: 'uint8' },
  { name: 'latency_ms', type: 'uint16' },
  { name: 'first_hold_ms', type: 'uint32' },
  { name: 'entropy', type: 'float32' },
  { name: 'net_type', type: 'uint8' },
  { name: 'asn', type: 'uint32' },
  { name: 'device_group', type: 'uint32' },
  { name: 'bot_tier', type: 'uint8' },
  { name: 'member', type: 'uint8' },
  { name: 'post_seat', type: 'uint8' },
] as const;

export type ColumnName = (typeof COLUMN_SPECS)[number]['name'];
export type ColumnType = (typeof COLUMN_SPECS)[number]['type'];

export interface EventColumns {
  t_ms: Int32Array;
  kind: Uint8Array;
  seat: Uint32Array;
  section: Uint16Array;
  session: Uint32Array;
  result: Uint8Array;
  retry: Uint8Array;
  latency_ms: Uint16Array;
  first_hold_ms: Uint32Array;
  entropy: Float32Array;
  net_type: Uint8Array;
  asn: Uint32Array;
  device_group: Uint32Array;
  bot_tier: Uint8Array;
  member: Uint8Array;
  post_seat: Uint8Array;
}

export interface EventRow {
  t_ms: number;
  kind: number;
  seat?: number;
  section?: number;
  session?: number;
  result?: number;
  retry?: number;
  latency_ms?: number;
  first_hold_ms?: number;
  entropy?: number;
  net_type?: number;
  asn?: number;
  device_group?: number;
  bot_tier?: number;
  member?: number;
  post_seat?: number;
}

export type ForensicSource = 'SYNTHETIC' | 'RESEARCH' | 'INVESTIGATION';

export interface ForensicMeta {
  schema: string;
  source: ForensicSource;
  seatCount: number;
  sectionCount: number;
  /** 판매 시작 시각(UTC ISO 8601) */
  saleStart: string;
  seed?: string;
  generatorVersion?: number;
  loaderRunId?: string;
  eventId?: string;
  caseId?: string;
  windowFromMs?: number;
  windowToMs?: number;
  snapshotVersion?: string;
}

export interface Envelope {
  fileName: string;
  byteLength: number;
  magicHead: string;
  magicTail: string;
}

export interface SchemaColumn {
  name: string;
  type: string;
  compressed?: boolean;
  dictionary?: boolean;
}

export type RejectCode =
  | 'extension'
  | 'size'
  | 'magic'
  | 'meta'
  | 'schema-columns'
  | 'schema-compressed'
  | 'schema-dictionary'
  | 'row-count'
  | 'event-limit'
  | 'time-order'
  | 'lobby'
  | 'window'
  | 'seat-range'
  | 'section-range'
  | 'source-rule'
  | 'source-mismatch'
  | 'arrow-ipc';

export interface Reject {
  ok: false;
  code: RejectCode;
  message: string;
}

export type DropCode =
  | 'KIND_NOT_ALLOWED'
  | 'RESULT_NOT_ALLOWED'
  | 'NET_TYPE_NOT_ALLOWED'
  | 'BOT_TIER_NOT_ALLOWED'
  | 'FLAG_NOT_BOOLEAN'
  | 'SECTION_WITHOUT_SEAT'
  | 'ASN_WITHOUT_HOSTING'
  | 'HOLD_END_WITHOUT_HOLD'
  | 'SALE_WITHOUT_PAY';

export interface DropCount {
  code: DropCode;
  count: number;
}

export interface Accepted {
  ok: true;
  rowCount: number;
  kept: number;
  dropped: number;
  droppedBy: DropCount[];
  /** 1이면 남기고 0이면 버린 사건. 화면은 이 표시대로 그린다. */
  keep: Uint8Array;
}

export type Validation = Accepted | Reject;

export interface FileInput {
  meta: ForensicMeta;
  schema: readonly SchemaColumn[];
  columns: EventColumns;
  envelope: Envelope;
  /** 연 길이 허용하는 원천. 없으면 검사하지 않는다. */
  openedSource?: ForensicSource;
}

function reject(code: RejectCode, message: string): Reject {
  return { ok: false, code, message };
}

export function makeColumns(rowCount: number): EventColumns {
  return {
    t_ms: new Int32Array(rowCount),
    kind: new Uint8Array(rowCount),
    seat: new Uint32Array(rowCount).fill(NO_SEAT),
    section: new Uint16Array(rowCount),
    session: new Uint32Array(rowCount),
    result: new Uint8Array(rowCount),
    retry: new Uint8Array(rowCount),
    latency_ms: new Uint16Array(rowCount),
    first_hold_ms: new Uint32Array(rowCount),
    entropy: new Float32Array(rowCount).fill(Number.NaN),
    net_type: new Uint8Array(rowCount),
    asn: new Uint32Array(rowCount),
    device_group: new Uint32Array(rowCount),
    bot_tier: new Uint8Array(rowCount),
    member: new Uint8Array(rowCount),
    post_seat: new Uint8Array(rowCount),
  };
}

export function columnsFromRows(rows: readonly EventRow[]): EventColumns {
  const columns = makeColumns(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    columns.t_ms[i] = row.t_ms;
    columns.kind[i] = row.kind;
    columns.seat[i] = row.seat ?? NO_SEAT;
    columns.section[i] = row.section ?? 0;
    columns.session[i] = row.session ?? 0;
    columns.result[i] = row.result ?? RESULT.NONE;
    columns.retry[i] = row.retry ?? 0;
    columns.latency_ms[i] = row.latency_ms ?? 0;
    columns.first_hold_ms[i] = row.first_hold_ms ?? 0;
    columns.entropy[i] = row.entropy ?? Number.NaN;
    columns.net_type[i] = row.net_type ?? NET_TYPE.NONE;
    columns.asn[i] = row.asn ?? 0;
    columns.device_group[i] = row.device_group ?? 0;
    columns.bot_tier[i] = row.bot_tier ?? 0;
    columns.member[i] = row.member ?? 0;
    columns.post_seat[i] = row.post_seat ?? 0;
  }
  return columns;
}

export function validateEnvelope(envelope: Envelope): { ok: true } | Reject {
  if (!envelope.fileName.toLowerCase().endsWith('.arrow')) {
    return reject('extension', '확장자가 .arrow가 아닙니다');
  }
  if (!Number.isInteger(envelope.byteLength) || envelope.byteLength < 0 || envelope.byteLength > MAX_FILE_BYTES) {
    return reject('size', '파일 크기가 200MB를 넘습니다');
  }
  if (envelope.magicHead !== 'ARROW1' || envelope.magicTail !== 'ARROW1') {
    return reject('magic', '앞뒤 매직 ARROW1이 없습니다');
  }
  return { ok: true };
}

export function validateMeta(meta: ForensicMeta): { ok: true } | Reject {
  if (meta.schema !== SCHEMA_NAME) return reject('meta', `스키마 이름이 ${SCHEMA_NAME}이 아닙니다`);
  if (meta.source !== 'SYNTHETIC' && meta.source !== 'RESEARCH' && meta.source !== 'INVESTIGATION') {
    return reject('meta', '모르는 원천입니다');
  }
  if (!Number.isInteger(meta.seatCount) || meta.seatCount < MIN_SEATS || meta.seatCount > MAX_SEATS) {
    return reject('meta', '좌석 수는 1,000~100,000이어야 합니다');
  }
  if (!Number.isInteger(meta.sectionCount) || meta.sectionCount < 1 || meta.sectionCount > 65_535) {
    return reject('meta', '구역 수가 범위를 벗어났습니다');
  }
  if (Number.isNaN(Date.parse(meta.saleStart))) return reject('meta', '판매 시작 시각이 ISO 8601이 아닙니다');

  const synthetic = meta.source === 'SYNTHETIC';
  const from = meta.windowFromMs ?? (synthetic ? -LOBBY_MS : Number.NaN);
  const to = meta.windowToMs ?? (synthetic ? MAX_WINDOW_MS : Number.NaN);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < -LOBBY_MS || from >= to || to > MAX_WINDOW_MS) {
    return reject('meta', synthetic ? '시간창은 -10분부터 30분 안이어야 합니다' : '연구·조사 원천에는 시간창이 필요합니다');
  }

  if (meta.source === 'SYNTHETIC') {
    const hasSeed = typeof meta.seed === 'string' && meta.seed.length > 0 && Number.isInteger(meta.generatorVersion) && (meta.generatorVersion ?? 0) >= 1;
    const hasLoader = typeof meta.loaderRunId === 'string' && meta.loaderRunId.length > 0;
    if (!hasSeed && !hasLoader) return reject('meta', '합성 원천에는 시드·생성기 판이나 부하 시험 실행 ID가 필요합니다');
  } else if (meta.source === 'RESEARCH') {
    if (typeof meta.eventId !== 'string' || meta.eventId.length === 0) return reject('meta', '연구 원천에는 회차가 필요합니다');
  } else {
    if (typeof meta.eventId !== 'string' || meta.eventId.length === 0) return reject('meta', '조사 원천에는 회차가 필요합니다');
    if (typeof meta.caseId !== 'string' || meta.caseId.length === 0) return reject('meta', '조사 원천에는 사건 ID가 필요합니다');
    if (typeof meta.snapshotVersion !== 'string' || meta.snapshotVersion.length === 0) {
      return reject('meta', '조사 원천에는 기록 고정 판이 필요합니다');
    }
  }
  return { ok: true };
}

export function validateSchema(schema: readonly SchemaColumn[]): { ok: true } | Reject {
  if (schema.length !== COLUMN_SPECS.length) return reject('schema-columns', '열 수가 다릅니다');
  for (let i = 0; i < COLUMN_SPECS.length; i += 1) {
    const expected = COLUMN_SPECS[i];
    const actual = schema[i];
    if (actual.name !== expected.name || actual.type !== expected.type) {
      return reject('schema-columns', `${i + 1}번째 열이 ${expected.name}(${expected.type})가 아닙니다`);
    }
    if (actual.compressed) return reject('schema-compressed', '압축 버퍼는 받지 않습니다');
    if (actual.dictionary) return reject('schema-dictionary', '사전 열은 받지 않습니다');
  }
  return { ok: true };
}

export function validateEventCount(count: number): { ok: true } | Reject {
  if (!Number.isInteger(count) || count < 0) return reject('row-count', '행 수가 정수가 아닙니다');
  if (count > MAX_EVENTS) return reject('event-limit', '사건이 300만 건을 넘습니다');
  return { ok: true };
}

function sameLength(columns: EventColumns, rowCount: number): boolean {
  return COLUMN_SPECS.every((spec) => columns[spec.name].length === rowCount);
}

export function validateColumns(meta: ForensicMeta, columns: EventColumns): Validation {
  const rowCount = columns.t_ms.length;
  if (!sameLength(columns, rowCount)) return reject('row-count', '열마다 행 수가 다릅니다');
  const countResult = validateEventCount(rowCount);
  if (!countResult.ok) return countResult;

  const windowFrom = meta.windowFromMs ?? (meta.source === 'SYNTHETIC' ? -LOBBY_MS : 0);
  const windowTo = meta.windowToMs ?? MAX_WINDOW_MS;
  let previous = -LOBBY_MS;
  for (let i = 0; i < rowCount; i += 1) {
    const t = columns.t_ms[i];
    if (t < -LOBBY_MS) return reject('lobby', '로비 10분 앞보다 이른 사건이 있습니다');
    if (t < windowFrom || t > windowTo) return reject('window', '시간창 밖 사건이 있습니다');
    if (t < previous) return reject('time-order', '사건 시각이 오름차순이 아닙니다');
    previous = t;

    const seat = columns.seat[i];
    if (seat !== NO_SEAT && seat >= meta.seatCount) return reject('seat-range', '좌석 번호가 좌석 수를 넘습니다');
    if (columns.section[i] >= meta.sectionCount) return reject('section-range', '구역 번호가 구역 수를 넘습니다');

    const entropy = columns.entropy[i];
    if (!Number.isNaN(entropy) && !Number.isFinite(entropy)) return reject('source-rule', '엔트로피가 유한수가 아닙니다');
  }

  const keep = new Uint8Array(rowCount).fill(1);
  const dropCounts: Partial<Record<DropCode, number>> = {};
  const addDrop = (code: DropCode): void => {
    dropCounts[code] = (dropCounts[code] ?? 0) + 1;
  };

  for (let i = 0; i < rowCount; i += 1) {
    const kind = columns.kind[i];
    const result = columns.result[i];
    const netType = columns.net_type[i];
    const seat = columns.seat[i];
    const section = columns.section[i];
    const asn = columns.asn[i];
    let code: DropCode | null = null;
    if (!ALLOWED_KINDS.includes(kind)) code = 'KIND_NOT_ALLOWED';
    else if (!ALLOWED_RESULTS.includes(result)) code = 'RESULT_NOT_ALLOWED';
    else if (!ALLOWED_NET_TYPES.includes(netType)) code = 'NET_TYPE_NOT_ALLOWED';
    else if (columns.bot_tier[i] > MAX_BOT_TIER) code = 'BOT_TIER_NOT_ALLOWED';
    else if (columns.member[i] > MAX_FLAG_VALUE || columns.post_seat[i] > MAX_FLAG_VALUE) code = 'FLAG_NOT_BOOLEAN';
    else if (seat === NO_SEAT && section !== SEATLESS_SECTION) code = 'SECTION_WITHOUT_SEAT';
    else if (asn !== 0 && netType !== NET_TYPE.HOSTING && netType !== NET_TYPE.PROXY) code = 'ASN_WITHOUT_HOSTING';

    if (code !== null) {
      keep[i] = 0;
      addDrop(code);
    }
  }

  for (let i = 0; i < rowCount; i += 1) {
    if (keep[i] === 0) continue;
    const entropy = columns.entropy[i];
    if (meta.source === 'SYNTHETIC') {
      if (columns.member[i] !== 0 || columns.post_seat[i] !== 0) {
        return reject('source-rule', '합성 원천에 묶음 계정·게시물 좌석 표시가 있습니다');
      }
    } else if (meta.source === 'RESEARCH') {
      if (
        !Number.isNaN(entropy) ||
        columns.net_type[i] !== 0 ||
        columns.asn[i] !== 0 ||
        columns.device_group[i] !== 0 ||
        columns.member[i] !== 0 ||
        columns.post_seat[i] !== 0
      ) {
        return reject('source-rule', '연구 원천에 기기·망·행동·묶음 칸이 있습니다');
      }
    } else {
      if (columns.bot_tier[i] !== 0) return reject('source-rule', '조사 원천에 봇 등급이 있습니다');
      if (columns.member[i] === 0) {
        if (
          !Number.isNaN(entropy) ||
          columns.net_type[i] !== 0 ||
          columns.asn[i] !== 0 ||
          columns.device_group[i] !== 0
        ) {
          return reject('source-rule', '묶음 밖 여정에 기기·망·행동 칸이 있습니다');
        }
      }
    }
  }

  // session은 uint32라 2^31 이상과 0xFFFFFFFF가 정상 값이다. 0을 '없음'으로 두고 session+1을 저장한다(Float64는 2^32까지 정확).
  const heldBySeat = new Float64Array(meta.seatCount);
  const paidBySeat = new Float64Array(meta.seatCount);
  for (let i = 0; i < rowCount; i += 1) {
    if (keep[i] === 0) continue;
    const kind = columns.kind[i];
    const seat = columns.seat[i];
    if (seat === NO_SEAT) continue;
    const key = columns.session[i] + 1;

    if (kind === EVENT_KIND.HOLD_TRY && columns.result[i] === RESULT.HELD) {
      heldBySeat[seat] = key;
      continue;
    }
    if (kind === EVENT_KIND.HOLD_END) {
      if (heldBySeat[seat] !== key) {
        keep[i] = 0;
        addDrop('HOLD_END_WITHOUT_HOLD');
      } else {
        heldBySeat[seat] = 0;
      }
      continue;
    }
    if (kind === EVENT_KIND.PAY_TRY) {
      if (heldBySeat[seat] === key) heldBySeat[seat] = 0;
      paidBySeat[seat] = key;
      continue;
    }
    if (kind === EVENT_KIND.SALE) {
      if (paidBySeat[seat] !== key) {
        keep[i] = 0;
        addDrop('SALE_WITHOUT_PAY');
      } else {
        paidBySeat[seat] = 0;
      }
      continue;
    }
    if (kind === EVENT_KIND.PAY_FAIL && paidBySeat[seat] === key) {
      paidBySeat[seat] = 0;
    }
  }

  let dropped = 0;
  for (let i = 0; i < rowCount; i += 1) if (keep[i] === 0) dropped += 1;

  const order: readonly DropCode[] = [
    'KIND_NOT_ALLOWED',
    'RESULT_NOT_ALLOWED',
    'NET_TYPE_NOT_ALLOWED',
    'BOT_TIER_NOT_ALLOWED',
    'FLAG_NOT_BOOLEAN',
    'SECTION_WITHOUT_SEAT',
    'ASN_WITHOUT_HOSTING',
    'HOLD_END_WITHOUT_HOLD',
    'SALE_WITHOUT_PAY',
  ];
  const droppedBy: DropCount[] = [];
  for (const code of order) {
    const count = dropCounts[code] ?? 0;
    if (count > 0) droppedBy.push({ code, count });
  }

  return {
    ok: true,
    rowCount,
    kept: rowCount - dropped,
    dropped,
    droppedBy,
    keep,
  };
}

export function validateFile(input: FileInput): Validation {
  const envelope = validateEnvelope(input.envelope);
  if (!envelope.ok) return envelope;
  const meta = validateMeta(input.meta);
  if (!meta.ok) return meta;
  const schema = validateSchema(input.schema);
  if (!schema.ok) return schema;
  if (input.openedSource !== undefined && input.meta.source !== input.openedSource) {
    return reject('source-mismatch', '파일 원천이 연 길과 다릅니다');
  }
  return validateColumns(input.meta, input.columns);
}

export function compactColumns(columns: EventColumns, keep: Uint8Array): EventColumns {
  let kept = 0;
  for (let i = 0; i < keep.length; i += 1) if (keep[i] === 1) kept += 1;
  const out = makeColumns(kept);
  for (const spec of COLUMN_SPECS) {
    const source = columns[spec.name] as unknown as { readonly length: number; readonly [index: number]: number };
    const target = out[spec.name] as unknown as { [index: number]: number };
    let j = 0;
    for (let i = 0; i < source.length; i += 1) {
      if (keep[i] === 1) {
        target[j] = source[i];
        j += 1;
      }
    }
  }
  return out;
}
