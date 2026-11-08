// payment-svc 시작(BUILD_ORDER PRF-180). 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱·관리 포트(건강·지표)는 서비스 뼈대(createService)가, 업무 gRPC 포트는 이 파일이 grpc-server.ts로 연다(identity-svc main.ts와 같은 꼴).
// 조립: 핫패스 풀(applicationName payment-svc)·일반 풀(payment-svc-batch)·승인 실행기 전용 풀(payment-svc-confirm), PromPaymentCommandSignals·PromPaymentConfirmSignals를 서비스 레지스트리에 붙이고,
// paymentServiceHandlers를 PaymentService에 묶는다. 준비 상태는 gRPC 포트를 연 뒤에 켠다. 승인 실행기와 UNKNOWN 조회 실행기(승인 실행기의 풀을 함께 쓴다)는 그 뒤에 켠다(BUILD_ORDER PRF-181·PRF-182).
// SIGTERM: 준비 상태를 내리고(docs/devops.md §6.4) gRPC 포트를 닫으면서 두 실행기를 멈춘 뒤(돌던 호출과 그 뒤 쓰기를 기다린다) 서비스를 닫고 DB 풀 셋을 닫는다.
import 'reflect-metadata';
import { hostname } from 'node:os';
import { createDatabase, createService, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { loadPaymentServiceConfig, loadSimulatorGatewayConfig, PAYMENT_BATCH_POOL_MAX, PAYMENT_HOT_POOL_MAX } from './config.js';
import { startGrpcServer } from './grpc-server.js';
import { SimulatorPaymentGateway } from './modules/payment/adapters/pg/simulator-gateway.js';
import {
  AcceptPaymentCommand,
  BatchGetPaymentStates,
  confirmRunnerDatabaseOptions,
  DrizzleConfirmJobs,
  DrizzlePaymentStore,
  type PaymentCommandLog,
  paymentCommandLog,
  paymentConfirmLog,
  PaymentConfirmRunner,
  paymentPackage,
  paymentServiceHandlers,
  PaymentUnknownResolver,
  paymentUnknownLog,
  PromPaymentCommandSignals,
  PromPaymentConfirmSignals,
  PromPaymentUnknownSignals,
  StaticPaymentGateways,
} from './modules/payment/server.js';
import { safeErrorCode } from './safe-error-code.js';

const SERVICE = 'payment-svc';
const config = loadPaymentServiceConfig(process.env);
// 주소가 없으면 어댑터 없이 켠다(아래 경고 한 줄과 no_adapter 지표). 잘못된 주소·빠진 키는 여기서, 듣기 전에 시작 실패다
const simulator = loadSimulatorGatewayConfig(process.env);
const gateways = new StaticPaymentGateways(simulator ? [new SimulatorPaymentGateway(simulator)] : []);

const database = createDatabase({ url: config.databaseUrl, profile: 'hot', max: PAYMENT_HOT_POOL_MAX, applicationName: SERVICE });
const batchDatabase = createDatabase({ url: config.databaseUrl, max: PAYMENT_BATCH_POOL_MAX, applicationName: `${SERVICE}-batch` });
const confirmDatabase = createDatabase(confirmRunnerDatabaseOptions(config.databaseUrl));
const store = new DrizzlePaymentStore({ database, batchDatabase });
const signals = new PromPaymentCommandSignals();
const confirmSignals = new PromPaymentConfirmSignals();
const unknownSignals = new PromPaymentUnknownSignals();

// 로거는 서비스가 선 뒤에 생긴다. 쓰임새에는 늦게 잇는 로그를 넣는다(gRPC 포트는 그 뒤에 열려 그 전에 불리지 않는다)
let log: PaymentCommandLog | undefined;
const lateLog: PaymentCommandLog = { mismatch: (e) => log?.mismatch(e) };

const service = await createService({ name: SERVICE, module: AppModule.register({ store, reader: store, log: lateLog, signals }) });
log = paymentCommandLog(service.logger);
signals.register(service.metrics.registry);
confirmSignals.register(service.metrics.registry);
unknownSignals.register(service.metrics.registry);
service.readiness.register('grpc');
if (!simulator) service.logger.warn({ kind: 'payment-confirm-no-adapter' }, 'PEAKET_PG_SIM_URL이 없어 결제사 어댑터 없이 켰다(승인 명령은 미뤄지고 no_adapter 지표가 드러낸다)');

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
const confirmRunner = new PaymentConfirmRunner({ jobs: confirmJobs, gateways, log: paymentConfirmLog(service.logger), signals: confirmSignals, clock: systemClock, podId });
confirmRunner.start();
const unknownResolver = new PaymentUnknownResolver({ queries: confirmJobs, gateways, log: paymentUnknownLog(service.logger), signals: unknownSignals, clock: systemClock });
unknownResolver.start();

process.once('SIGTERM', () => {
  service.readiness.register('shutting-down');
  // gRPC 포트를 닫아 새 호출을 받지 않으면서 두 실행기를 멈춘다(돌던 호출과 그 뒤 쓰기를 기다린다). 모두 끝나면 서비스와 DB 풀을 닫는다
  void Promise.all([grpc.close(), confirmRunner.stop(), unknownResolver.stop()])
    .then(() => service.close())
    .catch((err: unknown) => service.logger.error({ code: safeErrorCode(err) }, 'payment-svc 종료 실패'))
    .finally(() => Promise.all([database.close(), batchDatabase.close(), confirmDatabase.close()]));
});
