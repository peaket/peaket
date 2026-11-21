// 스트림 작업자의 Avro 읽기(docs/streaming.md §2.6 역직렬화·모르는 열거 기호, ADR-0335 결정 1·3, docs/api/avro/README.md §3, OPS-150).
// - 쓴 쪽 스키마(메시지 머리의 스키마 ID)로 읽고 레코드 전체 이름으로 나눈다. 읽기 스키마로 맞추지 않는다
// - 머리(매직 바이트 0 + 스키마 ID 4바이트)를 먼저 본다. 틀리면 DESERIALIZE 거절, 조회는 그 ID로만
// - 레지스트리가 모른다고 답한 ID(404, UnknownSchemaError)만 UNKNOWN_SCHEMA 거절. 그 밖의 조회 실패는 SchemaUnavailableError를 던진다
//   (부르는 실행기가 그 파티션을 멈추고 다시 시도한다). 실패한 조회는 캐시에 넣지 않는다
// - 빌드된 계약 판(readerSchemas)의 기호 목록에 없는 열거 값은 UNRECOGNIZED로 바꿔 넘기고 센다(원본 적재는 원래 기호를 남긴다)
// - 빌드된 계약 판에서 기본값 없는 필드가 쓴 쪽 레코드에 없으면 MISSING_FIELD 거절
// Avro 라이브러리(avsc)는 이 파일과 레지스트리 조회(schema-registry-source.ts)만 싣는다(@peaket/platform/stream-worker 하위 내보내기).
import avsc from 'avsc';
import type { Schema, Type, types } from 'avsc';
import { CONFLUENT_MAGIC_BYTE, MAX_SCHEMA_ID } from './avro.js';
import type { RejectReason } from './batch-consumer.js';
import { TransientError } from './keyed-consumer.js';

/** 레지스트리에 닿지 못하거나 쓸 수 없는 응답이 왔다(404 밖의 모든 조회 실패). 다시 시도할 장애다 */
export class SchemaUnavailableError extends TransientError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SchemaUnavailableError';
  }
}

/** 레지스트리가 그 스키마 ID를 모른다고 답했다(404). 그 레코드는 UNKNOWN_SCHEMA로 거절한다 */
export class UnknownSchemaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnknownSchemaError';
  }
}

/** 스키마 ID → 그 ID의 .avsc JSON. 404면 UnknownSchemaError, 그 밖의 실패는 SchemaUnavailableError */
export interface SchemaSource {
  byId(id: number): Promise<unknown>;
}

export type DecodeOutcome =
  | { kind: 'record'; schemaId: number; recordName: string; value: unknown; unrecognized: { field: string; symbol: string }[] }
  | { kind: 'rejected'; schemaId: number | null; reason: RejectReason };

export interface AvroReader {
  /** SchemaUnavailableError는 던진다(거절하지 않는다) */
  decode(topic: string, bytes: Uint8Array): Promise<DecodeOutcome>;
}

export interface AvroReaderOptions {
  source: SchemaSource;
  /** 작업자가 빌드된 계약 판의 .avsc(레코드 전체 이름으로 찾는다) */
  readerSchemas: readonly unknown[];
  /** 원본 적재: true면 원래 기호를 그대로 넘기고 세기만 한다 */
  keepUnknownSymbols?: boolean;
  onUnrecognized?: (u: { topic: string; record: string; field: string }) => void;
}

/** 모르는 열거 기호를 바꿔 넣는 값(docs/api/avro/README.md §3) */
export const UNRECOGNIZED_SYMBOL = 'UNRECOGNIZED';

/** 풀어 둔 쓴 쪽 스키마의 상한(레지스트리 조회 캐시와 같은 1,000개 [가정], ADR-0335 결정 3) */
const COMPILED_CACHE_SIZE = 1_000;

/** 스키마 JSON을 avsc 형으로 만든다. 읽을 수 없으면 던진다 */
export function compileAvroSchema(schema: unknown, registry: Record<string, Type> = {}): Type {
  return avsc.Type.forSchema(schema as Schema, { registry });
}

/** 가장 오래 쓰지 않은 것부터 빼는 작은 캐시(Map의 넣은 순서를 쓴다) */
export class LruCache<K, V> {
  readonly #map = new Map<K, V>();
  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`캐시 상한은 1 이상의 정수여야 한다: ${capacity}`);
  }
  get(k: K): V | undefined {
    if (!this.#map.has(k)) return undefined;
    const v = this.#map.get(k) as V;
    this.#map.delete(k);
    this.#map.set(k, v);
    return v;
  }
  set(k: K, v: V): void {
    this.#map.delete(k);
    this.#map.set(k, v);
    while (this.#map.size > this.capacity) this.#map.delete(this.#map.keys().next().value as K);
  }
  get size(): number {
    return this.#map.size;
  }
}

interface ReaderTypes {
  records: Map<string, types.RecordType>;
  enums: Map<string, ReadonlySet<string>>;
}

function readerTypesOf(schemas: readonly unknown[]): ReaderTypes {
  const records = new Map<string, types.RecordType>();
  const enums = new Map<string, ReadonlySet<string>>();
  for (const s of schemas) {
    // 스키마마다 따로 푼다(같은 이름의 형을 여러 파일이 가지면 한 저장소에서는 겹침 오류가 난다). 앞에 나온 것을 쓴다
    const registry: Record<string, Type> = {};
    compileAvroSchema(s, registry);
    for (const [name, t] of Object.entries(registry)) {
      if (t.typeName === 'record' || t.typeName === 'error') {
        if (!records.has(name)) records.set(name, t as types.RecordType);
      } else if (t.typeName === 'enum') {
        if (!enums.has(name)) enums.set(name, new Set((t as types.EnumType).symbols));
      }
    }
  }
  return { records, enums };
}

interface WalkState {
  readerTypes: ReaderTypes;
  keep: boolean;
  missing: boolean;
  unrecognized: { field: string; symbol: string }[];
}

const join = (path: string, name: string) => (path ? `${path}.${name}` : name);

/**
 * 쓴 쪽 형을 따라 값을 내려가며 모르는 열거 기호를 바꾸고(또는 세기만 하고) 빌드된 계약 판의 필수 필드가 있는지 본다.
 * field 경로는 점으로 이은 필드 이름이고 배열·맵·null 갈래는 번호 없이 적는다(BAT-220 계획 §11 2). 바꾼 값을 돌려준다
 */
function walk(t: Type, v: unknown, path: string, s: WalkState): unknown {
  switch (t.typeName) {
    case 'record':
    case 'error': {
      const rec = t as types.RecordType;
      const reader = t.name ? s.readerTypes.records.get(t.name) : undefined;
      if (reader) {
        const have = new Set(rec.fields.flatMap((f) => [f.name, ...(f.aliases ?? [])]));
        for (const rf of reader.fields) {
          if (rf.defaultValue() === undefined && !have.has(rf.name) && !(rf.aliases ?? []).some((a) => have.has(a))) s.missing = true;
        }
      }
      if (v === null || typeof v !== 'object') return v;
      const obj = v as Record<string, unknown>;
      for (const f of rec.fields) obj[f.name] = walk(f.type, obj[f.name], join(path, f.name), s);
      return obj;
    }
    case 'enum': {
      const known = t.name ? s.readerTypes.enums.get(t.name) : undefined;
      if (!known || typeof v !== 'string' || known.has(v)) return v;
      s.unrecognized.push({ field: path, symbol: v });
      return s.keep ? v : UNRECOGNIZED_SYMBOL;
    }
    case 'array': {
      if (!Array.isArray(v)) return v;
      const items = (t as types.ArrayType).itemsType;
      for (let i = 0; i < v.length; i += 1) v[i] = walk(items, v[i], path, s);
      return v;
    }
    case 'map': {
      if (v === null || typeof v !== 'object') return v;
      const values = (t as types.MapType).valuesType as Type;
      const obj = v as Record<string, unknown>;
      for (const k of Object.keys(obj)) obj[k] = walk(values, obj[k], path, s);
      return obj;
    }
    case 'union:unwrapped': {
      if (v === null) return v;
      const branch = (t as types.UnwrappedUnionType).types.find((b) => b.typeName !== 'null' && b.isValid(v));
      return branch ? walk(branch, v, path, s) : v;
    }
    case 'union:wrapped': {
      if (v === null || typeof v !== 'object') return v;
      const [key] = Object.keys(v as object);
      const branch = key === undefined ? undefined : (t as types.WrappedUnionType).types.find((b) => b.branchName === key);
      if (!branch || key === undefined) return v;
      const obj = v as Record<string, unknown>;
      obj[key] = walk(branch, obj[key], path, s);
      return obj;
    }
    default:
      return v;
  }
}

export function createAvroReader(o: AvroReaderOptions): AvroReader {
  const readerTypes = readerTypesOf(o.readerSchemas);
  const compiled = new LruCache<number, Type>(COMPILED_CACHE_SIZE);
  /** 같은 ID를 동시에 찾으면 조회 하나를 함께 기다린다. 끝나면(성공·실패 모두) 지운다 */
  const pending = new Map<number, Promise<Type>>();

  const writerType = (id: number): Promise<Type> => {
    const hit = compiled.get(id);
    if (hit) return Promise.resolve(hit);
    let p = pending.get(id);
    if (!p) {
      p = (async () => {
        let schema: unknown;
        try {
          schema = await o.source.byId(id);
        } catch (err) {
          if (err instanceof UnknownSchemaError || err instanceof SchemaUnavailableError) throw err;
          throw new SchemaUnavailableError(`스키마 ${id} 조회 실패`, { cause: err });
        }
        let t: Type;
        try {
          t = compileAvroSchema(schema);
        } catch (err) {
          throw new SchemaUnavailableError(`스키마 ${id}의 응답이 Avro 스키마로 읽히지 않는다`, { cause: err });
        }
        compiled.set(id, t);
        return t;
      })().finally(() => pending.delete(id));
      pending.set(id, p);
    }
    return p;
  };

  return {
    async decode(topic, bytes) {
      if (bytes.byteLength < 5 || bytes[0] !== CONFLUENT_MAGIC_BYTE) return { kind: 'rejected', schemaId: null, reason: 'DESERIALIZE' };
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const id = buf.readUInt32BE(1);
      if (id < 1 || id > MAX_SCHEMA_ID) return { kind: 'rejected', schemaId: null, reason: 'DESERIALIZE' };
      let t: Type;
      try {
        t = await writerType(id);
      } catch (err) {
        if (err instanceof UnknownSchemaError) return { kind: 'rejected', schemaId: id, reason: 'UNKNOWN_SCHEMA' };
        throw err;
      }
      let value: unknown;
      try {
        // 남는 바이트·모자란 바이트 모두 던진다(fromBuffer)
        value = t.fromBuffer(buf.subarray(5));
      } catch {
        return { kind: 'rejected', schemaId: id, reason: 'DESERIALIZE' };
      }
      const recordName = t.name ?? t.typeName;
      const state: WalkState = { readerTypes, keep: o.keepUnknownSymbols === true, missing: false, unrecognized: [] };
      value = walk(t, value, '', state);
      if (state.missing) return { kind: 'rejected', schemaId: id, reason: 'MISSING_FIELD' };
      for (const u of state.unrecognized) o.onUnrecognized?.({ topic, record: recordName, field: u.field });
      return { kind: 'record', schemaId: id, recordName, value, unrecognized: state.unrecognized };
    },
  };
}
