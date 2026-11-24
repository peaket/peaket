// inv-ingest 시작 파일(docs/streaming.md §6.4, LCH-240, F-04-10). HTTP는 상태 확인과 지표에만 연다.
// 명령: (없음) 작업자 · `migrate` 표·사용자 이전 · `purge` 보존이 지난 회차 파티션 지우기
import { Gauge, Registry } from '@prometheus-io/client';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPlatformLogger, kafkaAuthFromEnv, onSigterm, systemClock } from '@peaket/platform';
import { schemaRegistrySource } from '@peaket/platform/stream-worker';
import { CLICKHOUSE_WRITER, ClickHouseHttp } from './clickhouse.js';
import { eventDatesFromEnv } from './events.js';
import { migrateInv, type Topology } from './migrate.js';
import { purgeExpired } from './purge.js';
import { BatchRefResolver } from './refs.js';
import { INV_INGEST_WORKER, localSchemaSource, startInvIngest } from './worker.js';

type Env = Record<string, string | undefined>;
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export function loadInvConfig(env: Env) {
  const need = ['PEAKET_ENV', 'PEAKET_KAFKA_BROKERS', 'PEAKET_INV_CLICKHOUSE_URL', 'PEAKET_INV_EVENT_DATES_FILE'];
  const missing = need.filter((k) => !env[k] && !(k === 'PEAKET_INV_EVENT_DATES_FILE' && env.PEAKET_INV_EVENT_DATES));
  if (missing.length) throw new Error(`inv-ingest 설정이 비었다: ${missing.join(', ')}`);
  const local = env.PEAKET_ENV === 'local' || env.PEAKET_ENV === 'ci';
  if (!env.PEAKET_SCHEMA_REGISTRY_URL && !local) throw new Error('PEAKET_SCHEMA_REGISTRY_URL이 없다(레지스트리 없이 고정 스키마 ID로 읽는 것은 local·ci만)');
  const topology = (env.PEAKET_INV_CLICKHOUSE_TOPOLOGY ?? 'cluster') as Topology;
  if (topology !== 'single' && topology !== 'cluster') throw new Error(`PEAKET_INV_CLICKHOUSE_TOPOLOGY는 single·cluster만 받는다: ${topology}`);
  const passwords: Record<string, string> = {};
  if (env.PEAKET_INV_INGEST_PASSWORD) passwords.inv_ingest_password = env.PEAKET_INV_INGEST_PASSWORD;
  if (env.PEAKET_INV_READER_PASSWORD) passwords.inv_reader_password = env.PEAKET_INV_READER_PASSWORD;
  if (env.PEAKET_INV_PURGER_PASSWORD) passwords.inv_purger_password = env.PEAKET_INV_PURGER_PASSWORD;
  return {
    env: env.PEAKET_ENV!,
    pod: env.PEAKET_POD || 'inv-ingest-0',
    brokers: list(env.PEAKET_KAFKA_BROKERS),
    registryUrl: env.PEAKET_SCHEMA_REGISTRY_URL,
    clickhouseUrl: env.PEAKET_INV_CLICKHOUSE_URL!,
    clickhouseUser: env.PEAKET_INV_CLICKHOUSE_USER || CLICKHOUSE_WRITER,
    clickhousePassword: env.PEAKET_INV_CLICKHOUSE_PASSWORD ?? '',
    readerUrl: env.PEAKET_INV_READER_CLICKHOUSE_URL,
    readerUser: env.PEAKET_INV_READER_CLICKHOUSE_USER || 'inv_reader',
    readerPassword: env.PEAKET_INV_READER_CLICKHOUSE_PASSWORD ?? '',
    purgeUrl: env.PEAKET_INV_PURGE_CLICKHOUSE_URL || env.PEAKET_INV_CLICKHOUSE_URL!,
    purgeUser: env.PEAKET_INV_PURGE_CLICKHOUSE_USER || 'inv_purger',
    purgePassword: env.PEAKET_INV_PURGE_CLICKHOUSE_PASSWORD ?? '',
    topology,
    migrationsDir: env.PEAKET_INV_MIGRATIONS_DIR || here('../../../data/clickhouse/inv'),
    asnTablePath: env.PEAKET_INV_ASN_TABLE,
    eventDates: eventDatesFromEnv(env),
    passwords,
    port: Number(env.PEAKET_ADMIN_PORT || 9465),
  };
}

async function main(argv: string[], env: Env): Promise<void> {
  const c = loadInvConfig(env);
  const logger = createPlatformLogger({ service: INV_INGEST_WORKER, env: c.env, version: env.PEAKET_VERSION ?? '0.0.0', pod: c.pod, clock: systemClock, level: 'info' });
  if (argv[0] === 'migrate') {
    const ch = new ClickHouseHttp({ baseUrl: c.clickhouseUrl, user: env.PEAKET_INV_MIGRATION_USER || c.clickhouseUser, password: env.PEAKET_INV_MIGRATION_PASSWORD ?? c.clickhousePassword });
    const n = await migrateInv((sql) => ch.exec(sql), c.migrationsDir, c.topology, c.passwords);
    logger.info({ kind: 'inv-migrate', statements: n }, 'inv 표·사용자 이전 끝');
    return;
  }
  if (argv[0] === 'purge') {
    const ch = new ClickHouseHttp({ baseUrl: c.purgeUrl, user: c.purgeUser, password: c.purgePassword });
    const results = await purgeExpired({ clickhouse: ch, now: Date.now(), log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`) });
    logger.info({ kind: 'inv-purge', events: results.length, failed: results.filter((r) => r.result === 'FAILED').length }, '보존 파기 끝');
    if (results.some((r) => r.result === 'FAILED')) process.exitCode = 3;
    return;
  }
  const registry = new Registry();
  const lag = new Gauge({ name: 'inv_ingest_lag_seconds', help: '조사 적재 진행 표시와 지금 시각의 차(topic)', labelNames: ['topic'], registers: [registry] });
  const auth = kafkaAuthFromEnv(INV_INGEST_WORKER, env);
  const run = startInvIngest({
    env: c.env,
    pod: c.pod,
    brokers: c.brokers,
    ...(auth ? { auth } : {}),
    schemas: c.registryUrl ? schemaRegistrySource({ url: c.registryUrl, env: c.env }) : localSchemaSource(),
    clickhouse: new ClickHouseHttp({ baseUrl: c.clickhouseUrl, user: c.clickhouseUser, password: c.clickhousePassword }),
    eventDates: c.eventDates,
    asnTable: c.asnTablePath ? JSON.parse(readFileSync(c.asnTablePath, 'utf8')) : { version: 0, hosting: [], proxy: [] },
    refs: new BatchRefResolver({
      async get(ids) {
        // identity-svc gRPC 어댑터는 F-04-12가 붙인다(포트만 둔다)
        return ids.map((accountId) => ({ accountId, contactRefs: [], deviceRefs: [], identityConflicts: [] }));
      },
    }),
    clock: () => Date.now(),
    registry,
    logger,
  });
  if (c.readerUrl) {
    const reader = new ClickHouseHttp({ baseUrl: c.readerUrl, user: c.readerUser, password: c.readerPassword });
    const timer = setInterval(() => {
      void (async () => {
        const rows = await reader.rows<{ topic: string; at: string }>(`SELECT topic, max(ingested_at) AS at FROM inv.inv_ingest_progress GROUP BY topic`);
        const now = Date.now();
        for (const r of rows) lag.set({ topic: r.topic }, Math.max(0, (now - Date.parse(r.at)) / 1000));
      })().catch(() => undefined);
    }, 15_000);
    timer.unref?.();
  }
  let ready = false;
  const app = Fastify({ logger: false });
  app.get('/ready', async (_req, reply) => reply.code(ready ? 200 : 503).send(ready ? 'ok' : 'starting'));
  app.get('/metrics', async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));
  await app.listen({ host: '0.0.0.0', port: c.port });
  await run.started;
  ready = true;
  logger.info({ kind: 'inv-ingest-started' }, 'inv-ingest 시작');
  onSigterm(async () => {
    ready = false;
    await run.stop();
    await app.close();
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2), process.env).catch((err: unknown) => {
    process.stderr.write(`inv-ingest 시작 실패: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
