// payment-svc 릴레이 프로세스의 조립(BUILD_ORDER PRF-180, ADR-0116, purchase-svc relay-app.ts와 같은 꼴).
// `payment-svc-outbox-relay` 배포(복제 2)의 Lease 리더 하나가 trade.payments Outbox 릴레이와 정비 일(공용 Outbox 파티션과 웹훅 수신 기록 지우기, BUILD_ORDER HOT-150)을 돈다. 이 단계의 리더 반복은 없다(승인 실행기가 사건을 낸다, PRF-181).
// 연결(DB 둘·Kafka 생산자·Lease API)은 relay.ts가 만들어 넘기고 끝낸 뒤 닫는다. 시험(test-int)이 실제 의존성으로 그대로 부른다.
import { type Clock, type Database, type LeaseApi, type OutboxPublisher, type OutboxRelayProcess, type OutboxRelayProcessOptions, platformMaintenanceTasks, startOutboxRelayProcess, systemClock } from '@peaket/platform';
import { webhookReceiptsDeleteTask } from './modules/payment/adapters/db/drizzle-webhook-store.js';

export interface PaymentRelayOptions {
  /** 환경 값(기본 process.env). loadOutboxRelayProcessConfig가 읽는다 */
  env?: Record<string, string | undefined>;
  /** 시계(기본 systemClock) */
  clock?: Clock;
  /** 릴레이 역할 DB(PEAKET_OUTBOX_DATABASE_URL) */
  database: Database;
  /** 정비 역할 DB(PEAKET_MAINTENANCE_DATABASE_URL) */
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
 * 릴레이 프로세스를 띄운다: startOutboxRelayProcess({ service: 'payment-svc', maintenanceTasks: platformMaintenanceTasks(…) 가운데 Outbox 파티션 일 }).
 * 연결은 닫지 않는다(relay.ts의 몫).
 * @throws PlatformConfigError 릴레이 설정이 빠짐
 */
export async function startPaymentRelay(o: PaymentRelayOptions): Promise<OutboxRelayProcess> {
  const clock = o.clock ?? systemClock;
  return startOutboxRelayProcess({
    service: 'payment-svc',
    env: o.env,
    clock,
    database: o.database,
    maintenanceDatabase: o.maintenanceDatabase,
    publisher: o.outboxPublisher,
    leaseApi: o.leaseApi,
    lease: o.lease,
    stopTimeoutMs: o.stopTimeoutMs,
    logDestination: o.logDestination,
    // payment DB에 표가 있는 Outbox 파티션 일과 웹훅 수신 기록 지우기만 돈다(BUILD_ORDER HOT-150). 멱등 기록·보류 행·통계 스냅샷 표는 이 단계의 마이그레이션에 없어(payment §2 '만들지 않은 것') 돌리면 정비 시간마다 실패한다
    maintenanceTasks: [
      ...platformMaintenanceTasks(o.maintenanceDatabase, clock).filter((task) => task.name.startsWith('outbox-partitions-')),
      webhookReceiptsDeleteTask(o.maintenanceDatabase, clock),
    ],
  });
}
