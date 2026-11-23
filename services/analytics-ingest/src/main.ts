// analytics-ingest 시작 파일(docs/streaming.md §1·§2.2·§2.7·§6, OPS-200·OPS-205, F-04-3). HTTP는 상태 확인과 지표에만 연다.
// 명령: (없음) 작업자 · `migrate` 브론즈 표 이전 · `backfill <끝말>` 다시 적재(버리는 그룹) · `coverage <토픽> <파티션> <처음> <끝>` 커버리지 대조
import { Counter, Registry } from '@prometheus-io/client';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { createPlatformLogger, kafkaAuthFromEnv, onSigterm, systemClock } from '@peaket/platform';
import { schemaRegistrySource } from '@peaket/platform/stream-worker';
import { CLICKHOUSE_WRITER, ClickHouseHttp } from './clickhouse.js';
import { coverageOf } from './coverage.js';
import { migrateRt, type Topology } from './migrate.js';
import { EventPseudonymizer, eventKeySourceFromEnv } from './pseudonym.js';
import { ANALYTICS_INGEST_WORKER, localSchemaSource, startAnalyticsIngest } from './worker.js';

type Env = Record<string, string | undefined>;
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export function loadIngestConfig(env: Env) {
  const need = ['PEAKET_ENV', 'PEAKET_KAFKA_BROKERS', 'PEAKET_TELEMETRY_KAFKA_BROKERS', 'PEAKET_ANALYTICS_CLICKHOUSE_URL'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`analytics-ingest 설정이 비었다: ${missing.join(', ')}`);
  const local = env.PEAKET_ENV === 'local' || env.PEAKET_ENV === 'ci';
  if (!env.PEAKET_SCHEMA_REGISTRY_URL && !local) throw new Error('PEAKET_SCHEMA_REGISTRY_URL이 없다(레지스트리 없이 고정 스키마 ID로 읽는 것은 local·ci만)');
  const topology = (env.PEAKET_ANALYTICS_CLICKHOUSE_TOPOLOGY ?? 'cluster') as Topology;
  if (topology !== 'single' && topology !== 'cluster') throw new Error(`PEAKET_ANALYTICS_CLICKHOUSE_TOPOLOGY는 single·cluster만 받는다: ${topology}`);
  return {
    env: env.PEAKET_ENV!,
    pod: env.PEAKET_POD || 'analytics-ingest-0',
    tradeBrokers: list(env.PEAKET_KAFKA_BROKERS),
    telemetryBrokers: list(env.PEAKET_TELEMETRY_KAFKA_BROKERS),
    registryUrl: env.PEAKET_SCHEMA_REGISTRY_URL,
    registryAuth: env.PEAKET_SCHEMA_REGISTRY_USER ? { user: env.PEAKET_SCHEMA_REGISTRY_USER, password: env.PEAKET_SCHEMA_REGISTRY_PASSWORD ?? '' } : undefined,
    clickhouseUrl: env.PEAKET_ANALYTICS_CLICKHOUSE_URL!,
    clickhouseUser: env.PEAKET_ANALYTICS_CLICKHOUSE_USER || CLICKHOUSE_WRITER,
    clickhousePassword: env.PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD ?? '',
    topology,
    probeEvents: new Set(list(env.PEAKET_PROBE_EVENT_IDS).map((s) => s.toLowerCase())),
    migrationsDir: env.PEAKET_BRONZE_MIGRATIONS_DIR || here('../../../data/clickhouse/bronze'),
    port: Number(env.PEAKET_ADMIN_PORT || 9464),
  };
}

async function main(argv: string[], env: Env): Promise<void> {
  const c = loadIngestConfig(env);
  const logger = createPlatformLogger({ service: ANALYTICS_INGEST_WORKER, env: c.env, version: env.PEAKET_VERSION ?? '0.0.0', pod: c.pod, clock: systemClock, level: 'info' });
  const ch = new ClickHouseHttp({ baseUrl: c.clickhouseUrl, user: c.clickhouseUser, password: c.clickhousePassword });
  if (argv[0] === 'migrate') {
    const n = await migrateRt((sql) => ch.exec(sql), c.migrationsDir, c.topology);
    logger.info({ kind: 'bronze-migrate', statements: n }, '브론즈 표 이전 끝');
    return;
  }
  if (argv[0] === 'coverage') {
    const [topic, partition, from, to] = argv.slice(1);
    if (!topic || !partition || !from || !to) throw new Error('coverage <토픽> <파티션> <처음 오프셋> <끝 오프셋>');
    const rows = async <T>(sql: string, params: Record<string, string>) => {
      const q = Object.fromEntries(Object.entries(params).map(([k, v]) => [`param_${k}`, v]));
      return (JSON.parse(await ch.exec(`${sql} FORMAT JSON`, q)) as { data: T[] }).data;
    };
    const r = await coverageOf({ rows }, { topic, partition: Number(partition), from: BigInt(from), to: BigInt(to) });
    process.stdout.write(`${JSON.stringify({ ...r, from: String(r.from), to: String(r.to), expected: String(r.expected), present: String(r.present), gaps: r.gaps.map((g) => [String(g.from), String(g.to)]) })}\n`);
    if (r.present < r.expected) process.exitCode = 3;
    return;
  }
  const registry = new Registry();
  const forbidden = new Counter({ name: 'analytics_forbidden_field_total', help: '금지 칸이 보여 버린 수(스키마 위반, analytics §3.3)', labelNames: ['record', 'field'], registers: [registry] });
  const loaded = new Counter({ name: 'analytics_bronze_rows_total', help: '브론즈에 실은 행 수', labelNames: ['table'], registers: [registry] });
  const rejected = new Counter({ name: 'analytics_bronze_rejected_total', help: '적재 거절 기록에 남긴 수(1건이라도 SEV3, streaming §6)', registers: [registry] });
  const auth = kafkaAuthFromEnv(ANALYTICS_INGEST_WORKER, env);
  const run = startAnalyticsIngest({
    env: c.env,
    pod: c.pod,
    tradeBrokers: c.tradeBrokers,
    telemetryBrokers: c.telemetryBrokers,
    ...(auth ? { auth } : {}),
    schemas: c.registryUrl ? schemaRegistrySource({ url: c.registryUrl, env: c.env, ...(c.registryAuth ? { auth: c.registryAuth } : {}) }) : localSchemaSource(),
    clickhouse: ch,
    pseudonyms: new EventPseudonymizer(eventKeySourceFromEnv(env)),
    probeEvents: c.probeEvents,
    registry,
    logger,
    signals: {
      // 칸 이름의 배열 자리 번호는 지워 이름표 수를 묶는다
      forbidden: (record, field) => forbidden.inc({ record, field: field.replace(/\[\d+\]/g, '[]') }),
      loaded: (table, n) => loaded.inc({ table }, n),
      rejected: (n) => rejected.inc(n),
    },
    ...(argv[0] === 'backfill' ? { backfillTag: argv[1] || String(Date.now()) } : {}),
  });
  let ready = false;
  const app = Fastify({ logger: false });
  app.get('/ready', async (_req, reply) => reply.code(ready ? 200 : 503).send(ready ? 'ok' : 'starting'));
  app.get('/metrics', async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));
  await app.listen({ host: '0.0.0.0', port: c.port });
  await run.started;
  ready = true;
  logger.info({ kind: 'analytics-ingest-started', backfill: argv[0] === 'backfill' }, 'analytics-ingest 시작');
  onSigterm(async () => {
    ready = false;
    await run.stop();
    await app.close();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), process.env).catch((err: unknown) => {
    process.stderr.write(`analytics-ingest 시작 실패: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
