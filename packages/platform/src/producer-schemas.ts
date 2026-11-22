// 생산자의 스키마 ID 설정 읽기와 시작 확인(ADR-0357 결정 4·5, docs/api/avro/README.md §3 '생산자 스키마 ID', ST-T16 ②, D-T39 ③, F-04-2).
// - 설정: 등록 Job이 쓴 ConfigMap schema-ids(키 schema-ids.json)를 차트가 /etc/peaket/schema-ids/에 붙이고, PEAKET_SCHEMA_IDS_FILE이 그 파일을 가리킨다.
//   파일이 없거나 읽지 못하거나 모양이 틀리면 모든 환경에서 시작하지 않는다
// - 시작 확인: 내는 주제마다 그 ID의 스키마를 레지스트리에서 받아(함께 묻는다, 시간 한도 2초 [가정]) 계약 판과 키 차례를 무시하고 견준다.
//   다르거나 404면 시작하지 않는다. 닿지 못하면 설정의 ID로 계속하고 경고 한 줄과 게이지 schema_startup_check_unavailable{subject} 1(SEV3).
//   준비 상태(readiness)에는 넣지 않는다. 주소가 없으면 local·ci만 건너뛰고(skipped) 다른 환경은 시작하지 않는다
// - 레지스트리 조회는 ADR-0335 결정 3의 schemaRegistrySource 그대로다(운영·스테이징·데모는 https만, 3xx 안 따름, 자격은 로그·오류 글에 넣지 않음)
import { readFileSync } from 'node:fs';
import { Gauge, type Registry } from '@prometheus-io/client';
import { parseSchemaIds } from './avro.js';
import { UnknownSchemaError, type SchemaSource } from './avro-reader.js';
import type { AvroEncoder } from './avro-encoder.js';
import { PlatformConfigError } from './config.js';
import { SCHEMA_REGISTRY_DEFAULTS, schemaRegistrySource } from './schema-registry-source.js';

/** 설정 파일을 가리키는 환경 값(ADR-0357 결정 4) */
export const SCHEMA_IDS_FILE_ENV = 'PEAKET_SCHEMA_IDS_FILE';
/** 차트가 ConfigMap schema-ids를 붙이는 자리(ADR-0357 결정 4) */
export const SCHEMA_IDS_MOUNT_DIR = '/etc/peaket/schema-ids';
/** 레지스트리 주소·자격(등록 Job과 같은 이름, ADR-0357 결정 5) */
export const SCHEMA_REGISTRY_URL_ENV = 'PEAKET_SCHEMA_REGISTRY_URL';
export const SCHEMA_REGISTRY_USER_ENV = 'PEAKET_SCHEMA_REGISTRY_USER';
export const SCHEMA_REGISTRY_PASSWORD_ENV = 'PEAKET_SCHEMA_REGISTRY_PASSWORD';
/** 주소가 없어도 확인을 건너뛰는 환경(그 밖은 시작하지 않는다) */
const SKIP_WITHOUT_URL_ENVS: readonly string[] = ['local', 'ci'];
/** 시작 확인 게이지 이름(docs/features/analytics.md §16) */
export const SCHEMA_STARTUP_CHECK_GAUGE = 'schema_startup_check_unavailable';

/**
 * PEAKET_SCHEMA_IDS_FILE의 schema-ids JSON(주제 → 스키마 ID)을 읽는다.
 * @throws PlatformConfigError 환경 값이 없거나 파일을 읽지 못하거나 모양이 틀림(시작 실패. 글에 파일 내용은 넣지 않는다)
 */
export function readSchemaIdsFile(env: Record<string, string | undefined>): Record<string, number> {
  const path = env[SCHEMA_IDS_FILE_ENV];
  if (!path) throw new PlatformConfigError(`${SCHEMA_IDS_FILE_ENV}가 없다(ConfigMap schema-ids의 schema-ids.json 경로, 차트가 ${SCHEMA_IDS_MOUNT_DIR}/에 붙인다)`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new PlatformConfigError(`${SCHEMA_IDS_FILE_ENV}가 가리키는 파일을 읽지 못했다(${(e as NodeJS.ErrnoException).code ?? 'read'})`);
  }
  try {
    return parseSchemaIds(text);
  } catch (e) {
    throw new PlatformConfigError(`schema-ids 파일이 틀렸다: ${(e as Error).message}`);
  }
}

/** 두 JSON 값이 키 차례를 빼고 같은가(배열은 차례까지 같아야 한다, ADR-0357 결정 5) */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameJson(x, b[i]));
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function startupGauge(registry: Registry): Gauge<'subject'> {
  const existing = registry.getSingleMetric(SCHEMA_STARTUP_CHECK_GAUGE) as Gauge<'subject'> | undefined;
  return existing ?? new Gauge({ name: SCHEMA_STARTUP_CHECK_GAUGE, help: '시작 때 레지스트리에 닿지 못해 설정의 스키마 ID로 낸 주제(1이면 SEV3, ADR-0357 결정 5)', labelNames: ['subject'] as const, registers: [registry] });
}

/** 주제 이름의 레코드 전체 이름(토픽에는 '-'가 들 수 있고 레코드 전체 이름에는 없다) */
const recordOf = (subject: string): string => subject.slice(subject.lastIndexOf('-') + 1);

export type ProducerSchemaCheckResult = 'ok' | 'unavailable' | 'skipped';

export interface CheckProducerSchemasOptions {
  /** PEAKET_ENV·PEAKET_SCHEMA_IDS_FILE·PEAKET_SCHEMA_REGISTRY_URL·_USER·_PASSWORD */
  env: Record<string, string | undefined>;
  encoder: AvroEncoder;
  /** 레코드 전체 이름 → 계약 판 스키마(@peaket/contracts/avro의 avroSchemas) */
  schemas: Readonly<Record<string, unknown>>;
  /** 주지 않으면 환경 값으로 schemaRegistrySource를 만든다(시험이 바꿔 끼운다) */
  registry?: SchemaSource;
  metrics: Registry;
  logger: { info(o: object): void; warn(o: object): void };
  /** 주제 하나의 조회 한도(기본 2초 [가정]) */
  timeoutMs?: number;
}

/**
 * 시작 확인(ADR-0357 결정 5). 결과는 주제마다 하나다.
 * @throws PlatformConfigError 레지스트리의 그 ID 스키마가 계약 판과 다름, 레지스트리가 그 ID를 모름(404), 주소가 없는데 local·ci가 아님, 주소·자격 모양이 틀림
 */
export async function checkProducerSchemas(o: CheckProducerSchemasOptions): Promise<{ subject: string; result: ProducerSchemaCheckResult }[]> {
  const envName = o.env.PEAKET_ENV ?? 'local';
  const ids = readSchemaIdsFile(o.env);
  const subjects = [...o.encoder.subjects];
  // 인코더를 만든 것과 같은 파일이라 늘 있다. 없으면 배포 순서 오류다(D-T39 ③)
  const unconfigured = subjects.filter((s) => ids[s] === undefined || o.schemas[recordOf(s)] === undefined);
  if (unconfigured.length > 0) throw new PlatformConfigError(`schema-ids나 계약 판에 없는 주제를 내려 한다: ${unconfigured.join(', ')}`);
  const gauge = startupGauge(o.metrics);
  let source = o.registry;
  if (!source) {
    const url = o.env[SCHEMA_REGISTRY_URL_ENV];
    if (!url) {
      if (!SKIP_WITHOUT_URL_ENVS.includes(envName)) throw new PlatformConfigError(`${SCHEMA_REGISTRY_URL_ENV}가 없다(PEAKET_ENV=${envName}. local·ci만 시작 확인을 건너뛴다)`);
      for (const subject of subjects) gauge.set({ subject }, 0);
      o.logger.info({ kind: 'schema-startup-check', subjects, result: 'skipped' });
      return subjects.map((subject) => ({ subject, result: 'skipped' as const }));
    }
    const user = o.env[SCHEMA_REGISTRY_USER_ENV];
    const password = o.env[SCHEMA_REGISTRY_PASSWORD_ENV];
    if ((user === undefined) !== (password === undefined)) throw new PlatformConfigError(`${SCHEMA_REGISTRY_USER_ENV}와 ${SCHEMA_REGISTRY_PASSWORD_ENV}는 함께 둔다`);
    source = schemaRegistrySource({
      url,
      env: envName,
      ...(user !== undefined && password !== undefined ? { auth: { user, password } } : {}),
      timeoutMs: o.timeoutMs ?? SCHEMA_REGISTRY_DEFAULTS.timeoutMs,
    });
  }
  const registry = source;
  const timeoutMs = o.timeoutMs ?? SCHEMA_REGISTRY_DEFAULTS.timeoutMs;

  type Outcome = { subject: string; kind: 'ok' | 'mismatch' | 'unknown' | 'unavailable' };
  const one = async (subject: string): Promise<Outcome> => {
    const id = ids[subject]!;
    const mine = o.schemas[recordOf(subject)];
    let timer: NodeJS.Timeout | undefined;
    try {
      const fetched = await Promise.race([
        registry.byId(id),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('시간 초과')), timeoutMs);
          timer.unref();
        }),
      ]);
      return { subject, kind: sameJson(fetched, mine) ? 'ok' : 'mismatch' };
    } catch (err) {
      if (err instanceof UnknownSchemaError) return { subject, kind: 'unknown' };
      return { subject, kind: 'unavailable' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const outcomes = await Promise.all(subjects.map(one));
  const mismatched = outcomes.filter((r) => r.kind === 'mismatch').map((r) => r.subject);
  const unknown = outcomes.filter((r) => r.kind === 'unknown').map((r) => r.subject);
  if (mismatched.length > 0) throw new PlatformConfigError(`레지스트리의 스키마가 계약 판과 다르다: ${mismatched.join(', ')}`);
  if (unknown.length > 0) throw new PlatformConfigError(`레지스트리가 설정의 스키마 ID를 모른다(404): ${unknown.join(', ')}`);
  return outcomes.map((r) => {
    if (r.kind === 'unavailable') {
      gauge.set({ subject: r.subject }, 1);
      o.logger.warn({ kind: 'schema-startup-check', subject: r.subject, result: 'unavailable' });
      return { subject: r.subject, result: 'unavailable' as const };
    }
    gauge.set({ subject: r.subject }, 0);
    return { subject: r.subject, result: 'ok' as const };
  });
}
