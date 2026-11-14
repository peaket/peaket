// ops-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// 앱 포트(관제 HTTP /v1/ops/commands)와 관리 포트(/metrics, /ready)는 서비스 뼈대가 연다.
// 회차 취소 환불 gRPC(PEAKET_PURCHASE_GRPC_ADDR, BAT-425 GAT-130)와 판매 중지·재개 제어 gRPC(PEAKET_*_CONTROL_GRPC_ADDR, BAT-465 R-584)를 싣는다.
// 명령 요청·결과 사건은 Kafka(ops.command-events)로도 받는다(HTTP /internal/v1/ops/command-events와 같은 처리기).
import 'reflect-metadata';
import { createDatabase, createExternalHttpClient, createService } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { GrpcControlSender } from './adapters/grpc-control-sender.js';
import { GrpcEventRefunds } from './adapters/grpc-event-refunds.js';
import { GrpcAdminAuthz } from './adapters/identity-admin-authz.js';
import { HttpCommandExecutor } from './adapters/http-command-executor.js';
import { kafkaConsumersFromEnv, type OpsConsumers, startOpsConsumers } from './consumers/index.js';
import { auditAnchorSignerFromEnv } from './modules/audit/index.js';
import type { HandleCommandEvent } from './modules/commands/index.js';
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
// 회차 취소 일괄 환불 gRPC(BAT-425 GAT-130). 주소가 없으면 EVENT_CANCEL은 내부 HTTP 호환 경로로 물러난다.
const refunds = purchaseGrpcAddr ? new GrpcEventRefunds({ address: purchaseGrpcAddr }) : undefined;
// queue-svc 클라이언트는 판매 중지·재개 집행(BAT-465 R-584)과 우선 구매 사본(GAT-135)이 함께 쓴다. 요청마다 자기 마감을 넘긴다.
const queueClient = queueUrl ? createExternalHttpClient({ provider: 'queue-svc', baseUrl: queueUrl, timeoutCapMs: 5_000 }) : undefined;
// 제어 gRPC 정본(ADR-0102). 두 주소가 다 있을 때만 판매 중지·재개를 그 길로 보낸다(없으면 HTTP 호환 경로).
const purchaseControlAddr = process.env.PEAKET_PURCHASE_CONTROL_GRPC_ADDR;
const queueControlAddr = process.env.PEAKET_QUEUE_CONTROL_GRPC_ADDR;
const control =
  purchaseControlAddr && queueControlAddr
    ? {
        purchase: new GrpcControlSender({ address: purchaseControlAddr, dependency: 'purchase-svc-control' }),
        queue: new GrpcControlSender({ address: queueControlAddr, dependency: 'queue-svc-control' }),
      }
    : undefined;
const executor = new HttpCommandExecutor({
  ...(purchaseUrl ? { purchase: createExternalHttpClient({ provider: 'purchase-svc', baseUrl: purchaseUrl, timeoutCapMs: 30_000 }) } : {}),
  ...(coreUrl ? { core: createExternalHttpClient({ provider: 'core-svc', baseUrl: coreUrl, timeoutCapMs: 5_000 }) } : {}),
  ...(refunds ? { refunds } : {}),
  ...(queueClient ? { queue: queueClient } : {}),
  ...(control ? { control } : {}),
  internalToken,
});
const priority =
  purchaseUrl && queueClient
    ? {
        purchase: new HttpPurchasePriorityGrants(createExternalHttpClient({ provider: 'purchase-svc', baseUrl: purchaseUrl, timeoutCapMs: 5_000 }), internalToken),
        copies: new HttpQueuePriorityGrantCopies(queueClient, internalToken),
      }
    : undefined;
/** AppModule이 만든 명령 사건 처리기(Kafka 소비자가 HTTP와 같은 객체를 쓴다) */
let commandEvents: HandleCommandEvent | undefined;
// 감사 체크포인트 공개 앵커 서명 키(Ed25519, BAT-465 R-584). 운영은 비밀 관리에서 넣는다.
const anchor = auditAnchorSignerFromEnv(process.env);
const service = await createService({
  name: SERVICE,
  adminAuthz,
  module: AppModule.register({ database, executor, signer: anchor.signer, ...(priority ? { priority } : {}), onCommandEvent: (h) => (commandEvents = h) }),
});
if (anchor.warning) service.logger.warn({}, anchor.warning);
if (!purchaseGrpcAddr) service.logger.warn({}, 'PEAKET_PURCHASE_GRPC_ADDR이 없어 회차 취소 환불 gRPC를 쓰지 않는다(내부 HTTP 호환 경로)');
if (!purchaseUrl && !purchaseGrpcAddr) service.logger.warn({}, 'PEAKET_PURCHASE_HTTP_URL·PEAKET_PURCHASE_GRPC_ADDR이 없어 EVENT_CANCEL 실행을 하지 않는다');
if (!coreUrl) service.logger.warn({}, 'PEAKET_CORE_HTTP_URL이 없어 SCALE_CHANGE 실행을 하지 않는다');
if (!purchaseUrl || !queueUrl) service.logger.warn({}, 'PEAKET_PURCHASE_HTTP_URL·PEAKET_QUEUE_HTTP_URL이 없어 SALE_STOP·SALE_RESUME 실행을 하지 않는다');
if (!priority) service.logger.warn({}, 'PEAKET_PURCHASE_HTTP_URL·PEAKET_QUEUE_HTTP_URL이 없어 우선 구매 권리 발급·회수를 열지 않는다');
await service.listen();

// 명령 요청·결과 사건 소비자(ops.command-events, BAT-465 R-584). HTTP 수신기와 같은 처리기를 쓴다.
let consumers: OpsConsumers | undefined;
try {
  const kafka = kafkaConsumersFromEnv(process.env);
  if (!kafka.enabled) {
    service.logger.warn({}, kafka.warning);
  } else if (commandEvents) {
    const pod = (process.env.PEAKET_POD ?? process.env.HOSTNAME ?? 'local').slice(0, 64);
    consumers = startOpsConsumers({
      env: kafka.env,
      brokers: kafka.brokers,
      clientId: `${SERVICE}-${kafka.env}-${pod}`,
      ...(kafka.auth ? { auth: kafka.auth } : {}),
      database,
      handler: commandEvents,
      logger: service.logger,
    });
    consumers.started.catch((err: unknown) => service.logger.error({ err }, 'ops.command-events 소비자 시작 실패'));
  }
} catch (err) {
  // 설정 오류는 시작 실패다(조용히 사건을 잃지 않는다)
  service.logger.error({ err }, 'Kafka 소비자 설정이 올바르지 않다');
  throw err;
}

process.once('SIGTERM', () => {
  void (async () => {
    try {
      await consumers?.stop();
    } catch (err) {
      service.logger.error({ err }, 'ops.command-events 소비자 종료 실패');
    }
    try {
      await service.close();
    } catch (err) {
      service.logger.error({ err }, 'ops-svc 종료 실패');
    } finally {
      try {
        refunds?.close();
      } catch (err) {
        service.logger.error({ err }, '회차 취소 환불 gRPC 클라이언트 닫기 실패');
      }
      try {
        control?.purchase.close();
        control?.queue.close();
      } catch (err) {
        service.logger.error({ err }, '제어 gRPC 클라이언트 닫기 실패');
      }
      adminAuthz.close();
      await database.close();
    }
  })();
});
