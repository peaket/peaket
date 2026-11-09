// payment-svc 시작(BUILD_ORDER PRF-180). 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱·관리 포트(건강·지표)는 서비스 뼈대(createService)가, 업무 gRPC 포트는 이 파일이 grpc-server.ts로 연다(identity-svc main.ts와 같은 꼴).
// 조립: 핫패스 풀(applicationName payment-svc)·일반 풀(payment-svc-batch)·승인 실행기 전용 풀(payment-svc-confirm), PromPaymentCommandSignals·PromPaymentConfirmSignals를 서비스 레지스트리에 붙이고,
// paymentServiceHandlers를 PaymentService에 묶는다. 준비 상태는 gRPC 포트를 연 뒤에 켠다. 승인 실행기와 UNKNOWN 조회 실행기(승인 실행기의 풀과 채널별 호출 보호기를 함께 쓴다)는 그 뒤에 켠다(BUILD_ORDER PRF-181·PRF-182·PRF-183).
// 앱 포트에는 결제사 웹훅 경로가 있다(웹훅 전용 풀 payment-svc-webhook, BUILD_ORDER HOT-150).
// SIGTERM: 준비 상태를 내리고(docs/devops.md §6.4) gRPC 포트를 닫으면서 두 실행기를 멈춘 뒤(돌던 호출과 그 뒤 쓰기를 기다린다) 서비스를 닫고 DB 풀 넷을 닫는다.
import 'reflect-metadata';
import { hostname } from 'node:os';
import { createDatabase, createService, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { assertPgAdapters, loadPaymentServiceConfig, loadPgCallGuardConfig, loadPortoneGatewayConfig, loadSimulatorGatewayConfig, loadTossGatewayConfig, PAYMENT_BATCH_POOL_MAX, PAYMENT_HOT_POOL_MAX, webhookAcceptsSimulator } from './config.js';
import { startGrpcServer } from './grpc-server.js';
import { SimulatorPaymentGateway } from './modules/payment/adapters/pg/simulator-gateway.js';
import {
  AcceptPaymentCommand,
  BatchGetPaymentStates,
  confirmRunnerDatabaseOptions,
  createPgHttp,
  DrizzleConfirmJobs,
  DrizzlePaymentStore,
  DrizzleWebhookStore,
  type PaymentCommandLog,
  paymentCommandLog,
  paymentConfirmLog,
  PaymentConfirmRunner,
  paymentPackage,
  paymentServiceHandlers,
  PaymentUnknownResolver,
  paymentUnknownLog,
  type PaymentWebhookLog,
  paymentWebhookLog,
  PayRefKeyRing,
  perPodBulkhead,
  PG_CHANNEL_BULKHEAD,
  PgCallGuards,
  pgCallGuardLog,
  PortoneGateway,
  PromPaymentCommandSignals,
  PromPaymentConfirmSignals,
  PromPaymentMethodRefSignals,
  PromPaymentUnknownSignals,
  PromPaymentWebhookSignals,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
  TossPaymentGateway,
  UNKNOWN_QUERY_CONCURRENCY,
  WEBHOOK_REQUEST_TIMEOUT_MS,
  webhookDatabaseOptions,
} from './modules/payment/server.js';
import { safeErrorCode } from './safe-error-code.js';
import { shutdownInOrder } from './shutdown.js';

const SERVICE = 'payment-svc';
const config = loadPaymentServiceConfig(process.env);
// 잘못된 주소·빠진 키·환경과 어긋난 키 접두사는 여기서, 듣기 전에 시작 실패다. 어댑터 없이 켜지는 것은 local·ci뿐이다(아래 경고 한 줄과 no_adapter 지표, BUILD_ORDER PRF-184)
const simulator = loadSimulatorGatewayConfig(process.env);
const toss = loadTossGatewayConfig(process.env);
const portone = loadPortoneGatewayConfig(process.env);
assertPgAdapters(process.env, { simulator: simulator !== undefined, toss: toss !== undefined });
const guardConfig = loadPgCallGuardConfig(process.env);
// 결제 수단 연결값의 라벨 키 pay. 없으면 경고만 하고 칸을 비운다(결제는 막지 않는다, BUILD_ORDER HOT-145). 잘못된 설정은 듣기 전에 시작 실패다
const { ring: methodRefs, warnings: methodRefWarnings } = PayRefKeyRing.fromEnv(process.env);
// 어댑터마다 승인 묶음(연결 수 = 처음의 파드당 벌크헤드)과 조회 전용 묶음(연결 수 = 파드의 동시 조회 수) 둘. 승인 호출이 연결을 다 쥐어도 조회가 막히지 않는다. 연결 시간 초과 3초 [가정]. v0 모놀리스는 이 옵션을 쓰지 않는다(BUILD_ORDER PRF-183)
const pgHttp = simulator ? createPgHttp({ connections: perPodBulkhead(PG_CHANNEL_BULKHEAD.SIMULATOR, guardConfig.podCount) }) : undefined;
const pgQueryHttp = simulator ? createPgHttp({ connections: UNKNOWN_QUERY_CONCURRENCY }) : undefined;
const tossHttp = toss ? createPgHttp({ connections: perPodBulkhead(PG_CHANNEL_BULKHEAD.TOSS, guardConfig.podCount) }) : undefined;
const tossQueryHttp = toss ? createPgHttp({ connections: UNKNOWN_QUERY_CONCURRENCY }) : undefined;
const portoneHttp = portone ? createPgHttp({ connections: perPodBulkhead(PG_CHANNEL_BULKHEAD.PORTONE, guardConfig.podCount) }) : undefined;
const portoneQueryHttp = portone ? createPgHttp({ connections: UNKNOWN_QUERY_CONCURRENCY }) : undefined;
const gateways = new StaticPaymentGateways([
  ...(simulator ? [new SimulatorPaymentGateway({ ...simulator, fetch: pgHttp!.fetch, queryFetch: pgQueryHttp!.fetch })] : []),
  ...(toss ? [new TossPaymentGateway({ ...toss, fetch: tossHttp!.fetch, queryFetch: tossQueryHttp!.fetch })] : []),
  ...(portone ? [new PortoneGateway({ ...portone, fetch: portoneHttp!.fetch, queryFetch: portoneQueryHttp!.fetch })] : []),
]);

const database = createDatabase({ url: config.databaseUrl, profile: 'hot', max: PAYMENT_HOT_POOL_MAX, applicationName: SERVICE });
const batchDatabase = createDatabase({ url: config.databaseUrl, max: PAYMENT_BATCH_POOL_MAX, applicationName: `${SERVICE}-batch` });
const confirmDatabase = createDatabase(confirmRunnerDatabaseOptions(config.databaseUrl));
const webhookDatabase = createDatabase(webhookDatabaseOptions(config.databaseUrl));
const store = new DrizzlePaymentStore({ database, batchDatabase });
const signals = new PromPaymentCommandSignals();
const confirmSignals = new PromPaymentConfirmSignals();
const unknownSignals = new PromPaymentUnknownSignals();
const guardSignals = new PromPgCallGuardSignals();
const methodRefSignals = new PromPaymentMethodRefSignals();
const webhookSignals = new PromPaymentWebhookSignals();

// 로거는 서비스가 선 뒤에 생긴다. 쓰임새에는 늦게 잇는 로그를 넣는다(gRPC·앱 포트는 그 뒤에 열려 그 전에 불리지 않는다)
let log: PaymentCommandLog | undefined;
const lateLog: PaymentCommandLog = { mismatch: (e) => log?.mismatch(e) };
let webhookLog: PaymentWebhookLog | undefined;
const lateWebhookLog: PaymentWebhookLog = {
  invalid: (e) => webhookLog?.invalid(e),
  pgMismatch: (e) => webhookLog?.pgMismatch(e),
  storeFailed: (e) => webhookLog?.storeFailed(e),
};

const service = await createService({
  name: SERVICE,
  module: AppModule.register({
    store,
    reader: store,
    log: lateLog,
    signals,
    webhook: { store: new DrizzleWebhookStore({ database: webhookDatabase }), gateways, log: lateWebhookLog, signals: webhookSignals, allowSimulator: webhookAcceptsSimulator(process.env) },
  }),
  // 이 앱 포트의 HTTP 경로는 웹훅뿐이라 웹훅에 맞춘 시한을 서버 전체에 건다
  requestTimeoutMs: WEBHOOK_REQUEST_TIMEOUT_MS,
});
log = paymentCommandLog(service.logger);
webhookLog = paymentWebhookLog(service.logger, systemClock);
signals.register(service.metrics.registry);
confirmSignals.register(service.metrics.registry);
unknownSignals.register(service.metrics.registry);
guardSignals.register(service.metrics.registry);
methodRefSignals.register(service.metrics.registry);
webhookSignals.register(service.metrics.registry);
for (const warning of methodRefWarnings) service.logger.warn({ kind: 'payment-method-ref-key' }, warning);
service.readiness.register('grpc');
if (!simulator && !toss && !portone) service.logger.warn({ kind: 'payment-confirm-no-adapter' }, '결제사 어댑터 설정이 없어 어댑터 없이 켰다(승인 명령은 미뤄지고 no_adapter 지표가 드러낸다)');

await service.listen();
const grpc = await startGrpcServer({
  host: config.grpcHost,
  port: config.grpcPort,
  services: [
    {
      definition: paymentPackage().PaymentService.service,
      handlers: paymentServiceHandlers({ accept: service.app.get(AcceptPaymentCommand), batchGet: service.app.get(BatchGetPaymentStates) }, (method, err, orderId) =>
        // 오류 객체를 싣지 않는다: 드라이버 오류의 글에 문장 값(결제 키·토큰)이 실릴 수 있다
        service.logger.error({ method, code: safeErrorCode(err), ...(orderId ? { orderId } : {}) }, 'PaymentService 처리 실패'),
      ),
    },
  ],
});
service.readiness.complete('grpc');
service.logger.info({ port: grpc.port }, '업무 gRPC 포트를 열었다');

const confirmJobs = new DrizzleConfirmJobs({ database: confirmDatabase, clock: systemClock });
// lease_owner에 적는 파드 이름(쿠버네티스가 PEAKET_POD를 넣는다. 없으면 호스트 이름)
const podId = process.env.PEAKET_POD?.trim() || hostname();
// 채널별 호출 보호기는 두 실행기가 하나를 함께 쓴다(토큰 버킷은 승인과 단독 조회를 함께 센다, BUILD_ORDER PRF-183)
const guards = new PgCallGuards({ gateways, podCount: guardConfig.podCount, clock: systemClock, signals: guardSignals, log: pgCallGuardLog(service.logger) });
const confirmRunner = new PaymentConfirmRunner({ jobs: confirmJobs, gateways, guards, log: paymentConfirmLog(service.logger), signals: confirmSignals, clock: systemClock, podId, methodRefs, methodRefSignals });
confirmRunner.start();
const unknownResolver = new PaymentUnknownResolver({ queries: confirmJobs, gateways, guards, log: paymentUnknownLog(service.logger), signals: unknownSignals, clock: systemClock, methodRefs, methodRefSignals });
unknownResolver.start();

process.once('SIGTERM', () => {
  service.readiness.register('shutting-down');
  // gRPC 포트를 닫아 새 호출을 받지 않으면서 두 실행기를 멈춘다(돌던 호출과 그 뒤 쓰기를 기다린다). 모두 끝나면 서비스와 DB 풀을 닫는다. 앞 단계가 실패해도 뒤 단계를 한다
  void shutdownInOrder({
    stop: () => [grpc.close(), confirmRunner.stop(), unknownResolver.stop()],
    closeService: () => service.close(),
    closeConnections: () => [database.close(), batchDatabase.close(), confirmDatabase.close(), webhookDatabase.close(), pgHttp?.close(), pgQueryHttp?.close(), tossHttp?.close(), tossQueryHttp?.close(), portoneHttp?.close(), portoneQueryHttp?.close()],
    onError: (err) => service.logger.error({ code: safeErrorCode(err) }, 'payment-svc 종료 실패'),
  });
});
