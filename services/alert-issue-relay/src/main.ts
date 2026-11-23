// 티켓 중계 시작(docs/observability.md §5 '경보 보내는 길' 티켓 중계, 기능 F-01-6, OPS-110).
// 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// 환경 값 여섯(계획 docs/review/plans/F-01-6.md §5)이 없거나 키 파일을 읽지 못하면 시작하지 않는다.
// 종료(docs/devops.md §6.4): SIGTERM을 받으면 서비스 뼈대가 먼저 준비 상태를 내리고, 남은 GitHub 호출을 기다린 뒤 닫는다.
import { onSigterm, shutdownInOrder } from '@peaket/platform';
import { buildAlertIssueRelay, SERVICE } from './relay-app.js';

const app = await buildAlertIssueRelay({ env: process.env });
const { service } = app;
onSigterm(() =>
  shutdownInOrder({
    stop: () => [app.idle()],
    closeService: () => service.close(),
    closeConnections: () => [],
    onError: (err) => service.logger.error({ err }, `${SERVICE} 종료 실패`),
  }),
);
await service.listen();
