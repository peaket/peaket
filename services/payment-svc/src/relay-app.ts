// payment-svc 릴레이 프로세스의 조립(BUILD_ORDER PRF-180, ADR-0116, purchase-svc relay-app.ts와 같은 꼴).
// `payment-svc-outbox-relay` 배포(복제 2)의 Lease 리더 하나가 trade.payments Outbox 릴레이와 정비 일(공용 Outbox 파티션과 웹훅 수신 기록 지우기, BUILD_ORDER HOT-150)을 돈다. 이 단계의 리더 반복은 없다(승인 실행기가 사건을 낸다, PRF-181).
// 연결(DB 둘·Kafka 생산자·Lease API)은 relay.ts가 만들어 넘기고 끝낸 뒤 닫는다. 시험(test-int)이 실제 의존성으로 그대로 부른다.
import { type Clock, type Database, type DatabaseOptions, type LeaseApi, type OutboxPublisher, type OutboxRelayProcess, type OutboxRelayProcessOptions, platformMaintenanceTasks, startOutboxRelayProcess, systemClock } from '@peaket/platform';
import { depositSecretHashDeleteTask, DrizzleReconciliation, reconSeenDeleteTask } from './modules/payment/adapters/db/drizzle-reconciliation.js';
import { DrizzleConfirmJobs } from './modules/payment/adapters/db/drizzle-confirm-jobs.js';
import { entryTrialsDeleteTask } from './modules/payment/adapters/db/drizzle-entry-pause.js';
import { webhookReceiptsDeleteTask } from './modules/payment/adapters/db/drizzle-webhook-store.js';
import { paymentReconciliationLog } from './modules/payment/adapters/payment-reconciliation-log.js';
import { PromPaymentReconciliationSignals } from './modules/payment/adapters/prom-payment-reconciliation-signals.js';
import { PaymentReconciliation } from './modules/payment/application/payment-reconciliation.js';
import type { OnSaleCalendar, PaymentGateways } from './modules/payment/domain/ports.js';
import { RECONCILIATION_TASK } from './modules/payment/domain/reconciliation.js';

/** 대사·입금 해시 지우기가 쓰는 서비스 역할 DB 풀의 연결 수 2개 [가정](정비 일은 차례로 돌아 동시에 쓰는 문장이 많지 않다) */
const RELAY_SERVICE_DB_MAX = 2;

/** 서비스 역할 DB(PEAKET_DATABASE_URL) 풀 설정(relay.ts가 createDatabase에 넘긴다). 일반 풀 모양이라 연결을 기다린다(purchase-svc 릴레이와 같은 꼴, BUILD_ORDER HOT-153 코드 리뷰 M14) */
export function relayServiceDatabaseOptions(url: string): DatabaseOptions {
  return { url, profile: 'general', max: RELAY_SERVICE_DB_MAX, applicationName: 'payment-svc-relay-service' };
}

export interface PaymentRelayOptions {
  /** 환경 값(기본 process.env). loadOutboxRelayProcessConfig가 읽는다 */
  env?: Record<string, string | undefined>;
  /** 시계(기본 systemClock) */
  clock?: Clock;
  /** 릴레이 역할 DB(PEAKET_OUTBOX_DATABASE_URL) */
  database: Database;
  /** 정비 역할 DB(PEAKET_MAINTENANCE_DATABASE_URL). 공용 Outbox 파티션 일과 웹훅 수신 기록 지우기가 쓴다 */
  maintenanceDatabase: Database;
  /** 서비스 역할 DB(PEAKET_DATABASE_URL, relayServiceDatabaseOptions). 대사(원장·이력·Outbox를 쓴다)와 입금 해시·작업 표 지우기가 쓴다(서비스 자신의 업무 데이터, BUILD_ORDER HOT-153 코드 리뷰 M14) */
  serviceDatabase: Database;
  /** Outbox 보내기(kafkaOutboxPublisher(producer)) */
  outboxPublisher: OutboxPublisher;
  /** 파드 안에서는 inClusterLeaseApi(config.leaseName) */
  leaseApi: LeaseApi;
  /** Lease 기간·갱신 한도·다시 시도(시험에서 줄인다) */
  lease?: OutboxRelayProcessOptions['lease'];
  /** 끝낼 때 정비 일을 기다리는 한도 */
  stopTimeoutMs?: number;
  logDestination?: NodeJS.WritableStream;
  /** 일일 대사의 결제사 어댑터(BUILD_ORDER HOT-153). 없으면 대사 정비 일을 돌리지 않는다 */
  gateways?: PaymentGateways;
  /** 대형·중형 온세일 윈도우(BUILD_ORDER HOT-153). 일정 파일을 읽는 부품이 아직 없다(payment §8): 없으면 운영(PEAKET_ENV=prod)은 대사를 켜지 않고, 그 밖의 환경은 일정 없음으로 돈다(코드 리뷰 M10) */
  onSaleCalendar?: OnSaleCalendar;
  /** 대사 실행 행에 적는 소유자(relay.ts는 config.pod). 기본 payment-svc-relay */
  holder?: string;
}

/** 온세일 일정을 모를 때의 일정: 윈도우가 없다 */
const NO_ONSALE_CALENDAR: OnSaleCalendar = { active: async () => false };

/**
 * 릴레이 프로세스를 띄운다: startOutboxRelayProcess({ service: 'payment-svc', maintenanceTasks: platformMaintenanceTasks(…) 가운데 Outbox 파티션 일 }).
 * 연결은 닫지 않는다(relay.ts의 몫).
 * @throws PlatformConfigError 릴레이 설정이 빠짐
 */
export async function startPaymentRelay(o: PaymentRelayOptions): Promise<OutboxRelayProcess> {
  const clock = o.clock ?? systemClock;
  // 대사 실행기는 프로세스의 로거·레지스트리가 필요해 리더 반복 자리에서 만들고 정비 일이 부른다(반복은 만들지 않는다)
  let reconciliation: PaymentReconciliation | undefined;
  const peaketEnv = (o.env ?? process.env).PEAKET_ENV;
  const calendarMissingInProd = o.onSaleCalendar === undefined && peaketEnv === 'prod';
  const reconciliationOn = o.gateways !== undefined && !calendarMissingInProd;
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
    leaderLoops: ({ registry, logger }) => {
      if (o.gateways !== undefined && calendarMissingInProd) logger.warn({ kind: 'payment-reconciliation-calendar' }, '온세일 일정 파일을 읽는 부품이 아직 없어 운영에서는 대사를 켜지 않는다(payment §8)');
      if (o.gateways !== undefined && reconciliationOn) {
        if (o.onSaleCalendar === undefined) logger.warn({ kind: 'payment-reconciliation-calendar' }, '온세일 일정 파일을 읽는 부품이 아직 없어 윈도우 없음으로 돈다(payment §8)');
        reconciliation = new PaymentReconciliation({
          store: new DrizzleReconciliation({ database: o.serviceDatabase, clock }),
          closer: new DrizzleConfirmJobs({ database: o.serviceDatabase, clock }),
          gateways: o.gateways,
          calendar: o.onSaleCalendar ?? NO_ONSALE_CALENDAR,
          log: paymentReconciliationLog(logger),
          signals: new PromPaymentReconciliationSignals().register(registry),
          clock,
          ...(o.holder === undefined ? {} : { owner: o.holder }),
        });
      }
      return [];
    },
    // payment DB에 표가 있는 Outbox 파티션 일, 웹훅 수신 기록 지우기(정비 역할), 입금 해시·대사 작업 표·시험 재개 행 지우기와 일일 대사(서비스 역할, BUILD_ORDER HOT-150·HOT-153·PRF-202)가 돈다. 멱등 기록·보류 행·통계 스냅샷 표는 이 단계의 마이그레이션에 없어(payment §2 '만들지 않은 것') 돌리면 정비 시간마다 실패한다
    maintenanceTasks: [
      ...platformMaintenanceTasks(o.maintenanceDatabase, clock).filter((task) => task.name.startsWith('outbox-partitions-')),
      webhookReceiptsDeleteTask(o.maintenanceDatabase, clock),
      depositSecretHashDeleteTask(o.serviceDatabase, clock),
      reconSeenDeleteTask(o.serviceDatabase, clock),
      entryTrialsDeleteTask(o.serviceDatabase, clock),
      ...(reconciliationOn ? [{ name: RECONCILIATION_TASK, when: 'daily' as const, run: (signal?: AbortSignal) => reconciliation!.runDaily(signal) }] : []),
    ],
  });
}
