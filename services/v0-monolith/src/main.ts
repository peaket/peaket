// v0 모놀리스 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
import 'reflect-metadata';
import { createDatabase, createService } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { createPgDeltaFeed } from './modules/inventory/index.js';
import { createV0PaymentGateway } from './modules/payment/index.js';
import { createAdmissionReader } from './modules/queue/index.js';
import { createV0Redis } from './redis.js';

const SERVICE = 'v0-monolith';
/** 입장 루프 간격. 1초 칸보다 짧게 두어 칸을 건너뛰지 않는다(docs/features/queue-admission.md §13 동작 4) [가정] */
const TICK_INTERVAL_MS = 250;
/** 홀드 만료 루프 간격(docs/features/seat-hold.md §14 동작 5) [가정] */
const EXPIRY_INTERVAL_MS = 1_000;

const need = (name: string, what: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name}이 없다(${what})`);
  return v;
};
const redisUrl = need('PEAKET_V0_REDIS_URL', '대기열 Redis 주소, 비밀 관리에서 넣는다');
const databaseUrl = need('PEAKET_V0_DATABASE_URL', '좌석 v0 DB 주소, 비밀 관리에서 넣는다');
const allowedOrigins = need('PEAKET_V0_ALLOWED_ORIGINS', '변경분 WebSocket의 허용 출처, 쉼표로 나눈다')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (allowedOrigins.length === 0) throw new Error('PEAKET_V0_ALLOWED_ORIGINS에 허용 출처가 하나도 없다');
// 결제 v0의 결제사는 PG 시뮬레이터다(docs/features/payment.md §13 '결제 포트')
const pgUrl = need('PEAKET_V0_PG_URL', '결제사(PG 시뮬레이터) 주소');
const pgSecretKey = need('PG_SIMULATOR_SECRET_KEY', 'PG 시뮬레이터 시험 키, 비밀 관리에서 넣는다');

const redis = await createV0Redis(redisUrl);
const database = createDatabase({ url: databaseUrl, applicationName: SERVICE, profile: 'hot' });
const deltaFeed = createPgDeltaFeed(databaseUrl);
await deltaFeed.ready();
const service = await createService({
  name: SERVICE,
  module: AppModule.register({
    queue: { redis, tickIntervalMs: TICK_INTERVAL_MS },
    inventory: { database, admission: createAdmissionReader(redis), deltaFeed, allowedOrigins, expiryIntervalMs: EXPIRY_INTERVAL_MS },
    sale: { gateway: createV0PaymentGateway({ baseUrl: pgUrl, secretKey: pgSecretKey }) },
  }),
});
await service.listen();

process.once('SIGTERM', () => {
  // 서비스(입장·만료 루프 포함)를 먼저 닫고 연결을 닫는다. 닫다 실패해도 연결은 닫는다
  void service
    .close()
    .catch((err: unknown) => service.logger.error({ err }, 'v0 모놀리스 종료 실패'))
    .finally(() => Promise.allSettled([redis.close(), deltaFeed.close(), database.close()]));
});
