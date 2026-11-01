// 서비스별 Outbox 릴레이 프로세스(openspec 변경 add-local-cluster-and-relay-deployment, ADR-0116 결정 1·2, BUILD_ORDER FND-110).
// - 배포: `<서비스>-outbox-relay` Deployment(복제 2)가 서비스와 같은 이미지를 다른 시작 명령으로 띄운다(deploy/charts/peaket-service)
// - Lease `<서비스>-outbox-relay`의 리더만 릴레이와 정비 반복(MaintenanceRunner)을 돈다. 리더가 아니면 지표만 잰다
// - 관리 포트로 /metrics(릴레이·정비·리더 지표)와 /ready(의존성을 부르지 않는다, D-T19)를 낸다
// - 끝낼 때: 보내던 묶음을 마치고(릴레이 멈춤) 정비를 멈춘 뒤 Lease를 놓는다. 그래서 대기 복제가 Lease 기간을 기다리지 않고 다음 시도에 잡는다
// DB·Kafka 생산자·Lease API는 부르는 쪽(서비스의 relay.ts)이 만들어 넘기고 끝낸 뒤 닫는다(네이티브 모듈을 이 파일이 싣지 않게)
import { Registry } from '@prometheus-io/client';
import Fastify from 'fastify';
import { systemClock, type Clock } from './clock.js';
import { loadPlatformConfig, PlatformConfigError } from './config.js';
import type { Database } from './database.js';
import { errorSummary } from './keyed-consumer.js';
import { LeaseElector, type LeaseApi, type LeaseElectorOptions } from './lease.js';
import { createPlatformLogger } from './log.js';
import { MaintenanceRunner, maintenanceMetrics, platformMaintenanceTasks, type MaintenanceTask } from './maintenance.js';
import { OutboxRelay, OutboxRelayMetrics, type OutboxPublisher } from './outbox-relay.js';

type Env = Record<string, string | undefined>;

export interface OutboxRelayProcessConfig {
  /** Lease 보유자 이름(PEAKET_POD, 쿠버네티스가 파드 이름을 넣는다) */
  pod: string;
  /** 릴레이 전용 DB 역할(`<서비스>_outbox_relay`) 주소(docs/data.md §4의 7번) */
  outboxDatabaseUrl: string;
  /** 정비 역할 주소. PgBouncer를 거치지 않는다(파티션 떼기·ANALYZE는 세션이 필요하다, ADR-0086) */
  maintenanceDatabaseUrl: string;
  kafkaBrokers: string[];
  /** `<서비스>-outbox-relay` */
  leaseName: string;
}

const BROKER = /^[A-Za-z0-9.-]+:\d{1,5}$/;

/** 릴레이 프로세스 기본값 [가정]: 끝낼 때 정비 일을 기다리는 한도. 보내기 상한(10초)과 함께 종료 대기 30초 안에 든다 */
export const RELAY_PROCESS_DEFAULTS = { stopTimeoutMs: 10_000 } as const;

/** 릴레이 프로세스 설정. 빠진 값은 이름을 모두 적어 한 번에 던진다(시작하지 않는다) */
export function loadOutboxRelayProcessConfig(service: string, env: Env): OutboxRelayProcessConfig {
  const names = ['PEAKET_POD', 'PEAKET_OUTBOX_DATABASE_URL', 'PEAKET_MAINTENANCE_DATABASE_URL', 'PEAKET_KAFKA_BROKERS'] as const;
  const missing = names.filter((n) => !env[n]?.trim());
  if (missing.length) throw new PlatformConfigError(`Outbox 릴레이 설정이 없다: ${missing.join(', ')}`);
  const kafkaBrokers = env.PEAKET_KAFKA_BROKERS!.split(',').map((s) => s.trim()).filter(Boolean);
  if (kafkaBrokers.length === 0 || !kafkaBrokers.every((b) => BROKER.test(b))) {
    throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS는 쉼표로 나눈 '호스트:포트' 목록이어야 한다: ${env.PEAKET_KAFKA_BROKERS}`);
  }
  return {
    pod: env.PEAKET_POD!.trim(),
    outboxDatabaseUrl: env.PEAKET_OUTBOX_DATABASE_URL!.trim(),
    maintenanceDatabaseUrl: env.PEAKET_MAINTENANCE_DATABASE_URL!.trim(),
    kafkaBrokers,
    leaseName: `${service}-outbox-relay`,
  };
}

export interface OutboxRelayProcessOptions {
  service: string;
  env?: Env;
  clock?: Clock;
  /** 릴레이 역할 DB(PEAKET_OUTBOX_DATABASE_URL) */
  database: Database;
  /** 정비 역할 DB(PEAKET_MAINTENANCE_DATABASE_URL) */
  maintenanceDatabase: Database;
  publisher: OutboxPublisher;
  /** 파드 안에서는 inClusterLeaseApi(config.leaseName) */
  leaseApi: LeaseApi;
  /** 정비 일. 기본은 플랫폼 공용 일(platformMaintenanceTasks)이다. 서비스 일을 더하려면 공용 일과 함께 넘긴다 */
  maintenanceTasks?: MaintenanceTask[];
  /** Lease 기간·갱신 한도·다시 시도(기본 LEASE_DEFAULTS. 시험에서 줄인다) */
  lease?: Pick<LeaseElectorOptions, 'leaseDurationMs' | 'renewDeadlineMs' | 'retryPeriodMs'>;
  /** 끝낼 때 정비 일을 기다리는 한도(기본 10초 [가정]). 넘으면 기다리지 않고 Lease를 놓는다(종료 대기 30초 안) */
  stopTimeoutMs?: number;
  logDestination?: NodeJS.WritableStream;
}

export interface OutboxRelayProcess {
  readonly config: OutboxRelayProcessConfig;
  readonly registry: Registry;
  isLeader(): boolean;
  /** 관리 포트를 연다(PEAKET_MANAGEMENT_PORT, 기본 9464) */
  listen(host?: string): Promise<{ managementPort: number }>;
  /** 보내던 묶음을 마치고 정비를 멈춘 뒤 Lease를 놓고 관리 포트를 닫는다. 두 번 불러도 된다 */
  stop(): Promise<void>;
}

export async function startOutboxRelayProcess(o: OutboxRelayProcessOptions): Promise<OutboxRelayProcess> {
  const env = o.env ?? process.env;
  const platform = loadPlatformConfig(env);
  const config = loadOutboxRelayProcessConfig(o.service, env);
  const clock = o.clock ?? systemClock;
  const logger = createPlatformLogger({
    service: o.service,
    env: platform.env,
    version: platform.version,
    az: env.PEAKET_AZ,
    pod: config.pod,
    clock,
    level: platform.logLevel,
    destination: o.logDestination,
  });
  const registry = new Registry();
  const relayMetrics = new OutboxRelayMetrics(registry, o.service);
  const label = { service: o.service };
  relayMetrics.isLeader.set(label, 0);

  // 정비 반복은 아래에서 만든다. 리더가 되는 순간 깨워 10분 [가정]을 기다리지 않게 한다
  let maintenance: MaintenanceRunner | undefined;
  const elector = new LeaseElector({
    api: o.leaseApi,
    identity: config.pod,
    clock,
    ...o.lease,
    // 리더 지표는 바뀌는 즉시 고친다(재는 반복 5초를 기다리지 않는다). 바뀜은 정규 로그 밖의 운영 줄로 남긴다
    onChange: (leader) => {
      relayMetrics.isLeader.set(label, leader ? 1 : 0);
      if (leader) maintenance?.wake();
      logger.info({ kind: 'outbox-relay', leader, lease: config.leaseName }, leader ? 'Outbox 릴레이 리더가 됐다' : 'Outbox 릴레이 리더를 놓았다');
    },
  });
  const relay = new OutboxRelay({
    database: o.database,
    publisher: o.publisher,
    leader: elector,
    clock,
    metrics: relayMetrics,
    onError: (err) => logger.warn({ kind: 'outbox-relay', err: errorSummary(err) }, 'Outbox 릴레이 묶음 실패(되돌리고 다시 한다)'),
  });
  const runner = new MaintenanceRunner({
    service: o.service,
    clock,
    leader: elector,
    tasks: o.maintenanceTasks ?? platformMaintenanceTasks(o.maintenanceDatabase, clock),
    metrics: maintenanceMetrics(registry, o.service),
    logger,
  });

  const management = Fastify({ logger: false });
  management.get('/metrics', async (_request, reply) => {
    void reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
  // 릴레이 프로세스에는 시작 작업이 없다. 떠서 관리 포트가 열렸으면 준비다(공유 의존성을 보지 않는다, ADR-0070)
  management.get('/ready', async () => ({ status: 'ready' }));
  // 생존 프로브: 이벤트 루프가 답하는지만 본다(architecture §5 '프로브 규칙')
  management.get('/livez', async () => ({ status: 'live' }));
  await management.ready();

  maintenance = runner;
  runner.start();
  elector.start();
  relay.start();
  logger.info({ kind: 'outbox-relay', lease: config.leaseName }, 'Outbox 릴레이 프로세스 시작');

  let stopping: Promise<void> | undefined;
  let listening = false;
  return {
    config,
    registry,
    isLeader: () => elector.isLeader(),
    async listen(host = '0.0.0.0') {
      if (!listening) {
        await management.listen({ port: platform.managementPort, host });
        listening = true;
      }
      const a = management.server.address();
      return { managementPort: typeof a === 'object' && a ? a.port : 0 };
    },
    stop() {
      stopping ??= (async () => {
        // 순서: 보내던 묶음 마치기와 정비 멈추기(멈춤 신호, 한도 10초 [가정])를 함께 → Lease 놓기(그 전까지는 Lease 반복이 계속 갱신한다)
        // → 관리 포트 닫기. 정비 일이 끝나기를 한없이 기다리면 Lease를 쥔 채 아무도 보내지 않다가 SIGKILL을 맞았다(코드 리뷰 2026-11-01)
        await Promise.all([relay.stop(), runner.stop({ timeoutMs: o.stopTimeoutMs ?? RELAY_PROCESS_DEFAULTS.stopTimeoutMs })]);
        await elector.stop();
        await management.close();
        logger.info({ kind: 'outbox-relay', lease: config.leaseName }, 'Outbox 릴레이 프로세스 끝');
      })();
      return stopping;
    },
  };
}
