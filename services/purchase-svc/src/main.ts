// purchase-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱 포트(REST: 좌석 홀드 POST /v1/events/{eventId}/holds, 좌석 스냅샷 GET /v1/events/{eventId}/seatmap-snapshot)·관리 포트(/metrics, /ready)는 서비스 뼈대가 연다.
// 1초 만료 반복(ExpirySweeper, BUILD_ORDER PRF-135)과 구매 세션 정리 반복(SessionSweeper, PRF-138)을 듣기 시작한 뒤 켜고 SIGTERM 때 끈다. 좌석 Lua 지표(seat_lua_errors_total)를 /metrics에 붙인다.
// 구매 세션은 좌석 Redis의 s:jti·s:session과 서버 고정 ECDH 개인키(PEAKET_PURCHASE_ECDH_KEY)로 확인한다(BUILD_ORDER PRF-136). 입장 토큰은 공개키 묶음
// (PEAKET_ADMISSION_JWKS)과 발급자(PEAKET_ADMISSION_ISSUER)로 확인하고, 스냅샷 API가 입장 토큰의 첫 사용에 구매 세션을 연다(PRF-137).
// 좌석맵 판은 환경 값 PEAKET_SEATMAP_DIR 폴더의 {eventId}.json이다(docs/features/seat-hold.md §2 '운영 좌석맵 판'). 30초 [가정]마다 읽은 회차를 다시 읽는다.
// HoldAttempt 보내기(BAS-030)는 아직 없어 시도 기록은 버린다.
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { createHotRedis, createService, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import {
  ExpirySweeper,
  FileSeatMapSource,
  LayoutSeatMap,
  PromSeatSignals,
  RedisPurchaseSessionStore,
  RedisSessionEndedLog,
  RedisSessionIndex,
  RedisSessionStartedLog,
  SessionSweeper,
  ServerEcdhKey,
  StoredPurchaseSessions,
  discardHoldAttempts,
  parseAdmissionJwks,
  podIdFrom,
} from './modules/inventory/index.js';

const SERVICE = 'purchase-svc';
/** 좌석맵 판 파일을 다시 읽는 주기 30초 [가정](docs/features/seat-hold.md §2 '운영 좌석맵 판') */
const SEATMAP_REFRESH_MS = 30_000;

// 좌석 Redis: 로컬·CI는 단일 노드 주소, 운영은 클러스터 시작 노드 주소들(쉼표)
const clusterUrls = (process.env.PEAKET_SEAT_REDIS_CLUSTER_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const url = process.env.PEAKET_SEAT_REDIS_URL;
if (!url && clusterUrls.length === 0) throw new Error('PEAKET_SEAT_REDIS_URL이나 PEAKET_SEAT_REDIS_CLUSTER_URLS가 없다(비밀 관리에서 넣는다)');

const need = (name: string, what: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name}가 없다(${what})`);
  return v;
};
// 입장 토큰 공개키 묶음과 발급자(공개 값이라 설정에서 넣는다. 바꾸면 다시 시작한다, docs/features/seat-hold.md §2), 좌석맵 판 폴더
const admissionKeys = parseAdmissionJwks(need('PEAKET_ADMISSION_JWKS', '입장 토큰 공개키 묶음 JWKS JSON'));
const admissionIssuer = need('PEAKET_ADMISSION_ISSUER', '입장 토큰 발급자 iss');
const seatMapDir = need('PEAKET_SEATMAP_DIR', '회차별 좌석맵 판 파일 {eventId}.json이 있는 폴더');

// 만료 임대 값: {HOSTNAME 앞 57자}-{무작위 16진 6자리}. HOSTNAME이 없거나 키 조각 모양이 아니면 무작위 UUID(이 프로세스 안에서만 같다, L5)
const podId = podIdFrom(process.env, (n) => randomBytes(n));

// 서버 고정 ECDH 개인키: Secrets Manager에서 시작 때 메모리로만 읽는다(없거나 틀리면 시작하지 않는다, docs/security/secrets-and-keys.md)
const ecdh = ServerEcdhKey.fromEnv(process.env);

const redis = await createHotRedis(clusterUrls.length > 0 ? { clusterUrls } : { url });
const sessionStore = new RedisPurchaseSessionStore(redis);
const sessions = new StoredPurchaseSessions({ store: sessionStore, ecdh, clock: systemClock });
const signals = new PromSeatSignals();
// 서비스 로거는 서비스를 만든 뒤에야 생기므로, 좌석맵 판은 늦게 묶는 로거로 경고를 남긴다(판 파일은 처음 요청 때 읽는다)
let log: { warn(obj: object, msg: string): void } | undefined;
const seatMap = new LayoutSeatMap({ source: new FileSeatMapSource(seatMapDir), clock: systemClock, logger: { warn: (o, m) => log?.warn(o, m) } });
const service = await createService({
  name: SERVICE,
  module: AppModule.register({
    redis,
    seatMap,
    attempts: discardHoldAttempts,
    sessions,
    podId,
    signals,
    admission: {
      store: sessionStore,
      startedLog: new RedisSessionStartedLog(redis),
      endedLog: new RedisSessionEndedLog(redis),
      index: new RedisSessionIndex(redis),
      keys: admissionKeys,
      issuer: admissionIssuer,
    },
  }),
  purchaseSessions: sessions,
});
log = service.logger;
signals.register(service.metrics.registry);
await service.listen();
const sweeper = service.app.get(ExpirySweeper);
sweeper.start();
// 구매 세션 정리 반복(유휴·최대 체류, BUILD_ORDER PRF-138). 만료 반복과 같이 켜고 끈다
const sessionSweeper = service.app.get(SessionSweeper);
sessionSweeper.start();
const seatMapRefresh = setInterval(() => void seatMap.refresh(), SEATMAP_REFRESH_MS);
seatMapRefresh.unref();

process.once('SIGTERM', () => {
  // 좌석맵 판 다시 읽기를 멈추고, 만료 반복을 멈추고(돌던 틱을 기다린다) 서비스를 닫은 뒤 연결을 닫는다. 어느 단계가 실패해도 연결은 닫는다
  clearInterval(seatMapRefresh);
  void Promise.all([sweeper.stop(), sessionSweeper.stop()])
    .then(() => service.close())
    .catch((err: unknown) => service.logger.error({ err }, 'purchase-svc 종료 실패'))
    .finally(() => redis.close());
});
