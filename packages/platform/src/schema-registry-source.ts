// Confluent Schema Registry 'ID로 스키마 받기'(`GET /schemas/ids/{id}`) 하나만 하는 조회(ADR-0335 결정 2·3, docs/streaming.md §2.6 레지스트리 줄).
// - 주소: 운영·스테이징·데모는 https만, local·ci만 http도. 인증서 검증을 끄는 선택은 없다(Node fetch의 기본 검증 그대로). 3xx는 따라가지 않는다
// - 인증: Basic. 자격은 머리에만 싣고 로그·오류 글·주소·지표에 넣지 않는다
// - 캐시: 스키마 ID가 키, 성공한 조회만, 만료 없음, 상한 1,000개 [가정](가장 오래 쓰지 않은 것부터 뺀다), 같은 ID 동시 조회는 요청 하나
// - 실패 분류: 404만 UnknownSchemaError. 시간 한도(2초 [가정]) 초과·연결·TLS 오류·5xx·401·403·그 밖의 4xx·Avro로 읽히지 않는 응답·
//   1MiB [가정]를 넘는 응답은 SchemaUnavailableError(다시 시도할 장애)
import { MAX_SCHEMA_ID } from './avro.js';
import { LruCache, SchemaUnavailableError, UnknownSchemaError, compileAvroSchema, type SchemaSource } from './avro-reader.js';
import { PlatformConfigError } from './config.js';
import { createExternalHttpClient, type ExternalHttpClient } from './http-client.js';

export const SCHEMA_REGISTRY_DEFAULTS = {
  /** 처음 보는 ID 조회의 시간 한도 [가정](docs/streaming.md §2.6) */
  timeoutMs: 2_000,
  /** 캐시 상한 [가정](ADR-0335 결정 3) */
  cacheSize: 1_000,
  /** 응답 크기 상한 1MiB [가정](ADR-0335 결정 3) */
  maxResponseBytes: 1024 * 1024,
} as const;

/** http 주소를 받는 환경(그 밖의 환경은 https만) */
const PLAIN_HTTP_ENVS: readonly string[] = ['local', 'ci'];

export interface SchemaRegistrySourceOptions {
  /** 레지스트리 주소(경로 앞부분은 둘 수 있다. 사용자 정보·쿼리·조각은 안 된다) */
  url: string;
  /** PEAKET_ENV */
  env: string;
  /** Basic 인증 자격(Secrets Manager에서 받은 값, docs/streaming.md §2.3) */
  auth?: { user: string; password: string };
  timeoutMs?: number;
  cacheSize?: number;
  /** 시험용 바꿔 끼우기 */
  fetch?: typeof fetch;
}

/** 응답 몸을 상한까지만 읽는다. 넘으면 읽기를 멈추고 던진다 */
async function readLimited(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    throw new SchemaUnavailableError(`레지스트리 응답이 ${limit}바이트를 넘는다`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new SchemaUnavailableError(`레지스트리 응답이 ${limit}바이트를 넘는다`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 받은 몸을 .avsc JSON으로 바꾼다. Avro 스키마가 아니면(참조가 든 응답 포함, ADR-0335 '결과') 던진다 */
function schemaOf(body: string, id: number): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SchemaUnavailableError(`스키마 ${id}의 레지스트리 응답이 JSON이 아니다`);
  }
  const r = parsed as { schema?: unknown; schemaType?: unknown; references?: unknown };
  if (typeof parsed !== 'object' || parsed === null || typeof r.schema !== 'string') throw new SchemaUnavailableError(`스키마 ${id}의 레지스트리 응답에 schema 글이 없다`);
  if (r.schemaType !== undefined && r.schemaType !== 'AVRO') throw new SchemaUnavailableError(`스키마 ${id}가 Avro가 아니다`);
  if (Array.isArray(r.references) && r.references.length > 0) throw new SchemaUnavailableError(`스키마 ${id}에 참조(references)가 있어 읽지 않는다`);
  let schema: unknown;
  try {
    schema = JSON.parse(r.schema);
    compileAvroSchema(schema);
  } catch {
    throw new SchemaUnavailableError(`스키마 ${id}의 응답이 Avro 스키마로 읽히지 않는다`);
  }
  return schema;
}

/**
 * 레지스트리 조회 포트의 실제 구현(ADR-0335 결정 3).
 * @throws PlatformConfigError 주소가 틀렸거나 운영·스테이징·데모에서 https가 아니거나 자격 모양이 틀림(시작 실패). 글에 주소·자격을 넣지 않는다
 */
export function schemaRegistrySource(o: SchemaRegistrySourceOptions): SchemaSource {
  let base: URL;
  try {
    base = new URL(o.url);
  } catch {
    throw new PlatformConfigError('Schema Registry 주소가 URL이 아니다');
  }
  if (base.username || base.password || base.search || base.hash) throw new PlatformConfigError('Schema Registry 주소에 사용자 정보·쿼리·조각을 넣지 않는다(자격은 auth로 준다)');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && PLAIN_HTTP_ENVS.includes(o.env))) {
    throw new PlatformConfigError(`Schema Registry 주소는 https여야 한다(PEAKET_ENV=${o.env || '(없음)'}. local·ci만 http를 받는다)`);
  }
  let authorization: string | undefined;
  if (o.auth) {
    // RFC 7617: 사용자 이름에는 ':'가 들어가지 못한다. 값은 글에 넣지 않는다
    if (!o.auth.user || o.auth.user.includes(':') || !o.auth.password) throw new PlatformConfigError('Schema Registry 자격의 사용자 이름·비밀번호 모양이 틀렸다');
    authorization = `Basic ${Buffer.from(`${o.auth.user}:${o.auth.password}`, 'utf8').toString('base64')}`;
  }
  const timeoutMs = o.timeoutMs ?? SCHEMA_REGISTRY_DEFAULTS.timeoutMs;
  const cache = new LruCache<number, unknown>(o.cacheSize ?? SCHEMA_REGISTRY_DEFAULTS.cacheSize);
  const pending = new Map<number, Promise<unknown>>();
  const http: ExternalHttpClient = createExternalHttpClient({
    provider: 'schema-registry',
    baseUrl: base.toString(),
    timeoutCapMs: timeoutMs,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });

  const fetchOne = async (id: number): Promise<unknown> => {
    const headers: Record<string, string> = { accept: 'application/vnd.schemaregistry.v1+json, application/json' };
    if (authorization) headers.authorization = authorization;
    let res: Response;
    try {
      res = await http.request({ method: 'GET', path: '/schemas/ids/{id}', params: { id }, headers });
    } catch (err) {
      // 시간 초과(TimeoutError)·연결 거부·TLS 검증 실패 모두. 원인의 종류만 남긴다(글에 주소가 들 수 있다)
      const cause = err instanceof Error ? (err.cause as (Error & { code?: unknown }) | undefined) : undefined;
      const kind = typeof cause?.code === 'string' ? cause.code : (cause?.name ?? (err instanceof Error ? err.name : typeof err));
      throw new SchemaUnavailableError(`스키마 ${id} 조회가 레지스트리에 닿지 못했다(${kind})`);
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw new UnknownSchemaError(`레지스트리가 스키마 ${id}를 모른다(404)`);
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new SchemaUnavailableError(`스키마 ${id} 조회 응답이 ${res.status}이다`);
    }
    return schemaOf(await readLimited(res, SCHEMA_REGISTRY_DEFAULTS.maxResponseBytes), id);
  };

  return {
    byId(id) {
      if (!Number.isInteger(id) || id < 1 || id > MAX_SCHEMA_ID) return Promise.reject(new RangeError(`스키마 ID는 1~${MAX_SCHEMA_ID}의 정수여야 한다: ${id}`));
      const hit = cache.get(id);
      if (hit !== undefined) return Promise.resolve(hit);
      let p = pending.get(id);
      if (!p) {
        p = fetchOne(id)
          .then((schema) => {
            cache.set(id, schema);
            return schema;
          })
          .finally(() => pending.delete(id));
        pending.set(id, p);
      }
      return p;
    },
  };
}
