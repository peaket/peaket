// payment-svc 시작(BUILD_ORDER PRF-180). 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱·관리 포트(건강·지표)는 서비스 뼈대(createService)가, 업무 gRPC 포트는 이 파일이 grpc-server.ts로 연다(identity-svc main.ts와 같은 꼴).
// 조립: 핫패스 풀(applicationName payment-svc)·일반 풀(payment-svc-batch), PromPaymentCommandSignals를 서비스 레지스트리에 붙이고,
// paymentServiceHandlers를 PaymentService에 묶는다. 준비 상태는 gRPC 포트를 연 뒤에 켠다. SIGTERM: 준비 상태를 내리고(docs/devops.md §6.4) gRPC 포트를 닫고 서비스를 닫은 뒤 DB 풀 둘을 닫는다.
import 'reflect-metadata';
import { createDatabase, createService } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { loadPaymentServiceConfig, PAYMENT_BATCH_POOL_MAX, PAYMENT_HOT_POOL_MAX } from './config.js';
import { startGrpcServer } from './grpc-server.js';
import {
  AcceptPaymentCommand,
  BatchGetPaymentStates,
  DrizzlePaymentStore,
  type PaymentCommandLog,
  paymentCommandLog,
  paymentPackage,
  paymentServiceHandlers,
  PromPaymentCommandSignals,
} from './modules/payment/server.js';
import { safeErrorCode } from './safe-error-code.js';

const SERVICE = 'payment-svc';
const config = loadPaymentServiceConfig(process.env);

const database = createDatabase({ url: config.databaseUrl, profile: 'hot', max: PAYMENT_HOT_POOL_MAX, applicationName: SERVICE });
const batchDatabase = createDatabase({ url: config.databaseUrl, max: PAYMENT_BATCH_POOL_MAX, applicationName: `${SERVICE}-batch` });
const store = new DrizzlePaymentStore({ database, batchDatabase });
const signals = new PromPaymentCommandSignals();

// 로거는 서비스가 선 뒤에 생긴다. 쓰임새에는 늦게 잇는 로그를 넣는다(gRPC 포트는 그 뒤에 열려 그 전에 불리지 않는다)
let log: PaymentCommandLog | undefined;
const lateLog: PaymentCommandLog = { mismatch: (e) => log?.mismatch(e) };

const service = await createService({ name: SERVICE, module: AppModule.register({ store, reader: store, log: lateLog, signals }) });
log = paymentCommandLog(service.logger);
signals.register(service.metrics.registry);
service.readiness.register('grpc');

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

process.once('SIGTERM', () => {
  service.readiness.register('shutting-down');
  // gRPC 포트를 먼저 닫아 새 호출을 받지 않고, 처리 중인 호출이 끝나면 서비스와 DB 풀을 닫는다
  void grpc
    .close()
    .then(() => service.close())
    .catch((err: unknown) => service.logger.error({ code: safeErrorCode(err) }, 'payment-svc 종료 실패'))
    .finally(() => Promise.all([database.close(), batchDatabase.close()]));
});
