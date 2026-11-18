// 서비스 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 종료(docs/devops.md §6.4): SIGTERM을 받으면 서비스 뼈대가 먼저 준비 상태를 내리고(/ready 503), 이 파일의 처리기가 공용 종료 차례(shutdownInOrder)로
// 돌던 일 멈춤 → 앱 닫기 → 연결 닫기를 한다. 업무 gRPC 포트를 여는 서비스는 startGrpcServer(…, profile: service.config.grpcLbProfile)의 close를 stop에 넣는다.
import { createDatabase, createService, onSigterm, shutdownInOrder } from '@peaket/platform';
import { AppModule } from './app.module.js';

const SERVICE = 'example-svc';
const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');

const database = createDatabase({ url, applicationName: SERVICE });
const service = await createService({ name: SERVICE, module: AppModule.register({ database }) });
onSigterm(() =>
  shutdownInOrder({
    stop: () => [],
    closeService: () => service.close(),
    closeConnections: () => [database.close()],
    onError: (err) => service.logger.error({ err }, `${SERVICE} 종료 실패`),
  }),
);
await service.listen();
