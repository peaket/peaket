// ops-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// 앱 포트(관제 HTTP /v1/ops/commands)와 관리 포트(/metrics, /ready)는 서비스 뼈대가 연다. 업무 gRPC는 이 골격에 없다(제어 gRPC는 후속).
import 'reflect-metadata';
import { createDatabase, createExternalHttpClient, createService } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { GrpcEventRefunds } from './adapters/grpc-event-refunds.js';
import { GrpcAdminAuthz } from './adapters/identity-admin-authz.js';
import { HttpCommandExecutor } from './adapters/http-command-executor.js';
import { HttpPurchasePriorityGrants, HttpQueuePriorityGrantCopies } from './modules/priority/index.js';

const SERVICE = 'ops-svc';
const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');
const identityUrl = process.env.PEAKET_IDENTITY_GRPC_URL;
if (!identityUrl) throw new Error('PEAKET_IDENTITY_GRPC_URL이 없다(identity AdminAuthzService host:port)');

const database = createDatabase({ url, applicationName: SERVICE });
const adminAuthz = new GrpcAdminAuthz(identityUrl);
const purchaseUrl = process.env.PEAKET_PURCHASE_HTTP_URL;
const purchaseGrpcAddr = process.env.PEAKET_PURCHASE_GRPC_ADDR;
const coreUrl = process.env.PEAKET_CORE_HTTP_URL;
const queueUrl = process.env.PEAKET_QUEUE_HTTP_URL;
const internalToken = process.env.PEAKET_INTERNAL_TOKEN;
const refunds = purchaseGrpcAddr ? new GrpcEventRefunds({ address: purchaseGrpcAddr }) : undefined;
const executor = new HttpCommandExecutor({
  ...(purchaseUrl ? { purchase: createExternalHttpClient({ provider: 'purchase-svc', baseUrl: purchaseUrl, timeoutCapMs: 30_000 }) } : {}),
  ...(coreUrl ? { core: createExternalHttpClient({ provider: 'core-svc', baseUrl: coreUrl, timeoutCapMs: 5_000 }) } : {}),
  ...(refunds ? { refunds } : {}),
  internalToken,
});
const priority =
  purchaseUrl && queueUrl
    ? {
        purchase: new HttpPurchasePriorityGrants(createExternalHttpClient({ provider: 'purchase-svc', baseUrl: purchaseUrl, timeoutCapMs: 5_000 }), internalToken),
        copies: new HttpQueuePriorityGrantCopies(createExternalHttpClient({ provider: 'queue-svc', baseUrl: queueUrl, timeoutCapMs: 2_000 }), internalToken),
      }
    : undefined;
const service = await createService({ name: SERVICE, adminAuthz, module: AppModule.register({ database, executor, ...(priority ? { priority } : {}) }) });
if (!purchaseGrpcAddr) service.logger.warn({}, 'PEAKET_PURCHASE_GRPC_ADDR이 없어 회차 취소 환불 gRPC를 쓰지 않는다(내부 HTTP 호환 경로)');
if (!purchaseUrl && !purchaseGrpcAddr) service.logger.warn({}, 'PEAKET_PURCHASE_HTTP_URL·PEAKET_PURCHASE_GRPC_ADDR이 없어 EVENT_CANCEL 실행을 하지 않는다');
if (!coreUrl) service.logger.warn({}, 'PEAKET_CORE_HTTP_URL이 없어 SCALE_CHANGE 실행을 하지 않는다');
if (!priority) service.logger.warn({}, 'PEAKET_PURCHASE_HTTP_URL·PEAKET_QUEUE_HTTP_URL이 없어 우선 구매 권리 발급·회수를 열지 않는다');
await service.listen();

process.once('SIGTERM', () => {
  void service
    .close()
    .catch((err: unknown) => service.logger.error({ err }, 'ops-svc 종료 실패'))
    .finally(() => {
      adminAuthz.close();
      refunds?.close();
      return database.close();
    });
});
