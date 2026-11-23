// 증거 수집기 시작(docs/observability.md §5 '진단 증거', ADR-0070 결정 1). 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// 진단 증거 저장소는 진단 수집(RB-31)과 같은 환경 값으로 고른다(PEAKET_DIAG_BUCKET, local·ci의 흉내 서버 주소 PEAKET_DIAG_S3_ENDPOINT,
// deploy/charts/peaket-service/templates/_helpers.tpl). 버킷 이름이 없으면 시작하지 않는다.
// 처리기가 public 하나뿐이고 제어 토픽 설정을 쓰지 않아 startServiceControlSync를 부르지 않는다(신원 처리기가 없으면 listen이 막지 않는다).
// 종료(docs/devops.md §6.4): SIGTERM을 받으면 서비스 뼈대가 먼저 준비 상태를 내리고, 공용 종료 차례(shutdownInOrder)로 도는 수집을 기다린 뒤 닫는다.
import { onSigterm, s3EvidenceStore, shutdownInOrder } from '@peaket/platform';
import { buildEvidenceCollector, SERVICE } from './collector-app.js';

const bucket = process.env.PEAKET_DIAG_BUCKET;
if (!bucket) throw new Error('PEAKET_DIAG_BUCKET이 없다(진단 증거 저장소 버킷 이름)');
const endpoint = process.env.PEAKET_DIAG_S3_ENDPOINT;
const store = s3EvidenceStore({ bucket, ...(endpoint ? { endpoint } : {}) });

const app = await buildEvidenceCollector({ env: process.env, store });
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
