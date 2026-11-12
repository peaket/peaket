// Confluent Schema Registry 형식의 Avro 껍데기와 시작 때 스키마 ID 확인(docs/api/avro/README.md §3, docs/streaming.md §2.6, BUILD_ORDER BAS-030).
// 생산자는 실행 중에 레지스트리를 부르지 않는다: 설정(ConfigMap schema-ids)의 스키마 ID와 자기 계약 판의 스키마로 바이트를 직접 만든다.
// 시작할 때 한 번만 레지스트리에 닿아 그 ID의 스키마가 같은지 보고, 다르면 시작하지 않는다. 닿지 않으면 설정의 ID로 계속하고 경보를 낸다.

/** Confluent 형식의 첫 바이트(매직 바이트) */
export const CONFLUENT_MAGIC_BYTE = 0;
/** 스키마 ID의 위 끝(Avro/Confluent는 4바이트 빅 엔디언을 쓴다) */
export const MAX_SCHEMA_ID = 0x7fffffff;

const assertSchemaId = (id: number): void => {
  if (!Number.isInteger(id) || id < 1 || id > MAX_SCHEMA_ID) throw new RangeError(`스키마 ID는 1~${MAX_SCHEMA_ID}의 정수여야 한다: ${id}`);
};

/** Confluent 형식: 매직 바이트 0 + 스키마 ID 4바이트(빅 엔디언) + Avro 바이너리 */
export function encodeConfluent(schemaId: number, payload: Uint8Array): Buffer {
  assertSchemaId(schemaId);
  const out = Buffer.alloc(5 + payload.byteLength);
  out.writeUInt8(CONFLUENT_MAGIC_BYTE, 0);
  out.writeUInt32BE(schemaId, 1);
  Buffer.from(payload).copy(out, 5);
  return out;
}

/** Confluent 형식을 풀어 스키마 ID와 Avro 바이너리를 준다. 매직 바이트·길이가 틀리면 던진다 */
export function decodeConfluent(bytes: Uint8Array): { schemaId: number; payload: Buffer } {
  if (bytes.byteLength < 5) throw new Error('Confluent Avro 값이 5바이트보다 짧다');
  const buf = Buffer.from(bytes);
  if (buf.readUInt8(0) !== CONFLUENT_MAGIC_BYTE) throw new Error(`Confluent Avro 매직 바이트가 0이 아니다: ${buf.readUInt8(0)}`);
  return { schemaId: buf.readUInt32BE(1), payload: buf.subarray(5) };
}

/** ConfigMap schema-ids의 JSON(주제 → 스키마 ID)을 읽는다. 모르는 모양은 시작을 막는다 */
export function parseSchemaIds(text: string): Record<string, number> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`schema-ids가 JSON이 아니다: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('schema-ids는 주제 → 스키마 ID 객체여야 한다');
  const out: Record<string, number> = {};
  for (const [topic, id] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9._-]{1,249}$/.test(topic)) throw new Error(`schema-ids의 주제 이름이 틀렸다: ${topic}`);
    if (typeof id !== 'number') throw new Error(`schema-ids의 ${topic} 값이 숫자가 아니다`);
    assertSchemaId(id);
    out[topic] = id;
  }
  return out;
}

/** 내려는 주제가 모두 설정에 있어야 한다(없으면 배포 순서 오류라 시작하지 않는다, D-T39 ③) */
export function assertTopicsConfigured(produced: readonly string[], configured: Readonly<Record<string, number>>): void {
  const missing = produced.filter((t) => configured[t] === undefined);
  if (missing.length > 0) throw new Error(`schema-ids에 없는 주제를 내려 한다: ${missing.join(', ')}`);
}

export type StartupSchemaStatus = 'ok' | 'mismatch' | 'unavailable';

/**
 * 시작 때 스키마 ID 확인: 레지스트리에서 그 ID의 스키마를 받아 내 스키마와 견준다.
 * 다르면 mismatch(부르는 쪽이 시작을 막는다), 닿지 못하거나 시간을 넘기면 unavailable(설정의 ID로 계속하고 경보).
 */
export async function checkStartupSchema(i: {
  schemaId: number;
  schema: unknown;
  fetchById: (id: number) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<{ status: StartupSchemaStatus; fetched?: unknown }> {
  const timeoutMs = i.timeoutMs ?? 2_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const fetched = await Promise.race([
      i.fetchById(i.schemaId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`스키마 확인이 ${timeoutMs}ms를 넘겼다`)), timeoutMs);
      }),
    ]);
    const same = JSON.stringify(fetched) === JSON.stringify(i.schema);
    return { status: same ? 'ok' : 'mismatch', fetched };
  } catch {
    return { status: 'unavailable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** mismatch면 던지고, unavailable이면 경보를 남기고 계속한다. 준비 상태(readiness)에는 넣지 않는다 */
export async function assertStartupSchema(i: {
  schemaId: number;
  schema: unknown;
  fetchById: (id: number) => Promise<unknown>;
  timeoutMs?: number;
  warn?: (message: string) => void;
}): Promise<StartupSchemaStatus> {
  const r = await checkStartupSchema(i);
  if (r.status === 'mismatch') throw new Error(`레지스트리의 스키마 ${i.schemaId}가 내 계약 판과 다르다`);
  if (r.status === 'unavailable') i.warn?.(`레지스트리에 닿지 못해 schema-ids의 ${i.schemaId}로 계속한다`);
  return r.status;
}
