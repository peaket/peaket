// F-04-17 Arrow 표 해독. 정본: docs/features/forensic-replay.md §4.2·§8 FX-T21,
// docs/security/asvs/forensic-replay.md v5.0.0-1.1.1·1.4.1·1.4.2·1.5.2.
// apache-arrow의 Table을 좁은 포트(ArrowTableLike)로 받아 사건 열 16개로 옮긴다.
// 스키마·메타·행 수를 먼저 보고, 통과한 뒤에만 열 값을 한 번 읽는다. 화면·저장소를 직접 만지지 않는다.
import {
  COLUMN_SPECS,
  SCHEMA_NAME,
  makeColumns,
  validateEventCount,
  validateSchema,
  type ColumnName,
  type EventColumns,
  type ForensicMeta,
  type ForensicSource,
  type Reject,
  type SchemaColumn,
} from '../forensics/events.ts';
import type { ReplayEnvelope, ReplayFileInput } from '../replay-export.ts';

export interface ArrowFieldLike {
  name: string;
  /** apache-arrow DataType의 글자. 예 'Int32'·'Uint8'·'Float32' */
  type: string;
  dictionary?: boolean;
}

export interface ArrowVectorLike {
  readonly length: number;
  get(index: number): unknown;
}

/** apache-arrow Table이 구조적으로 만족하는 좁은 포트. 시험은 이 모양만 만든다. */
export interface ArrowTableLike {
  readonly numRows: number;
  readonly schema: {
    readonly fields: readonly ArrowFieldLike[];
    readonly metadata: ReadonlyMap<string, string> | null;
  };
  getChild(name: string): ArrowVectorLike | null;
}

export type DecodedReplay =
  | { ok: true; file: ReplayFileInput }
  | { ok: false; reject: Reject };

const TYPE_NAMES: Record<string, string> = {
  Int32: 'int32',
  Uint8: 'uint8',
  Uint16: 'uint16',
  Uint32: 'uint32',
  Float32: 'float32',
};

/** apache-arrow DataType 글자를 정본 §4.2의 열 형으로 바꾼다. 모르는 글자는 그대로 둬 스키마 검사가 거절한다. */
export function arrowTypeName(arrowType: string): string {
  return TYPE_NAMES[arrowType] ?? arrowType;
}

function text(metadata: ReadonlyMap<string, string> | null, key: string): string | undefined {
  return metadata === null ? undefined : metadata.get(key);
}

function numberOr(metadata: ReadonlyMap<string, string> | null, key: string): number {
  const value = text(metadata, key);
  if (value === undefined || value === '') return Number.NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

function optionalNumber(metadata: ReadonlyMap<string, string> | null, key: string): number | undefined {
  const value = text(metadata, key);
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** 정본 §4.2의 메타데이터 키를 ForensicMeta로 읽는다. 수가 아니면 NaN을 남겨 validateMeta가 거절한다. */
export function arrowMetadata(metadata: ReadonlyMap<string, string> | null): ForensicMeta {
  return {
    schema: text(metadata, 'schema') ?? '',
    source: (text(metadata, 'source') ?? '') as ForensicSource,
    seatCount: numberOr(metadata, 'seatCount'),
    sectionCount: numberOr(metadata, 'sectionCount'),
    saleStart: text(metadata, 'saleStart') ?? '',
    seed: text(metadata, 'seed'),
    generatorVersion: optionalNumber(metadata, 'generatorVersion'),
    loaderRunId: text(metadata, 'loaderRunId'),
    eventId: text(metadata, 'eventId'),
    caseId: text(metadata, 'caseId'),
    windowFromMs: optionalNumber(metadata, 'windowFromMs'),
    windowToMs: optionalNumber(metadata, 'windowToMs'),
    snapshotVersion: text(metadata, 'snapshotVersion'),
  };
}

function rejectSchema(reject: Reject): DecodedReplay {
  return { ok: false, reject };
}

function defaultValue(name: ColumnName): number {
  if (name === 'seat') return 0xffffffff;
  if (name === 'entropy') return Number.NaN;
  return 0;
}

/**
 * 해독 단계의 기본 메타 검사. 스키마 이름과 원천만 본다.
 * 원천별 필수 값(합성 시드/부하 ID, 연구 시간창·회차, 조사 사건·고정 판)은 파일 검증(validateMeta)이 맡는다.
 * 그래야 해독은 하고 파일 거절은 validateFile에서 하는 경계가 유지된다.
 */
function basicMetaIssue(meta: ForensicMeta): Reject | null {
  if (meta.schema !== SCHEMA_NAME) return { ok: false, code: 'meta', message: `스키마 이름이 ${SCHEMA_NAME}이 아닙니다` };
  if (meta.source !== 'SYNTHETIC' && meta.source !== 'RESEARCH' && meta.source !== 'INVESTIGATION') {
    return { ok: false, code: 'meta', message: '모르는 원천입니다' };
  }
  return null;
}

/**
 * Arrow 표를 ReplayFileInput으로 옮긴다.
 * 순서: 스키마 → 메타 → 행 수 → (통과 뒤) 열 16개를 한 번씩. 앞에서 거절이면 getChild를 부르지 않는다.
 */
export function decodeReplayTable(table: ArrowTableLike, envelope: ReplayEnvelope): DecodedReplay {
  const schema: SchemaColumn[] = table.schema.fields.map((field) => ({
    name: field.name,
    type: arrowTypeName(field.type),
    ...(field.dictionary ? { dictionary: true } : {}),
  }));
  const schemaResult = validateSchema(schema);
  if (!schemaResult.ok) return rejectSchema(schemaResult);

  const meta = arrowMetadata(table.schema.metadata);
  const metaIssue = basicMetaIssue(meta);
  if (metaIssue !== null) return rejectSchema(metaIssue);

  const countResult = validateEventCount(table.numRows);
  if (!countResult.ok) return rejectSchema(countResult);

  const rowCount = table.numRows;
  const vectors: ArrowVectorLike[] = [];
  for (const spec of COLUMN_SPECS) {
    const vector = table.getChild(spec.name);
    if (vector === null) {
      return rejectSchema({ ok: false, code: 'schema-columns', message: `${spec.name} 열이 없습니다` });
    }
    if (vector.length !== rowCount) {
      return rejectSchema({ ok: false, code: 'row-count', message: '열마다 행 수가 다릅니다' });
    }
    vectors.push(vector);
  }

  const columns: EventColumns = makeColumns(rowCount);
  for (let k = 0; k < COLUMN_SPECS.length; k += 1) {
    const spec = COLUMN_SPECS[k];
    const vector = vectors[k];
    const target = columns[spec.name] as unknown as { [index: number]: number };
    const fallback = defaultValue(spec.name);
    for (let i = 0; i < rowCount; i += 1) {
      const value = vector.get(i);
      target[i] = value === null || value === undefined ? fallback : (value as number);
    }
  }

  return { ok: true, file: { envelope, meta, schema, columns } };
}
