// v0 모놀리스 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
import 'reflect-metadata';
import { createService } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { createV0Redis } from './redis.js';

const SERVICE = 'v0-monolith';
/** 입장 루프 간격. 1초 칸보다 짧게 두어 칸을 건너뛰지 않는다(docs/features/queue-admission.md §13 동작 4) [가정] */
const TICK_INTERVAL_MS = 250;

const url = process.env.PEAKET_V0_REDIS_URL;
if (!url) throw new Error('PEAKET_V0_REDIS_URL이 없다(대기열 Redis 주소, 비밀 관리에서 넣는다)');

const redis = await createV0Redis(url);
const service = await createService({ name: SERVICE, module: AppModule.register({ queue: { redis, tickIntervalMs: TICK_INTERVAL_MS } }) });
await service.listen();

process.once('SIGTERM', () => {
  // 서비스(입장 루프 포함)를 먼저 닫고 Redis 연결을 닫는다. 닫다 실패해도 연결은 닫는다
  void service
    .close()
    .catch((err: unknown) => service.logger.error({ err }, 'v0 모놀리스 종료 실패'))
    .finally(() => redis.close().catch(() => {}));
});
