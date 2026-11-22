// 생산자의 공용 Avro 인코더(ADR-0357 결정 1·3·8, docs/api/avro/README.md §3 '생산자 스키마 ID', ADR-0150 결정 5, F-04-2).
// asyncapi 모양의 사건(날짜·시각은 ISO 글)을 받아 Confluent 형식(매직 바이트 0 + 스키마 ID 4바이트 + Avro 바이너리)으로 만든다.
// - 주제 이름은 <토픽>-<네임스페이스.레코드>(TopicRecordNameStrategy)이고 스키마 ID는 설정(schema-ids)에서 찾는다. 실행 중에 레지스트리를 부르지 않는다
// - date-time 글은 timestamp-millis 칸에서 밀리초로, date 글은 date 칸에서 날 수로 바꾼다(사건을 만드는 코드가 바꾸지 않는다)
// - 계약에 없는 칸은 쓰지 않는다(스키마의 칸만 옮긴다)
// - 필수 칸이 비었거나, x-present-when 조건이 맞는데 값이 없거나, 열거 값이 UNRECOGNIZED이거나 기호 목록 밖이면 바이트를 만들지 않고 AvroEncodeError
//   (레코드 이름과 칸 경로만 싣고 값은 싣지 않는다)
// avsc는 이 파일과 Avro 읽기(avro-reader.ts)만 싣는다(@peaket/platform/avro·stream-worker 하위 내보내기, ADR-0335 결정 1을 ADR-0357 결정 1이 넓힘).
import avsc from 'avsc';
import type { Schema, Type } from 'avsc';
import { encodeConfluent } from './avro.js';
import { PlatformConfigError } from './config.js';

/** 사건을 Avro로 만들지 못했다. 글·칸에는 레코드 이름과 칸 경로만 있고 사건의 값은 없다 */
export class AvroEncodeError extends Error {
  readonly record: string;
  readonly fields: readonly string[];
  constructor(record: string, fields: readonly string[], why = '계약을 채우지 못했다') {
    super(`${record} 사건을 Avro로 만들지 못했다(${why})${fields.length > 0 ? `: 칸 ${fields.join(', ')}` : ''}`);
    this.name = 'AvroEncodeError';
    this.record = record;
    this.fields = Object.freeze([...fields]);
  }
}

export interface AvroEncoder {
  /** 이 인코더가 낼 수 있는 주제(<토픽>-<레코드 전체 이름>) */
  readonly subjects: readonly string[];
  /**
   * @param record 레코드 전체 이름(예: peaket.trade.OrderEvent)
   * @throws AvroEncodeError 계약을 채우지 못했거나 만들 때 받지 않은 주제
   */
  encode(topic: string, record: string, message: object): Buffer;
}

export interface AvroEncoderOptions {
  /** 주제 → 스키마 ID(readSchemaIdsFile) */
  schemaIds: Readonly<Record<string, number>>;
  /** 레코드 전체 이름 → 계약 판 .avsc JSON(@peaket/contracts/avro의 avroSchemas) */
  schemas: Readonly<Record<string, unknown>>;
  /** 이 서비스가 내는 (토픽, 레코드) */
  produces: readonly { topic: string; record: string }[];
}

/** 주제 이름(docs/api/avro/README.md §3). @peaket/contracts/avro의 avroSubject와 같은 식이다 */
export const subjectOf = (topic: string, record: string): string => `${topic}-${record}`;

/** 열거마다 읽는 쪽 전용 기호(생산자는 내지 않는다, docs/api/avro/README.md §3 '열거 기호 더하기') */
const UNRECOGNIZED = 'UNRECOGNIZED';
const PRIMITIVES = new Set(['null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string']);
const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** RFC 3339 날짜·시각(시간대 필수). Date.parse가 받는 다른 꼴(시간대 없는 글 등)은 받지 않는다 */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

type Node = string | Node[] | { [k: string]: unknown };

interface Named {
  /** 이름 붙은 형(record·enum·fixed)의 전체 이름 → 정의 */
  readonly byName: Map<string, { [k: string]: unknown }>;
}

const fullNameOf = (name: string, namespace: string | undefined): string => (name.includes('.') ? name : namespace ? `${namespace}.${name}` : name);

/** 스키마 JSON에서 이름 붙은 형을 모두 모은다(네임스페이스는 안쪽으로 이어진다) */
function collectNamed(node: unknown, namespace: string | undefined, out: Map<string, { [k: string]: unknown }>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectNamed(n, namespace, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const o = node as { [k: string]: unknown };
  let ns = namespace;
  if ((o.type === 'record' || o.type === 'error' || o.type === 'enum' || o.type === 'fixed') && typeof o.name === 'string') {
    const full = fullNameOf(o.name, typeof o.namespace === 'string' ? o.namespace : namespace);
    out.set(full, o);
    ns = full.includes('.') ? full.slice(0, full.lastIndexOf('.')) : undefined;
  }
  if (Array.isArray(o.fields)) for (const f of o.fields as { type?: unknown }[]) collectNamed(f.type, ns, out);
  if (o.items !== undefined) collectNamed(o.items, ns, out);
  if (o.values !== undefined) collectNamed(o.values, ns, out);
  if (typeof o.type === 'object') collectNamed(o.type, ns, out);
}

/** 칸 경로 잇기(avro-reader.ts와 같은 꼴: 점으로 잇고 배열·맵 번호는 적지 않는다) */
const join = (path: string, name: string) => (path ? `${path}.${name}` : name);

interface Walk {
  readonly named: Named;
  /** 채우지 못한 칸 경로(값은 적지 않는다) */
  readonly bad: Set<string>;
}

/** 조건 값 하나가 맞는가. 값이 없으면 그 칸의 기본값으로 본다(참·거짓 칸의 기본값 false) */
function conditionHolds(cond: Record<string, unknown>, obj: Record<string, unknown>, defaults: Map<string, unknown>): boolean {
  for (const [k, allowed] of Object.entries(cond)) {
    if (!Array.isArray(allowed)) return false;
    const v = obj[k] === undefined ? defaults.get(k) : obj[k];
    if (!allowed.some((a) => a === v)) return false;
  }
  return true;
}

const isEmpty = (v: unknown): boolean => v === undefined || v === null;

/** 사건 값(asyncapi 모양)을 스키마 형으로 옮긴다. 옮기지 못한 칸은 s.bad에 경로만 남기고 undefined를 돌려준다 */
function convert(node: Node, v: unknown, path: string, ns: string | undefined, s: Walk): unknown {
  if (typeof node === 'string') {
    if (PRIMITIVES.has(node)) return primitive(node, undefined, v, path, s);
    const def = s.named.byName.get(fullNameOf(node, ns)) ?? s.named.byName.get(node);
    if (!def) {
      s.bad.add(path || '(값)');
      return undefined;
    }
    return convert(def, v, path, ns, s);
  }
  if (Array.isArray(node)) return union(node, v, path, ns, s);
  const t = node.type;
  if (typeof t === 'object' && t !== null) return convert(t as Node, v, path, ns, s);
  switch (t) {
    case 'record':
    case 'error': {
      const full = fullNameOf(String(node.name), typeof node.namespace === 'string' ? node.namespace : ns);
      const inner = full.includes('.') ? full.slice(0, full.lastIndexOf('.')) : undefined;
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        s.bad.add(path || full);
        return undefined;
      }
      const obj = v as Record<string, unknown>;
      const fields = (node.fields ?? []) as { name: string; type: Node; default?: unknown; 'x-present-when'?: unknown }[];
      const defaults = new Map<string, unknown>(fields.filter((f) => 'default' in f).map((f) => [f.name, f.default]));
      const out: Record<string, unknown> = {};
      for (const f of fields) {
        const p = join(path, f.name);
        const raw = obj[f.name];
        const when = f['x-present-when'];
        if (isEmpty(raw)) {
          if (Array.isArray(when) && when.some((c) => c !== null && typeof c === 'object' && conditionHolds(c as Record<string, unknown>, obj, defaults))) {
            s.bad.add(p);
            continue;
          }
          if ('default' in f) {
            out[f.name] = f.default;
            continue;
          }
          // 기본값 없는 칸은 필수다(ADR-0150). null 갈래가 있어도 기본값이 없으면 비울 수 없다
          s.bad.add(p);
          continue;
        }
        out[f.name] = convert(f.type, raw, p, inner, s);
      }
      return out;
    }
    case 'enum': {
      const symbols = (node.symbols ?? []) as string[];
      if (typeof v !== 'string' || v === UNRECOGNIZED || !symbols.includes(v)) {
        s.bad.add(path || String(node.name));
        return undefined;
      }
      return v;
    }
    case 'array': {
      if (!Array.isArray(v)) {
        s.bad.add(path);
        return undefined;
      }
      return v.map((x) => convert(node.items as Node, x, path, ns, s));
    }
    case 'map': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        s.bad.add(path);
        return undefined;
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = convert(node.values as Node, x, path, ns, s);
      return out;
    }
    case 'fixed': {
      if (!Buffer.isBuffer(v) && !(v instanceof Uint8Array)) {
        s.bad.add(path);
        return undefined;
      }
      return Buffer.from(v);
    }
    default:
      if (typeof t === 'string' && PRIMITIVES.has(t)) return primitive(t, typeof node.logicalType === 'string' ? node.logicalType : undefined, v, path, s);
      s.bad.add(path || '(값)');
      return undefined;
  }
}

function union(branches: Node[], v: unknown, path: string, ns: string | undefined, s: Walk): unknown {
  const nonNull = branches.filter((b) => b !== 'null');
  if (isEmpty(v)) {
    if (nonNull.length !== branches.length) return null;
    s.bad.add(path);
    return undefined;
  }
  if (nonNull.length === 1) return convert(nonNull[0]!, v, path, ns, s);
  // 갈래가 여럿이면 처음으로 칸을 모두 채우는 갈래를 쓴다(값을 넘기는 쪽은 갈래 이름을 감싸지 않는다)
  for (const b of nonNull) {
    const trial: Walk = { named: s.named, bad: new Set() };
    const out = convert(b, v, path, ns, trial);
    if (trial.bad.size === 0) return out;
  }
  s.bad.add(path);
  return undefined;
}

function primitive(type: string, logical: string | undefined, v: unknown, path: string, s: Walk): unknown {
  const fail = (): undefined => {
    s.bad.add(path || type);
    return undefined;
  };
  switch (type) {
    case 'null':
      return v === null || v === undefined ? null : fail();
    case 'boolean':
      return typeof v === 'boolean' ? v : fail();
    case 'int':
    case 'long': {
      if (logical === 'timestamp-millis' || logical === 'local-timestamp-millis') {
        if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : fail();
        if (typeof v === 'string') {
          if (!DATE_TIME.test(v)) return fail();
          const ms = Date.parse(v);
          return Number.isSafeInteger(ms) ? ms : fail();
        }
        return typeof v === 'number' && Number.isSafeInteger(v) ? v : fail();
      }
      if (logical === 'date' && typeof v === 'string') {
        const m = DATE.exec(v);
        if (!m) return fail();
        const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        // 2026-02-30 같은 없는 날을 막는다
        if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== v) return fail();
        return ms / DAY_MS;
      }
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return fail();
      if (type === 'int' && (v < -(2 ** 31) || v > 2 ** 31 - 1)) return fail();
      return v;
    }
    case 'float':
    case 'double':
      return typeof v === 'number' && Number.isFinite(v) ? v : fail();
    case 'bytes':
      return Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v) : fail();
    case 'string':
      return typeof v === 'string' ? v : fail();
    default:
      return fail();
  }
}

interface Compiled {
  readonly schemaId: number;
  readonly record: string;
  readonly schema: Node;
  readonly named: Named;
  readonly type: Type;
}

/**
 * 공용 Avro 인코더를 만든다(ADR-0357 결정 1·3).
 * @throws PlatformConfigError 내는 주제가 설정(schema-ids)에 없거나 그 레코드의 계약 판 스키마가 없거나 읽히지 않음(시작 실패, D-T39 ③)
 */
export function createAvroEncoder(o: AvroEncoderOptions): AvroEncoder {
  const bySubject = new Map<string, Compiled>();
  const missing: string[] = [];
  for (const { topic, record } of o.produces) {
    const subject = subjectOf(topic, record);
    if (bySubject.has(subject)) continue;
    const schemaId = o.schemaIds[subject];
    if (schemaId === undefined) {
      missing.push(subject);
      continue;
    }
    const schema = o.schemas[record];
    if (schema === undefined || schema === null || typeof schema !== 'object') throw new PlatformConfigError(`계약 판에 ${record} 스키마가 없다`);
    let type: Type;
    try {
      // 갈래가 여럿인 유니온도 감싸지 않은 값으로 받는다(옮긴 값이 이미 그 갈래의 모양이다)
      type = avsc.Type.forSchema(schema as Schema, { wrapUnions: 'never' });
    } catch {
      throw new PlatformConfigError(`계약 판의 ${record} 스키마가 Avro로 읽히지 않는다`);
    }
    if (type.name !== record) throw new PlatformConfigError(`계약 판의 ${record} 스키마 이름이 ${type.name ?? '(없음)'}이다`);
    const byName = new Map<string, { [k: string]: unknown }>();
    collectNamed(schema, undefined, byName);
    bySubject.set(subject, { schemaId, record, schema: schema as Node, named: { byName }, type });
  }
  if (missing.length > 0) throw new PlatformConfigError(`schema-ids에 없는 주제를 내려 한다: ${missing.join(', ')}`);

  return {
    subjects: Object.freeze([...bySubject.keys()]),
    encode(topic, record, message) {
      const c = bySubject.get(subjectOf(topic, record));
      if (!c) throw new AvroEncodeError(record, [], `이 인코더가 내지 않는 주제 ${subjectOf(topic, record)}`);
      const walk: Walk = { named: c.named, bad: new Set() };
      const value = convert(c.schema, message, '', undefined, walk);
      if (walk.bad.size > 0) throw new AvroEncodeError(record, [...walk.bad]);
      let payload: Buffer;
      try {
        payload = c.type.toBuffer(value);
      } catch {
        // 옮긴 값이 형과 맞지 않는 남은 경우(예: 기본값이 형과 다름). 경로만 모은다
        const paths = new Set<string>();
        c.type.isValid(value, { errorHook: (p: string[]) => void paths.add(p.join('.') || record) });
        throw new AvroEncodeError(record, paths.size > 0 ? [...paths] : []);
      }
      return encodeConfluent(c.schemaId, payload);
    },
  };
}
