// ops-svc 릴레이 프로세스의 조립(BAT-360 OPS-290, ADR-0349 결정 5, ADR-0143 결정 3, payment-svc relay-app.ts와 같은 꼴).
// `ops-svc-outbox-relay` 배포(복제 2, 배포는 구간 5)의 Lease 리더 하나가 ops DB Outbox(설정 사건 control.settings)를 보내고 일 파티션 정비를 돈다.
// 연결(DB 둘·Kafka 생산자·Lease API)은 relay.ts가 만들어 넘기고 끝낸 뒤 닫는다. 시험(test-int)이 실제 의존성으로 그대로 부른다.
import { type Clock, type Database, type LeaseApi, type OutboxPublisher, type OutboxRelayProcess, type OutboxRelayProcessOptions, platformMaintenanceTasks, startOutboxRelayProcess, systemClock } from '@peaket/platform';

export const OPS_RELAY_SERVICE = 'ops-svc';

export interface OpsRelayOptions {
  /** 환경 값(기본 process.env). loadOutboxRelayProcessConfig가 읽는다 */
  env?: Record<string, string | undefined>;
  /** 시계(기본 systemClock). 일 파티션을 이 시계로 미리 만든다(설정 사건 Outbox 행 ID도 실제 시계다) */
  clock?: Clock;
  /** 릴레이 역할 DB(PEAKET_OUTBOX_DATABASE_URL, ops_outbox_relay: Outbox 읽기·sent_at 고치기만) */
  database: Database;
  /** 정비 역할 DB(PEAKET_MAINTENANCE_DATABASE_URL). Outbox 일 파티션 미리 만들기·지우기가 쓴다 */
  maintenanceDatabase: Database;
  /** Outbox 보내기(kafkaOutboxPublisher(producer)) */
  outboxPublisher: OutboxPublisher;
  /** 파드 안에서는 inClusterLeaseApi(config.leaseName) */
  leaseApi: LeaseApi;
  /** Lease 기간·갱신 한도·다시 시도(시험에서 줄인다) */
  lease?: OutboxRelayProcessOptions['lease'];
  /** 끝낼 때 정비 일을 기다리는 한도 */
  stopTimeoutMs?: number;
  logDestination?: NodeJS.WritableStream;
}

/**
 * 릴레이 프로세스를 띄운다: startOutboxRelayProcess({ service: 'ops-svc', 정비는 Outbox 일 파티션 일만 }).
 * 멱등 기록·보류 사건 지우기는 서비스 프로세스 몫이라 여기서 돌리지 않는다(ops DB 정비 역할 권한 밖). 리더 반복은 없다. 연결은 닫지 않는다(relay.ts의 몫).
 * @throws PlatformConfigError 릴레이 설정이 빠짐
 */
export async function startOpsRelay(o: OpsRelayOptions): Promise<OutboxRelayProcess> {
  const clock = o.clock ?? systemClock;
  return startOutboxRelayProcess({
    service: OPS_RELAY_SERVICE,
    env: o.env,
    clock,
    database: o.database,
    maintenanceDatabase: o.maintenanceDatabase,
    publisher: o.outboxPublisher,
    leaseApi: o.leaseApi,
    lease: o.lease,
    stopTimeoutMs: o.stopTimeoutMs,
    logDestination: o.logDestination,
    maintenanceTasks: platformMaintenanceTasks(o.maintenanceDatabase, clock).filter((task) => task.name.startsWith('outbox-partitions-')),
  });
}
