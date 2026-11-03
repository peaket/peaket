// purchase-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱 포트(REST: 좌석 홀드 POST /v1/events/{eventId}/holds)·관리 포트(/metrics, /ready)는 서비스 뼈대가 연다.
// PRF-130 ①에는 운영 구매 세션 저장소(PRF-135)·좌석맵 판·HoldAttempt 보내기(BAS-030)가 없다. 그래서 이 조립은 구매 세션이 늘 없어 홀드가 모두 401이다.
import 'reflect-metadata';
import { createHotRedis, createService } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { MemorySeatMap, discardHoldAttempts, unavailablePurchaseSessions } from './modules/inventory/index.js';

const SERVICE = 'purchase-svc';

// 좌석 Redis: 로컬·CI는 단일 노드 주소, 운영은 클러스터 시작 노드 주소들(쉼표)
const clusterUrls = (process.env.PEAKET_SEAT_REDIS_CLUSTER_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const url = process.env.PEAKET_SEAT_REDIS_URL;
if (!url && clusterUrls.length === 0) throw new Error('PEAKET_SEAT_REDIS_URL이나 PEAKET_SEAT_REDIS_CLUSTER_URLS가 없다(비밀 관리에서 넣는다)');

const redis = await createHotRedis(clusterUrls.length > 0 ? { clusterUrls } : { url });
const sessions = unavailablePurchaseSessions;
const service = await createService({
  name: SERVICE,
  module: AppModule.register({ redis, seatMap: new MemorySeatMap(), attempts: discardHoldAttempts, sessions }),
  purchaseSessions: sessions,
});
await service.listen();

process.once('SIGTERM', () => {
  // 서비스를 먼저 닫고 연결을 닫는다. 닫다 실패해도 연결은 닫는다
  void service
    .close()
    .catch((err: unknown) => service.logger.error({ err }, 'purchase-svc 종료 실패'))
    .finally(() => redis.close());
});
