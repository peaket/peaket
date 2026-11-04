// purchase-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱 포트(REST: 좌석 홀드 POST /v1/events/{eventId}/holds)·관리 포트(/metrics, /ready)는 서비스 뼈대가 연다.
// 1초 만료 반복(ExpirySweeper, BUILD_ORDER PRF-135)을 듣기 시작한 뒤 켜고 SIGTERM 때 끈다. 좌석 Lua 지표(seat_lua_errors_total)를 /metrics에 붙인다.
// 아직 운영 구매 세션 저장소(PRF-136)·좌석맵 판·HoldAttempt 보내기(BAS-030)가 없다. 그래서 이 조립은 구매 세션이 늘 없어 홀드가 모두 401이고,
// 좌석맵 판에 회차 설정이 없어 만료 반복은 회차마다 NO_CONFIG로 건너뛴다.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createHotRedis, createService } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { ExpirySweeper, MemorySeatMap, PromSeatSignals, discardHoldAttempts, podIdFrom, unavailablePurchaseSessions } from './modules/inventory/index.js';

const SERVICE = 'purchase-svc';

// 좌석 Redis: 로컬·CI는 단일 노드 주소, 운영은 클러스터 시작 노드 주소들(쉼표)
const clusterUrls = (process.env.PEAKET_SEAT_REDIS_CLUSTER_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const url = process.env.PEAKET_SEAT_REDIS_URL;
if (!url && clusterUrls.length === 0) throw new Error('PEAKET_SEAT_REDIS_URL이나 PEAKET_SEAT_REDIS_CLUSTER_URLS가 없다(비밀 관리에서 넣는다)');

// 만료 임대 값: {HOSTNAME 앞 57자}-{무작위 16진 6자리}. HOSTNAME이 없거나 키 조각 모양이 아니면 무작위 UUID(이 프로세스 안에서만 같다, L5)
const podId = podIdFrom(process.env, (n) => randomBytes(n));

const redis = await createHotRedis(clusterUrls.length > 0 ? { clusterUrls } : { url });
const sessions = unavailablePurchaseSessions;
const signals = new PromSeatSignals();
const service = await createService({
  name: SERVICE,
  module: AppModule.register({ redis, seatMap: new MemorySeatMap(), attempts: discardHoldAttempts, sessions, podId, signals }),
  purchaseSessions: sessions,
});
signals.register(service.metrics.registry);
await service.listen();
const sweeper = service.app.get(ExpirySweeper);
sweeper.start();

process.once('SIGTERM', () => {
  // 만료 반복을 먼저 멈추고(돌던 틱을 기다린다) 서비스를 닫은 뒤 연결을 닫는다. 어느 단계가 실패해도 연결은 닫는다
  void sweeper
    .stop()
    .then(() => service.close())
    .catch((err: unknown) => service.logger.error({ err }, 'purchase-svc 종료 실패'))
    .finally(() => redis.close());
});
