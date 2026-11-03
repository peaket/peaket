// HTTP 문자열 값 바꾸기(openspec 변경 add-service-structure-and-request-checks 결정 2).
// 쿼리·경로·머리는 늘 문자열로 온다. 계약 스키마는 값 형식(정수·불리언·배열)을 그대로 적으므로, 검사 전에 그 부분의 JSON Schema를 보고
// 문자열을 바꾼다. Zod 파이프와 Fastify 경로 스키마가 같은 함수를 써서 두 길이 같은 값을 받는다.
// - 숫자는 JSON 숫자 문법만, 불리언은 true·false만 바꾼다. 맞지 않으면 문자열 그대로 두어 검사가 400을 낸다
// - 배열은 쉼표로 나눈다(머리는 RFC 9110 목록이라 낱값 앞뒤 공백을 지운다)
// - 같은 이름이 겹쳐 온 쿼리는 형과 관계없이 거절한다(ASVS v5.0.0-15.3.7)

export type HttpPart = 'querystring' | 'params' | 'headers';
export type JsonSchema = Record<string, unknown>;
export type CoerceResult = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const JSON_INTEGER = /^-?(?:0|[1-9]\d*)$/;

const isObject = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 스키마 안의 $ref(#/$defs/…, #/definitions/…)를 같은 문서에서 찾는다 */
function resolver(root: JsonSchema) {
  return (s: unknown): JsonSchema | undefined => {
    let cur = s;
    for (let i = 0; i < 16 && isObject(cur) && typeof cur.$ref === 'string'; i += 1) {
      const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(cur.$ref);
      const defs = m ? (root[m[1]!] as JsonSchema | undefined) : undefined;
      cur = defs?.[decodeURIComponent(m![2]!)];
    }
    return isObject(cur) ? cur : undefined;
  };
}

/** 한 칸이 받을 수 있는 형(anyOf·oneOf·allOf·형 목록·const·enum을 모은다) */
function typesOf(s: JsonSchema | undefined, resolve: (s: unknown) => JsonSchema | undefined, seen = new Set<JsonSchema>()): Set<string> {
  const out = new Set<string>();
  if (!s || seen.has(s)) return out;
  seen.add(s);
  const t = s.type;
  if (typeof t === 'string') out.add(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.add(x);
  const literal = (v: unknown) => out.add(v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v);
  if ('const' in s) literal(s.const);
  if (Array.isArray(s.enum)) for (const v of s.enum) literal(v);
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = s[k];
    if (Array.isArray(list)) for (const sub of list) for (const x of typesOf(resolve(sub), resolve, seen)) out.add(x);
  }
  return out;
}

/** 배열 칸의 낱값 스키마(anyOf 갈래 안의 배열도 본다) */
function itemsOf(s: JsonSchema | undefined, resolve: (s: unknown) => JsonSchema | undefined): JsonSchema | undefined {
  if (!s) return undefined;
  if (s.items !== undefined) return resolve(s.items);
  for (const k of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = s[k];
    if (Array.isArray(list)) {
      for (const sub of list) {
        const r = resolve(sub);
        if (r && typesOf(r, resolve).has('array')) return itemsOf(r, resolve);
      }
    }
  }
  return undefined;
}

function scalar(raw: string, types: Set<string>): unknown {
  // 문자열을 받는 칸이면 그대로 둔다(문자열이 이미 맞는 값이다)
  if (types.size === 0 || types.has('string')) return raw;
  if (types.has('integer') && JSON_INTEGER.test(raw)) return Number(raw);
  if (types.has('number') && JSON_NUMBER.test(raw)) return Number(raw);
  if (types.has('integer') && JSON_NUMBER.test(raw)) {
    // 1.0·1e2 같은 정수 값도 JSON에서는 정수다
    const n = Number(raw);
    if (Number.isInteger(n)) return n;
  }
  if (types.has('boolean') && (raw === 'true' || raw === 'false')) return raw === 'true';
  return raw;
}

function coerceValue(raw: string, s: JsonSchema | undefined, part: HttpPart, resolve: (s: unknown) => JsonSchema | undefined): unknown {
  const types = typesOf(s, resolve);
  if (types.has('array') && !types.has('string')) {
    const items = itemsOf(s, resolve);
    const itemTypes = typesOf(items, resolve);
    const parts = raw.split(',').map((p) => (part === 'headers' ? p.trim() : p));
    return parts.map((p) => scalar(p, itemTypes));
  }
  return scalar(raw, types);
}

export interface CoerceOptions {
  /** 머리 이름을 스키마의 칸 이름으로 바꾸고 스키마에 있는 칸만 넘긴다(Zod 파이프). 없으면 들어온 이름 그대로 모두 넘긴다(Fastify 경로 스키마) */
  pickSchemaKeys?: boolean;
}

/**
 * 그 부분(쿼리·경로·머리)의 JSON Schema로 바꾸기 함수를 만든다. 스키마는 한 번만 읽는다.
 * 들어온 값은 바꾸지 않고 사본을 돌려준다.
 */
export function httpValueCoercer(schema: JsonSchema, part: HttpPart, options: CoerceOptions = {}): (raw: unknown) => CoerceResult {
  const resolve = resolver(schema);
  const root = resolve(schema) ?? {};
  const props = isObject(root.properties) ? (root.properties as Record<string, unknown>) : {};
  // 들어온 이름(소문자) → 스키마의 칸 이름. 머리는 대소문자를 가리지 않는다(RFC 9110 §5.1)
  const byLower = new Map<string, string>();
  for (const k of Object.keys(props)) byLower.set(part === 'headers' ? k.toLowerCase() : k, k);

  return (raw: unknown): CoerceResult => {
    const input = isObject(raw) ? raw : {};
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(input)) {
      const key = byLower.get(part === 'headers' ? name.toLowerCase() : name);
      if (Array.isArray(value)) {
        // 쿼리의 같은 이름 겹침은 형과 관계없이 거절한다. 머리의 배열(set-cookie 등)은 스키마 밖이면 그대로 둔다
        if (part !== 'headers') return { ok: false, reason: `겹친 매개변수: ${name}` };
        if (key !== undefined) return { ok: false, reason: `겹친 머리: ${name}` };
        if (!options.pickSchemaKeys) out[name] = value;
        continue;
      }
      if (key === undefined) {
        if (!options.pickSchemaKeys) out[name] = value;
        continue;
      }
      const target = options.pickSchemaKeys ? key : name;
      out[target] = typeof value === 'string' ? coerceValue(value, resolve(props[key]), part, resolve) : value;
    }
    return { ok: true, value: out };
  };
}
