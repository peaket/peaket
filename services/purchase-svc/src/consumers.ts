// purchase-svc API 파드의 Kafka 소비자 둘(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' 프로세스 둘·소비자 그룹,
// docs/features/payment.md §2 '결제 결과 반영의 첫 구현', docs/streaming.md §2.6, ADR-0142).
// - 홀드 원장 적재: trade.seats → SeatHoldLedgerHandler(그룹 peaket.purchase-svc-hold-ledger.<환경>)
// - 결제 결과 반영(주문 Saga): trade.payments → PaymentResultHandler(그룹 peaket.purchase-svc-order-saga.<환경>). 같은 파드의 long polling 기다림 표를
//   곧바로 깨워야 해서(ApplyPaymentResult의 onOrderChanged) API 파드에서 돈다. 소비자 그룹이 파티션을 나누므로 리더가 없어도 된다
// 둘 다 플랫폼 키 단위 소비자(runKeyedConsumer)이고, 처리 못 하는 사건은 purchase DB held_event로 보류한다. 커밋이 없을 때는 가장 이른 곳부터 읽는다(플랫폼 기본).
// main.ts가 purchase DB가 있고 Kafka가 켜졌을 때(kafkaConsumersFromEnv) 듣기 시작한 뒤 켜고, SIGTERM에서 가장 먼저 멈춘다.
// 구현에서 정한 것(정본에 없다): 두 소비자는 같은 clientId(purchase-svc-<환경>-<파드>, docs/streaming.md §2.6)를 쓴다(그룹 이름으로 가른다).
// 설정 오류는 PlatformConfigError다(플랫폼 설정 오류와 같은 형, 시작 실패). 오류 글에 PEAKET_KAFKA_BROKERS 원문을 싣지 않는다(몇 번째 조각이 틀렸는지만, 리뷰 고침 L9).
// 두 소비자는 핫패스 풀과 따로 소비자 전용 일반 풀(consumerDatabaseOptions)을 쓴다(정본 'API 파드 소비자의 DB 풀', 리뷰 고침 M4).
// 결제 결과 반영의 조립(paymentResultApply)은 main.ts와 test-int/consumers.int.test.ts가 같이 쓴다(리뷰 고침 변이 검토).
import {
  type Clock,
  type Database,
  type DatabaseOptions,
  drizzleHeldEventStore,
  heldEventCounts,
  type KafkaAuth,
  kafkaAuthFromEnv,
  PlatformConfigError,
  type Registry,
  systemClock,
} from '@peaket/platform';
import { runKeyedConsumer } from '@peaket/platform/stream-worker';
import {
  ApplyPaymentResult,
  DrizzlePaymentResults,
  type DrizzleOrderStore,
  InventoryPaymentResultSessions,
  LoggerPaymentResultLog,
  type PaymentSessionSource,
  PaymentResultHandler,
  type SagaWake,
  TRADE_PAYMENTS_TOPIC,
} from './modules/booking/index.js';
import { DrizzleSeatSales, SEAT_TOPIC, type SeatHoldLedger, SeatHoldLedgerHandler } from './modules/inventory/index.js';

const SERVICE = 'purchase-svc';

/** 소비자 전용 DB 풀의 연결 수 4개 [가정](docs/features/seat-hold.md §6 'API 파드 소비자의 DB 풀') */
const CONSUMER_DB_MAX = 4;

/**
 * API 파드 두 소비자의 purchase DB(PEAKET_DATABASE_URL) 풀 설정(main.ts가 createDatabase에 넘긴다, PRF-164 리뷰 고침 M4).
 * 핫패스 풀과 따로인 일반 풀(연결을 기다린다)·연결 CONSUMER_DB_MAX개·이름 purchase-svc-consumers다: 키 단위 동시 처리(파티션마다 32키)가 밀린 사건을
 * 한꺼번에 처리할 때 홀드·주문 요청이 풀 대기 초과(429)를 받지 않게 한다. 원장 적재·결제 결과 반영(결과 저장소·판매 저장소)·보류 표가 쓴다
 */
export function consumerDatabaseOptions(url: string): DatabaseOptions {
  return { url, profile: 'general', max: CONSUMER_DB_MAX, applicationName: `${SERVICE}-consumers` };
}

export interface PaymentResultApplyOptions {
  /** 결제 결과 반영이 쓰는 purchase DB(운영은 소비자 전용 풀 consumerDatabaseOptions). 결과 저장소·판매 저장소가 쓴다 */
  database: Database;
  /** 주문 전이 함수(T9~T17, 결제 사건 순번 조건). API와 같은 DrizzleOrderStore */
  store: DrizzleOrderStore;
  /** 커밋 뒤 구매 세션 끝내기(end: inventory EndPurchaseSession)·Paying 풀기(store: 구매 세션 저장소 setPaying) */
  sessions: PaymentSessionSource;
  /** 커밋 뒤 Saga 실행기 깨우기(운영은 OrderSagaRunner) */
  saga: SagaWake;
  /** 보류·커밋 뒤 실패 로그 줄(LoggerPaymentResultLog가 칸을 골라 싣는다, 보통 서비스 로거) */
  logger: ConstructorParameters<typeof LoggerPaymentResultLog>[0];
  clock: Clock;
  /**
   * 바로 답할 상태로 간 전이를 커밋한 뒤 부를 것(같은 파드의 결제 결과 long polling 기다림 표 notify, docs/features/payment.md §2 '알림 길').
   * 필수다: 빠뜨리면 그 파드의 기다림이 묶음 조회까지 늦게 깬다(리뷰 고침 변이 검토)
   */
  onOrderChanged: (orderId: string) => void;
}

/**
 * 결제 결과 반영 쓰임새(trade.payments 소비자가 부른다)를 조립한다: new ApplyPaymentResult({ reads·writes: new DrizzlePaymentResults({ database, store,
 * sales: new DrizzleSeatSales(database), clock }), sessions: new InventoryPaymentResultSessions(sessions), saga, log: new LoggerPaymentResultLog(logger), clock, onOrderChanged }).
 * main.ts와 test-int/consumers.int.test.ts가 같은 함수를 쓴다(조립이 둘로 갈라지지 않게)
 */
export function paymentResultApply(o: PaymentResultApplyOptions): ApplyPaymentResult {
  const results = new DrizzlePaymentResults({ database: o.database, store: o.store, sales: new DrizzleSeatSales(o.database), clock: o.clock });
  return new ApplyPaymentResult({
    reads: results,
    writes: results,
    sessions: new InventoryPaymentResultSessions(o.sessions),
    saga: o.saga,
    log: new LoggerPaymentResultLog(o.logger),
    clock: o.clock,
    onOrderChanged: o.onOrderChanged,
  });
}

/** 홀드 원장 적재 소비자 그룹 이름(docs/features/seat-hold.md §6 '적재 소비자') */
export const HOLD_LEDGER_GROUP = (env: string): string => `peaket.purchase-svc-hold-ledger.${env}`;
/** 결제 결과 반영(주문 Saga) 소비자 그룹 이름(docs/features/payment.md §2) */
export const ORDER_SAGA_GROUP = (env: string): string => `peaket.purchase-svc-order-saga.${env}`;

/** 브로커 주소 모양(플랫폼 loadOutboxRelayProcessConfig의 BROKER와 같은 규칙. 플랫폼이 내보내지 않아 따로 적는다) */
const BROKER = /^[A-Za-z0-9.-]+:\d{1,5}$/;
/** 브로커 주소 없이 떠도 되는 환경(플랫폼 kafkaAuthFromEnv가 평문을 허락하는 환경과 같다) */
const KAFKA_OPTIONAL_ENVS: readonly string[] = ['local', 'ci'];

export interface PurchaseConsumersOptions {
  /** 환경 이름(PEAKET_ENV: local·ci·demo·staging·prod, 플랫폼 PEAKET_ENVS). 소비자 그룹 이름에 붙는다 */
  env: string;
  /** 'host:port' 목록 */
  brokers: string[];
  /** `purchase-svc-<환경>-<파드>`(docs/streaming.md §2.6) */
  clientId: string;
  /** 없으면 평문(로컬·CI 브로커). 운영은 MSK IAM(kafkaAuthFromEnv('purchase-svc'), 세션 이름 purchase-svc-<환경>) */
  auth?: KafkaAuth;
  /** purchase DB(보류 표 held_event 넣기·읽기와 보류 수 재기). 운영은 소비자 전용 풀(consumerDatabaseOptions) */
  database: Database;
  /** 홀드 원장 쓰기(운영은 inventory DrizzleSeatHoldLedger) */
  ledger: SeatHoldLedger;
  /** 결제 결과 반영 쓰임새(운영은 booking ApplyPaymentResult, onOrderChanged에 기다림 표 notify를 넘겨 만든다) */
  applyPaymentResult: Pick<ApplyPaymentResult, 'execute'>;
  /** 소비자 지표(consumer_*)를 붙일 레지스트리(보통 서비스 레지스트리). 있으면 보류 수(heldEventCounts(database))도 잰다 */
  registry?: Registry;
  /** 소비자 경고 줄(보통 서비스 로거) */
  logger?: { warn(obj: object, msg?: string): void };
  /** 커밋이 없을 때 읽기 시작할 곳(기본 'earliest', 플랫폼 기본) */
  startAt?: 'earliest' | 'latest';
  /** 보류 표의 넣은 시각(drizzleHeldEventStore의 시계, 기본 systemClock) */
  clock?: Clock;
}

export interface PurchaseConsumers {
  /** 두 소비자가 모두 연결되고 구독했다(하나라도 실패하면 거부된다) */
  started: Promise<void>;
  /** 두 소비자를 함께 멈춘다(각자 받기를 멈추고 처리 중인 키를 마친 뒤 커밋하고 나간다). 하나가 던져도 다른 하나는 멈추고, 그 뒤 첫 오류를 던진다. 두 번 불러도 된다 */
  stop(): Promise<void>;
}

/**
 * 소비자 둘을 건다(runKeyedConsumer 둘, service 'purchase-svc').
 * - 원장 적재: groupId HOLD_LEDGER_GROUP(env), topics [SEAT_TOPIC('trade.seats')], handler new SeatHoldLedgerHandler(ledger)
 * - 결제 결과: groupId ORDER_SAGA_GROUP(env), topics [TRADE_PAYMENTS_TOPIC('trade.payments')], handler new PaymentResultHandler(applyPaymentResult)
 * - 둘 다 held = drizzleHeldEventStore(database, clock), registry가 있으면 heldCounts = heldEventCounts(database), auth·startAt·logger를 그대로 넘긴다
 * 기다리지 않는다(연결은 started로 기다린다)
 */
export function startPurchaseConsumers(o: PurchaseConsumersOptions): PurchaseConsumers {
  const held = drizzleHeldEventStore(o.database, o.clock ?? systemClock);
  const common = {
    service: SERVICE,
    brokers: o.brokers,
    clientId: o.clientId,
    auth: o.auth,
    held,
    registry: o.registry,
    ...(o.registry ? { heldCounts: () => heldEventCounts(o.database) } : {}),
    logger: o.logger,
    startAt: o.startAt,
  };
  const ledger = runKeyedConsumer({ ...common, groupId: HOLD_LEDGER_GROUP(o.env), topics: [SEAT_TOPIC], handler: new SeatHoldLedgerHandler(o.ledger) });
  const saga = runKeyedConsumer({ ...common, groupId: ORDER_SAGA_GROUP(o.env), topics: [TRADE_PAYMENTS_TOPIC], handler: new PaymentResultHandler(o.applyPaymentResult) });
  const started = Promise.all([ledger.started, saga.started]).then(() => undefined);
  // 부른 쪽이 started를 기다리지 않고 stop만 불러도 처리되지 않은 거부가 남지 않게 한다(거부는 started를 기다리는 쪽이 받는다)
  started.catch(() => undefined);
  let stopping: Promise<void> | undefined;
  return {
    started,
    stop() {
      stopping ??= (async () => {
        const results = await Promise.allSettled([ledger.stop(), saga.stop()]);
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed) throw failed.reason;
      })();
      return stopping;
    },
  };
}

/** kafkaConsumersFromEnv의 결과 */
export type KafkaConsumersConfig =
  /** 브로커 주소가 없는 local·ci: 소비자를 켜지 않는다(warning은 시작 로그 경고 한 줄의 글) */
  | { enabled: false; warning: string }
  | {
      enabled: true;
      /** PEAKET_KAFKA_BROKERS를 쉼표로 나누고 앞뒤 빈칸을 뗀 목록(빈 조각은 뺀다) */
      brokers: string[];
      /** kafkaAuthFromEnv(service, env)(local·ci에서 PEAKET_KAFKA_AUTH가 없으면 undefined) */
      auth: KafkaAuth | undefined;
      /** PEAKET_ENV */
      env: string;
    };

/**
 * API 파드의 소비자 설정을 환경 값에서 읽는다.
 * - PEAKET_KAFKA_BROKERS가 없거나 빈칸뿐: PEAKET_ENV가 local·ci면 { enabled: false, warning }, 그 밖(값 없음 포함)이면 던진다(시작 실패, 듣기 전)
 * - 있으면: 쉼표로 나눈 조각이 모두 플랫폼 BROKER 모양(^[A-Za-z0-9.-]+:\d{1,5}$, loadOutboxRelayProcessConfig와 같은 규칙)이고 하나 이상이어야 한다(아니면 던진다).
 *   { enabled: true, brokers, auth: kafkaAuthFromEnv(service, env), env: PEAKET_ENV }(PEAKET_ENV가 없으면 던진다)
 * @param service 서비스 이름이자 MSK IAM 작업자 이름('purchase-svc', 세션 이름 purchase-svc-<환경>)
 * @throws Error 위의 시작 실패(값이 빠짐·모양이 틀림, PlatformConfigError. 모양 오류의 글은 값 대신 몇 번째 조각인지만 싣는다), kafkaAuthFromEnv의 오류(local·ci 밖에서 PEAKET_KAFKA_AUTH 없음 등)
 */
export function kafkaConsumersFromEnv(env: Record<string, string | undefined>, service: string): KafkaConsumersConfig {
  const raw = env.PEAKET_KAFKA_BROKERS?.trim();
  const peaketEnv = env.PEAKET_ENV;
  if (!raw) {
    if (peaketEnv !== undefined && KAFKA_OPTIONAL_ENVS.includes(peaketEnv)) {
      return { enabled: false, warning: `PEAKET_KAFKA_BROKERS가 없어 Kafka 소비자 둘(결제 결과 반영 trade.payments·홀드 원장 적재 trade.seats)을 켜지 않았다(PEAKET_ENV=${peaketEnv}에서만 허락한다)` };
    }
    // 조용히 소비자 없이 뜨지 않는다: 결제 결과가 주문에 반영되지 않고 원장이 쌓이지 않는다
    throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS가 없다(PEAKET_ENV=${peaketEnv || '(없음)'}에서는 Kafka 소비자 둘이 있어야 한다. local·ci만 없이 뜬다)`);
  }
  const pieces = raw.split(',').map((s) => s.trim());
  const brokers = pieces.filter(Boolean);
  // 오류 글에는 값을 싣지 않는다(시작 로그에 남는다. 주소에 사용자 이름 등이 섞여 들 수 있다): 몇 번째 조각(쉼표로 나눈 차례, 빈 조각도 센다)인지만(리뷰 고침 L9)
  const bad = pieces.findIndex((s) => s !== '' && !BROKER.test(s));
  if (bad >= 0) throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS는 쉼표로 나눈 '호스트:포트' 목록이어야 한다: ${bad + 1}번째 조각이 그 모양이 아니다`);
  if (brokers.length === 0) throw new PlatformConfigError(`PEAKET_KAFKA_BROKERS는 쉼표로 나눈 '호스트:포트' 목록이어야 한다: 빈 조각뿐이다`);
  if (!peaketEnv) throw new PlatformConfigError('PEAKET_ENV가 없어 Kafka 소비자 그룹 이름과 인증을 고를 수 없다');
  return { enabled: true, brokers, auth: kafkaAuthFromEnv(service, env), env: peaketEnv };
}
