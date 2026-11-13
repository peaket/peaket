// ops-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// 앱 포트(관제 HTTP /v1/ops/commands)와 관리 포트(/metrics, /ready)는 서비스 뼈대가 연다. 업무 gRPC는 이 골격에 없다(제어 gRPC는 후속).
import 'reflect-metadata';
import { createDatabase, createService } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { GrpcAdminAuthz } from './adapters/identity-admin-authz.js';

const SERVICE = 'ops-svc';
const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');
const identityUrl = process.env.PEAKET_IDENTITY_GRPC_URL;
if (!identityUrl) throw new Error('PEAKET_IDENTITY_GRPC_URL이 없다(identity AdminAuthzService host:port)');

const database = createDatabase({ url, applicationName: SERVICE });
const adminAuthz = new GrpcAdminAuthz(identityUrl);
const service = await createService({ name: SERVICE, adminAuthz, module: AppModule.register({ database }) });
await service.listen();

process.once('SIGTERM', () => {
  void service
    .close()
    .catch((err: unknown) => service.logger.error({ err }, 'ops-svc 종료 실패'))
    .finally(() => {
      adminAuthz.close();
      return database.close();
    });
});
