// queue-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱 포트(REST: 사전 검증 POST /v1/queues/{eventId}/pre-verifications, 진입 POST …/entries, 대기 상태 파일 GET …/segment-states/{segment}.json, 입장 확정 POST …/admission)
// ·관리 포트(/metrics, /ready)는 서비스 뼈대가 연다.
import 'reflect-metadata';
import { createHotRedis, createService } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { Es256AdmissionTokens, PromAdmissionSignals } from './modules/admission/index.js';
import { HmacQueueTokens, unavailableRisk } from './modules/entry/index.js';

const SERVICE = 'queue-svc';

// 대기열 Redis: 로컬·CI는 단일 노드 주소, 운영은 클러스터 시작 노드 주소들(쉼표)
const clusterUrls = (process.env.PEAKET_QUEUE_REDIS_CLUSTER_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const url = process.env.PEAKET_QUEUE_REDIS_URL;
if (!url && clusterUrls.length === 0) throw new Error('PEAKET_QUEUE_REDIS_URL이나 PEAKET_QUEUE_REDIS_CLUSTER_URLS가 없다(비밀 관리에서 넣는다)');

const tokens = HmacQueueTokens.fromEnv(process.env);
// 입장 토큰 서명 키(개인 JWK)와 발급자: 비밀 관리에서 시작 때 메모리로 읽는다(OPEN[10] 추천 적용, docs/security/secrets-and-keys.md)
const signer = Es256AdmissionTokens.fromEnv(process.env);
const signals = new PromAdmissionSignals();
const redis = await createHotRedis(clusterUrls.length > 0 ? { clusterUrls } : { url });
// RB-05 복제 확인(WAIT)은 그 연결을 막으므로 클러스터에서는 따로 연결한다(ADR-0186). 단일 노드(로컬·CI)는 복제본이 없어 기다리지 않는다
const waitRedis = clusterUrls.length > 0 ? await createHotRedis({ clusterUrls }) : undefined;
// 위험 판정: trust-svc가 생기기 전(BUILD_ORDER BOT-050)에는 늘 축소 운영(사람 확인 보류)이다
// 대기열 파일의 교차 출처 허용: 소비자 웹 하나(환경마다 주소가 다르다, 없으면 운영 주소)
const webOrigin = process.env.PEAKET_WEB_ORIGIN;
const service = await createService({ name: SERVICE, module: AppModule.register({ redis, ...(waitRedis ? { waitRedis } : {}), tokens, risk: unavailableRisk, state: { ...(webOrigin ? { webOrigin } : {}) }, admission: { signer, signals } }) });
signals.register(service.metrics.registry);
await service.listen();

process.once('SIGTERM', () => {
  // 서비스를 먼저 닫고 연결을 닫는다. 닫다 실패해도 연결은 닫는다
  void service
    .close()
    .catch((err: unknown) => service.logger.error({ err }, 'queue-svc 종료 실패'))
    .finally(() => Promise.all([redis.close(), waitRedis?.close()]));
});
