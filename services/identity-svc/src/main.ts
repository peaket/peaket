// identity-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱 포트(REST, 지금은 없음)·관리 포트(/metrics, /ready)는 서비스 뼈대가, 업무 gRPC 포트는 이 파일이 연다.
import 'reflect-metadata';
import { createDatabase, createService } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { startGrpcServer } from './grpc-server.js';
import { CreateSession, EndSession, HmacDeviceRefs, IssueReauthToken, identityPackage, JoseTokenSigner, PromSessionSignals, sessionServiceHandlers } from './modules/session/index.js';

const SERVICE = 'identity-svc';
/** 업무 gRPC 포트 [가정](정본에 값이 없다. BUILD_ORDER BAS-080이 공용 설정으로 옮긴다) */
const DEFAULT_GRPC_PORT = 50051;

const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');
const grpcPort = Number(process.env.PEAKET_GRPC_PORT ?? DEFAULT_GRPC_PORT);
if (!(Number.isInteger(grpcPort) && grpcPort > 0 && grpcPort <= 65535)) throw new Error(`PEAKET_GRPC_PORT가 틀렸다: ${process.env.PEAKET_GRPC_PORT}`);

const signer = await JoseTokenSigner.fromEnv(process.env);
const devices = HmacDeviceRefs.fromEnv(process.env);
const signals = new PromSessionSignals();
const database = createDatabase({ url, applicationName: SERVICE });
const service = await createService({ name: SERVICE, module: AppModule.register({ database, session: { signer, deviceRefs: devices.refs, signals } }) });
signals.register(service.metrics.registry);
if (devices.warning) service.logger.warn(devices.warning);

await service.listen();
const grpc = await startGrpcServer({
  host: process.env.PEAKET_GRPC_HOST ?? '0.0.0.0',
  port: grpcPort,
  services: [
    {
      definition: identityPackage().SessionService.service,
      handlers: sessionServiceHandlers(
        { create: service.app.get(CreateSession), end: service.app.get(EndSession), reauth: service.app.get(IssueReauthToken) },
        (method, err) => service.logger.error({ err, method }, 'SessionService 처리 실패'),
      ),
    },
  ],
});
service.logger.info({ port: grpc.port }, '업무 gRPC 포트를 열었다');

process.once('SIGTERM', () => {
  // gRPC 포트를 먼저 닫아 새 호출을 받지 않고, 처리 중인 호출이 끝나면 서비스와 연결을 닫는다
  void grpc
    .close()
    .then(() => service.close())
    .catch((err: unknown) => service.logger.error({ err }, 'identity-svc 종료 실패'))
    .finally(() => database.close());
});
