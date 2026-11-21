// 서비스 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 종료(docs/devops.md §6.4): SIGTERM을 받으면 서비스 뼈대가 먼저 준비 상태를 내리고(/ready 503), 이 파일의 처리기가 공용 종료 차례(shutdownInOrder)로
// 돌던 일 멈춤 → 앱 닫기 → 연결 닫기를 한다. 업무 gRPC 포트를 여는 서비스는 startGrpcServer(…, profile: service.config.grpcLbProfile)의 close를 stop에 넣는다.
// 제어 토픽(ADR-0333 결정 2·3, ADR-0334 결정 2): 모든 서비스가 듣기 전에 startServiceControlSync를 불러 control.settings(로그 레벨·온세일 로그 표본)를 읽고,
// 서비스를 닫은 뒤 끈다. 게이트웨이 신원 머리를 받는 처리기(public 말고 @Roles)가 있으면 종료 세션 목록도 함께 읽는다(기본). local·ci 밖에서 빠뜨리면 listen이 시작하지 않는다.
// 신원 처리기가 없는 서비스는 startServiceControlSync(service, process.env, { sessions: false })로 설정 토픽만 읽는다
import { createDatabase, createService, onSigterm, shutdownInOrder } from '@peaket/platform';
import { startServiceControlSync } from '@peaket/platform/stream-worker';
import { AppModule } from './app.module.js';

const SERVICE = 'example-svc';
const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');

const database = createDatabase({ url, applicationName: SERVICE });
const service = await createService({ name: SERVICE, module: AppModule.register({ database }) });
const controlSync = startServiceControlSync(service, process.env);
onSigterm(() =>
  shutdownInOrder({
    stop: () => [],
    closeService: () => service.close(),
    closeConnections: () => [controlSync?.close(), database.close()],
    onError: (err) => service.logger.error({ err }, `${SERVICE} 종료 실패`),
  }),
);
await service.listen();
