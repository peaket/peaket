// ops-rt 시작 파일(docs/streaming.md §1·§2.2·§2.7, OPS-160, F-04-1). HTTP는 상태 확인과 지표에만 연다.
// 명령: (없음) 작업자 · `migrate` rt 표·뷰 이전 · `backfill <끝말>` 다시 채우기(버리는 그룹, §4.7 1)
import { Registry } from '@prometheus-io/client';
import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import { createPlatformLogger, kafkaAuthFromEnv, onSigterm, systemClock } from '@peaket/platform';
import { CLICKHOUSE_WRITER, ClickHouseHttp } from './clickhouse.js';
import { migrateRt, type Topology } from './migrate.js';
import { loadReaderSchemas } from './schemas.js';
import { OPS_RT_WORKER, schemaRegistrySource, startOpsRt } from './worker.js';

type Env = Record<string, string | undefined>;

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export interface OpsRtConfig {
  env: string;
  pod: string;
  tradeBrokers: string[];
  telemetryBrokers: string[];
  registryUrl: string;
  registryAuth?: { user: string; password: string };
  clickhouseUrl: string;
  clickhouseUser: string;
  clickhousePassword: string;
  topology: Topology;
  probeEvents: Set<string>;
  avroDir: string;
  migrationsDir: string;
  port: number;
}

/** 빠진 값은 이름을 모두 적어 한 번에 던진다(시작하지 않는다) */
export function loadOpsRtConfig(env: Env): OpsRtConfig {
  const need = ['PEAKET_ENV', 'PEAKET_KAFKA_BROKERS', 'PEAKET_TELEMETRY_KAFKA_BROKERS', 'PEAKET_SCHEMA_REGISTRY_URL', 'PEAKET_RT_CLICKHOUSE_URL'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`ops-rt 설정이 비었다: ${missing.join(', ')}`);
  const topology = (env.PEAKET_RT_CLICKHOUSE_TOPOLOGY ?? 'cluster') as Topology;
  if (topology !== 'single' && topology !== 'cluster') throw new Error(`PEAKET_RT_CLICKHOUSE_TOPOLOGY는 single·cluster만 받는다: ${topology}`);
  return {
    env: env.PEAKET_ENV!,
    pod: env.PEAKET_POD || 'ops-rt-0',
    tradeBrokers: list(env.PEAKET_KAFKA_BROKERS),
    telemetryBrokers: list(env.PEAKET_TELEMETRY_KAFKA_BROKERS),
    registryUrl: env.PEAKET_SCHEMA_REGISTRY_URL!,
    ...(env.PEAKET_SCHEMA_REGISTRY_USER ? { registryAuth: { user: env.PEAKET_SCHEMA_REGISTRY_USER, password: env.PEAKET_SCHEMA_REGISTRY_PASSWORD ?? '' } } : {}),
    clickhouseUrl: env.PEAKET_RT_CLICKHOUSE_URL!,
    clickhouseUser: env.PEAKET_RT_CLICKHOUSE_USER || CLICKHOUSE_WRITER,
    clickhousePassword: env.PEAKET_RT_CLICKHOUSE_PASSWORD ?? '',
    topology,
    probeEvents: new Set(list(env.PEAKET_PROBE_EVENT_IDS).map((s) => s.toLowerCase())),
    avroDir: env.PEAKET_AVRO_DIR || here('../../../docs/api/avro'),
    migrationsDir: env.PEAKET_RT_MIGRATIONS_DIR || here('../../../data/clickhouse/rt'),
    port: Number(env.PEAKET_ADMIN_PORT || 9464),
  };
}

async function main(argv: string[], env: Env): Promise<void> {
  const c = loadOpsRtConfig(env);
  const logger = createPlatformLogger({ service: OPS_RT_WORKER, env: c.env, version: env.PEAKET_VERSION ?? '0.0.0', pod: c.pod, clock: systemClock, level: 'info' });
  const ch = new ClickHouseHttp({ baseUrl: c.clickhouseUrl, user: c.clickhouseUser, password: c.clickhousePassword });
  if (argv[0] === 'migrate') {
    const n = await migrateRt((sql) => ch.exec(sql), c.migrationsDir, c.topology);
    logger.info({ kind: 'rt-migrate', statements: n }, 'rt 표·뷰 이전 끝');
    return;
  }
  const registry = new Registry();
  const run = startOpsRt({
    env: c.env,
    pod: c.pod,
    tradeBrokers: c.tradeBrokers,
    telemetryBrokers: c.telemetryBrokers,
    ...(() => {
      const auth = kafkaAuthFromEnv(OPS_RT_WORKER, env);
      return auth ? { auth } : {};
    })(),
    schemas: schemaRegistrySource({ url: c.registryUrl, env: c.env, ...(c.registryAuth ? { auth: c.registryAuth } : {}) }),
    readerSchemas: loadReaderSchemas(c.avroDir),
    clickhouse: ch,
    probeEvents: c.probeEvents,
    registry,
    logger,
    ...(argv[0] === 'backfill' ? { backfillTag: argv[1] || String(Date.now()) } : {}),
  });
  let ready = false;
  const app = Fastify({ logger: false });
  app.get('/ready', async (_req, reply) => reply.code(ready ? 200 : 503).send(ready ? 'ok' : 'starting'));
  app.get('/metrics', async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));
  await app.listen({ host: '0.0.0.0', port: c.port });
  await run.started;
  ready = true;
  logger.info({ kind: 'ops-rt-started', backfill: argv[0] === 'backfill' }, 'ops-rt 시작');
  onSigterm(async () => {
    ready = false;
    await run.stop();
    await app.close();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), process.env).catch((err: unknown) => {
    process.stderr.write(`ops-rt 시작 실패: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
