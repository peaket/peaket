// payment-svc 시작(BUILD_ORDER PRF-180). 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱·관리 포트(건강·지표)는 서비스 뼈대(createService)가, 업무 gRPC 포트는 이 파일이 grpc-server.ts로 연다(identity-svc main.ts와 같은 꼴).
// 조립: 핫패스 풀(applicationName payment-svc)·일반 풀(payment-svc-batch)·승인 실행기 전용 풀(payment-svc-confirm), PromPaymentCommandSignals·PromPaymentConfirmSignals를 서비스 레지스트리에 붙이고,
// paymentServiceHandlers를 PaymentService에 묶는다. 준비 상태는 gRPC 포트를 연 뒤에 켠다. 승인 실행기와 UNKNOWN 조회 실행기(승인 실행기의 풀과 채널별 호출 보호기를 함께 쓴다)는 그 뒤에 켠다(BUILD_ORDER PRF-181·PRF-182·PRF-183).
// 앱 포트에는 결제사 웹훅 경로가 있다(웹훅 전용 풀 payment-svc-webhook, BUILD_ORDER HOT-150).
// SIGTERM: 준비 상태를 내리고(docs/devops.md §6.4) gRPC 포트를 닫으면서 두 실행기를 멈춘 뒤(돌던 호출과 그 뒤 쓰기를 기다린다) 서비스를 닫고 DB 풀 넷을 닫는다.
import 'reflect-metadata';
import { hostname } from 'node:os';
import { createDatabase, createService, inClusterLeaseApi, type LeaseApi, LeaseElector, memoryLeaseApi, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { assertPgAdapters, checkoutAdapterWarnings, loadCheckoutConfig, loadEntryPausePrometheusUrl, loadPaymentServiceConfig, loadPgCallGuardConfig, loadPortoneGatewayConfig, loadSimulatorGatewayConfig, loadTossGatewayConfig, PAYMENT_BATCH_POOL_MAX, PAYMENT_HOT_POOL_MAX, webhookAcceptsSimulator } from './config.js';
import { startGrpcServer } from './grpc-server.js';
import { SimulatorPaymentGateway } from './modules/payment/adapters/pg/simulator-gateway.js';
import {
  AcceptPaymentCommand,
  BatchGetPaymentStates,
  BreakerPgCircuits,
  CachedEntryPauseReader,
  CachedPgSelectionReader,
  CancelDepositPayment,
  channelTableOf,
  confirmRunnerDatabaseOptions,
  createPgHttp,
  DrizzleConfirmJobs,
  DrizzleEntryPause,
  DrizzlePaymentStore,
  DrizzlePgSelection,
  DrizzlePgSelectionBatch,
  DrizzleWebhookStore,
  ENTRY_PAUSE_LEASE_NAME,
  EntryPauseJudge,
  entryPauseLog,
  EntryPauseReleaseWatcher,
  GetNewPaymentPause,
  GetPaymentDetail,
  paymentCheckoutLog,
  type PaymentCommandLog,
  paymentCommandLog,
  NO_ENTRY_PAUSE_CLUSTER_INPUTS,
  paymentConfirmLog,
  paymentDepositLog,
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
  PrepareCheckout,
  PrometheusEntryPauseInputs,
  PromEntryPauseSignals,
  PromPaymentCheckoutSignals,
  PromPaymentCommandSignals,
  PromPaymentConfirmSignals,
  PromPaymentDepositSignals,
  PromPaymentMethodRefSignals,
  PromPaymentResolutionSignals,
  PromPaymentUnknownSignals,
  PromPaymentWebhookSignals,
  PromPgCallGuardSignals,
  StaticPaymentGateways,
  TossPaymentGateway,
  virtualAccountCipherFromEnv,
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
// 플랫폼 기본 결제사와 결제창 복귀 출처. 잘못된 값은 듣기 전에 시작 실패다(BUILD_ORDER PRF-190)
const checkoutConfig = loadCheckoutConfig(process.env);
// 정지 판정자의 입력을 읽을 클러스터 Prometheus 주소. local·ci 밖에서 없으면 듣기 전에 시작 실패다(BUILD_ORDER PRF-202 코드 리뷰)
const promUrl = loadEntryPausePrometheusUrl(process.env);
// 결제 수단 연결값의 라벨 키 pay. 없으면 경고만 하고 칸을 비운다(결제는 막지 않는다, BUILD_ORDER HOT-145). 잘못된 설정은 듣기 전에 시작 실패다
const { ring: methodRefs, warnings: methodRefWarnings } = PayRefKeyRing.fromEnv(process.env);
// 가상계좌 번호 필드 암호화 키(local·ci·demo는 환경 값, 운영 KMS는 HOT-146). 없으면 경고만 하고 번호를 저장하지 않는다(결제는 막지 않는다, BUILD_ORDER HOT-151). 잘못된 설정은 듣기 전에 시작 실패다
const { cipher: virtualAccountCipher, warnings: virtualAccountWarnings } = virtualAccountCipherFromEnv(process.env);
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
// 플랫폼 기본 결제사의 어댑터가 없으면 듣기 전에 시작 실패이고, 대체의 어댑터가 없으면 경고다(BUILD_ORDER PRF-190 코드 리뷰)
const checkoutWarnings = checkoutAdapterWarnings(process.env, checkoutConfig.defaults, (pg) => gateways.of(pg) !== undefined);

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
const depositSignals = new PromPaymentDepositSignals();
const checkoutSignals = new PromPaymentCheckoutSignals();
// 전환·회차 지정 읽기는 핫패스 풀이고 회차마다 1초 [가정] 캐시한다(BUILD_ORDER PRF-190)
const pgSelection = new CachedPgSelectionReader({ reader: new DrizzlePgSelection({ database }), clock: systemClock });
// GetNewPaymentPause의 회차 목록은 일반 풀의 한 문장으로 읽는다(BUILD_ORDER PRF-201 코드 리뷰)
const pgSelectionBatch = new DrizzlePgSelectionBatch({ database: batchDatabase });
// 새 결제 일시 정지 행은 핫패스 풀에서 1초 [가정]마다 읽어 파드 메모리에 둔다. 시험 재개 행은 정지 때만 기본 키로 읽는다(BUILD_ORDER PRF-201)
const entryPauseStore = new DrizzleEntryPause({ database });
// 읽은 행에서 사람이 푼 해제를 보면 이 파드의 서킷을 닫는다(보호기는 서비스가 선 뒤에 생겨 늦게 잇는다, BUILD_ORDER PRF-202 코드 리뷰)
let entryPauseReleaseWatcher: EntryPauseReleaseWatcher | undefined;
const entryPauses = new CachedEntryPauseReader({ reader: entryPauseStore, clock: systemClock, signals: checkoutSignals, onLoaded: (rows) => entryPauseReleaseWatcher?.observe(rows) });
const channels = channelTableOf(gateways);

// 로거는 서비스가 선 뒤에 생긴다. 쓰임새에는 늦게 잇는 로그를 넣는다(gRPC·앱 포트는 그 뒤에 열려 그 전에 불리지 않는다)
let log: PaymentCommandLog | undefined;
const lateLog: PaymentCommandLog = { mismatch: (e) => log?.mismatch(e) };
let webhookLog: PaymentWebhookLog | undefined;
const lateWebhookLog: PaymentWebhookLog = {
  invalid: (e) => webhookLog?.invalid(e),
  pgMismatch: (e) => webhookLog?.pgMismatch(e),
  storeFailed: (e) => webhookLog?.storeFailed(e),
  depositSecretMismatch: (e) => webhookLog?.depositSecretMismatch(e),
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
depositSignals.register(service.metrics.registry);
checkoutSignals.register(service.metrics.registry);
// 단계 지표는 모든 파드가 캐시한 행에서 낸다(BUILD_ORDER PRF-202)
const entryPauseSignals = new PromEntryPauseSignals().register(service.metrics.registry, entryPauses);
for (const warning of methodRefWarnings) service.logger.warn({ kind: 'payment-method-ref-key' }, warning);
for (const warning of virtualAccountWarnings) service.logger.warn({ kind: 'payment-virtual-account-key' }, warning);
for (const warning of checkoutWarnings) service.logger.warn({ kind: 'payment-checkout-adapter' }, warning);
const depositLog = paymentDepositLog(service.logger);
const deposit = { cipher: virtualAccountCipher, log: depositLog, signals: depositSignals };
const confirmJobs = new DrizzleConfirmJobs({ database: confirmDatabase, clock: systemClock });
// 결제사 서킷은 채널마다 하나이고 승인·조회·취소가 함께 쓴다. 값은 플랫폼 기본값 [가정](docs/features/payment.md §2 '결제사 서킷의 첫 구현', BUILD_ORDER PRF-200)
const circuits = new BreakerPgCircuits({ service: SERVICE, registry: service.metrics.registry, logger: service.logger, clock: systemClock }).register(service.metrics.registry);
const guards = new PgCallGuards({ gateways, podCount: guardConfig.podCount, clock: systemClock, signals: guardSignals, log: pgCallGuardLog(service.logger), circuits });
const depositCancel = new CancelDepositPayment({ store: confirmJobs, gateways, guards, signals: depositSignals, clock: systemClock });
const VIRTUAL_ACCOUNT_DISALLOWED_REASON = '가상계좌를 받지 않는 공연의 입금 대기';
entryPauseReleaseWatcher = new EntryPauseReleaseWatcher({ closeCircuit: (pg) => guards.of(pg)?.closeCircuit() });
const resolutionSignals = new PromPaymentResolutionSignals().register(service.metrics.registry);
service.readiness.register('grpc');
if (!simulator && !toss && !portone) service.logger.warn({ kind: 'payment-confirm-no-adapter' }, '결제사 어댑터 설정이 없어 어댑터 없이 켰다(승인 명령은 미뤄지고 no_adapter 지표가 드러낸다)');

await service.listen();
const grpc = await startGrpcServer({
  host: config.grpcHost,
  port: config.grpcPort,
  services: [
    {
      definition: paymentPackage().PaymentService.service,
      handlers: paymentServiceHandlers({ accept: service.app.get(AcceptPaymentCommand), batchGet: service.app.get(BatchGetPaymentStates), getPayment: new GetPaymentDetail({ reader: store, signals: depositSignals, cipher: virtualAccountCipher, depositLog, depositSignals, clock: systemClock }), cancelPayment: depositCancel, prepareCheckout: new PrepareCheckout({ selection: pgSelection, pauses: entryPauses, trials: entryPauseStore, trialSignals: entryPauseSignals, gateways, channels, defaults: checkoutConfig.defaults, webOrigin: checkoutConfig.webOrigin, virtualAccountReady: virtualAccountCipher.ready, clock: systemClock, log: paymentCheckoutLog(service.logger), signals: checkoutSignals }), getNewPaymentPause: new GetNewPaymentPause({ selection: pgSelectionBatch, pauses: entryPauses, channels, defaults: checkoutConfig.defaults }) }, (method, err, orderId) =>
        // 오류 객체를 싣지 않는다: 드라이버 오류의 글에 문장 값(결제 키·토큰)이 실릴 수 있다
        service.logger.error({ method, code: safeErrorCode(err), ...(orderId ? { orderId } : {}) }, 'PaymentService 처리 실패'),
      ),
    },
  ],
});
service.readiness.complete('grpc');
service.logger.info({ port: grpc.port }, '업무 gRPC 포트를 열었다');

// lease_owner에 적는 파드 이름(쿠버네티스가 PEAKET_POD를 넣는다. 없으면 호스트 이름)
const podId = process.env.PEAKET_POD?.trim() || hostname();
// 채널별 호출 보호기는 두 실행기가 하나를 함께 쓴다(토큰 버킷은 승인과 단독 조회를 함께 센다, BUILD_ORDER PRF-183)
// 시험 재개의 첫 승인 결과는 승인 실행기 풀에서 쓴다(BUILD_ORDER PRF-202)
const entryTrialResults = new DrizzleEntryPause({ database: confirmDatabase });
// 가상계좌를 끈 회차의 입금 대기 답을 입금 전 취소로 끝낸다(POL-014, H2, HOT-152 경로). 실패하면 입금 기한 경과가 받친다(T17)
const disallowedDeposit = async (x: { readonly paymentId: string; readonly orderId: string }): Promise<void> => {
  try {
    await depositCancel.execute({ paymentId: x.paymentId, cancellationId: x.paymentId, reason: VIRTUAL_ACCOUNT_DISALLOWED_REASON });
  } catch (err) {
    service.logger.error({ orderId: x.orderId, code: safeErrorCode(err) }, '가상계좌를 끈 회차의 입금 전 취소 실패(입금 기한이 끝나면 풀린다)');
  }
};
const confirmRunner = new PaymentConfirmRunner({ jobs: confirmJobs, gateways, guards, log: paymentConfirmLog(service.logger), signals: confirmSignals, clock: systemClock, podId, methodRefs, methodRefSignals, deposit, disallowedDeposit, resolution: resolutionSignals, trialResults: entryTrialResults, pauses: entryPauses, trialSignals: entryPauseSignals });
confirmRunner.start();
const unknownResolver = new PaymentUnknownResolver({ queries: confirmJobs, gateways, guards, log: paymentUnknownLog(service.logger), signals: unknownSignals, clock: systemClock, methodRefs, methodRefSignals, deposit, disallowedDeposit, resolution: resolutionSignals });
unknownResolver.start();

// 새 결제 진입 정지 판정자(BUILD_ORDER PRF-202, ADR-0105 결정 8): Lease로 뽑은 파드 하나가 돈다. 파드 밖(local·ci)은 이 프로세스 하나만 리더다
const entryPauseLeaseApi: LeaseApi = process.env.KUBERNETES_SERVICE_HOST ? inClusterLeaseApi(ENTRY_PAUSE_LEASE_NAME) : memoryLeaseApi();
// 판정자가 없으면 합이 0으로 보인다(BUILD_ORDER PRF-202 코드 리뷰)
const entryPauseElector = new LeaseElector({ api: entryPauseLeaseApi, identity: podId, clock: systemClock, onChange: (leader) => entryPauseSignals.judgeLeader(leader) });
// 주소가 없는 것은 local·ci뿐이다. 그때는 '입력 없음'이고 판정자 파드의 서킷만으로 멈추며 자동으로는 다시 열지 않는다(ADR-0069)
if (!promUrl) service.logger.warn({ kind: 'payment-entry-pause-no-inputs' }, 'PEAKET_PROMETHEUS_URL이 없어 정지 판정자가 제어 입력 없이 돈다(자기 파드의 서킷만으로 멈추고 자동으로 다시 열지 않는다)');
const entryPauseInputs = promUrl ? new PrometheusEntryPauseInputs({ baseUrl: promUrl }) : NO_ENTRY_PAUSE_CLUSTER_INPUTS;
const entryPauseJudgeStore = new DrizzleEntryPause({ database: batchDatabase });
const entryPauseJudge = new EntryPauseJudge({ store: entryPauseJudgeStore, inputs: entryPauseInputs, gateways, guards, leader: entryPauseElector, podCount: guardConfig.podCount, clock: systemClock, signals: entryPauseSignals, log: entryPauseLog(service.logger) });
entryPauseElector.start();
entryPauseJudge.start();

process.once('SIGTERM', () => {
  service.readiness.register('shutting-down');
  // gRPC 포트를 닫아 새 호출을 받지 않으면서 두 실행기를 멈춘다(돌던 호출과 그 뒤 쓰기를 기다린다). 모두 끝나면 서비스와 DB 풀을 닫는다. 앞 단계가 실패해도 뒤 단계를 한다
  void shutdownInOrder({
    stop: () => [grpc.close(), confirmRunner.stop(), unknownResolver.stop(), entryPauseJudge.stop().then(() => entryPauseElector.stop())],
    closeService: () => service.close(),
    closeConnections: () => [Promise.resolve(circuits.shutdown()), database.close(), batchDatabase.close(), confirmDatabase.close(), webhookDatabase.close(), pgHttp?.close(), pgQueryHttp?.close(), tossHttp?.close(), tossQueryHttp?.close(), portoneHttp?.close(), portoneQueryHttp?.close()],
    onError: (err) => service.logger.error({ code: safeErrorCode(err) }, 'payment-svc 종료 실패'),
  });
});
