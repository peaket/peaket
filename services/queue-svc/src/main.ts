// queue-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱 포트(REST: 사전 검증 POST /v1/queues/{eventId}/pre-verifications, 진입 POST …/entries, 대기 상태 파일 GET …/segment-states/{segment}.json, 입장 확정 POST …/admission)
// ·관리 포트(/metrics, /ready)는 서비스 뼈대가 연다. 듣기 시작한 뒤 Kafka 소비자(구매 세션·탈퇴·회차 판매 상태, ADR-0214)를 켠다.
import 'reflect-metadata';
import { Counter, createHotRedis, createService, errorSummary, Gauge, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { kafkaConsumersFromEnv } from './consumers/index.js';
import { type QueueConsumers, startQueueConsumers } from './consumers/start.js';
import { Es256AdmissionTokens, PromAdmissionSignals, PurchaseSessionHandler, PurchaseSessionSlots } from './modules/admission/index.js';
import { AccountWithdrawnHandler, HmacQueueTokens, PurgeWithdrawnKeys, RedisEventSchedules, RedisWithdrawnDue, unavailableRisk, WithdrawnDueWorker } from './modules/entry/index.js';
import { ApplySaleChange, EventSaleChangedHandler, RedisSaleStates } from './modules/sale/index.js';

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
// Kafka 소비자 설정은 듣기 전에 읽는다(브로커 주소가 없으면 local·ci만 경고로 끄고 그 밖은 여기서 시작에 실패한다)
const kafka = kafkaConsumersFromEnv(process.env);
const service = await createService({ name: SERVICE, module: AppModule.register({ redis, ...(waitRedis ? { waitRedis } : {}), tokens, risk: unavailableRisk, state: { ...(webOrigin ? { webOrigin } : {}) }, admission: { signer, signals } }) });
signals.register(service.metrics.registry);
await service.listen();

// Kafka 소비자(ADR-0214 결정 1): 듣기 시작한 뒤 켠다. 연결·구독이 실패하면 오류 한 줄 뒤 SIGTERM과 같은 차례로 끝내고 종료 코드 1로 나간다(쿠버네티스가 다시 띄운다)
let consumers: QueueConsumers | undefined;
let dueWorker: WithdrawnDueWorker | undefined;
if (!kafka.enabled) service.logger.warn({ dep: 'kafka' }, kafka.warning);
else {
  const pod = (process.env.PEAKET_POD ?? process.env.HOSTNAME ?? 'local').slice(0, 64);
  // 탈퇴 사건의 처리할 때 집합(ADR-0214 결정 7): 때가 안 된 사건은 여기 넣고 바로 커밋한다. 모든 파드의 반복이 빌려 꺼내 처리한다
  const purge = service.app.get(PurgeWithdrawnKeys);
  const due = new RedisWithdrawnDue(redis, systemClock);
  // 지표(docs/observability.md §5): 가장 오래 기다린 항목의 지난 초, 꺼내기·처리 실패, 값이 사라져 버린 항목
  const registers = [service.metrics.registry];
  const lag = new Gauge({ name: 'queue_withdrawn_due_lag_seconds', help: '처리할 때가 지났는데 아직 처리하지 못한 가장 오래된 탈퇴 사건의 지난 초(없으면 0)', registers });
  const failed = new Counter({ name: 'queue_withdrawn_due_failures_total', help: '탈퇴 사건 처리할 때 집합의 꺼내기(claim)·처리(process) 실패', labelNames: ['stage'] as const, registers });
  const expired = new Counter({ name: 'queue_withdrawn_due_expired_total', help: '값이 수명(purgeBy)으로 사라져 처리하지 못하고 지운 탈퇴 사건', registers });
  dueWorker = new WithdrawnDueWorker(due, purge, systemClock, {
    logger: service.logger,
    signals: { lag: (sec) => lag.set(sec), failed: (stage) => failed.inc({ stage }), expired: (n) => expired.inc(n) },
  });
  dueWorker.start();
  consumers = startQueueConsumers({
    env: kafka.env,
    brokers: kafka.brokers,
    clientId: `queue-svc-${kafka.env}-${pod}`,
    auth: kafka.auth,
    redis,
    handlers: {
      purchaseSessions: new PurchaseSessionHandler(service.app.get(PurchaseSessionSlots)),
      // 종료 세션 목록으로 탈퇴 전 토큰을 막기 전에는 withdrawnAt + 15분 뒤에 처리한다(기본 미루기, ADR-0214 결정 7)
      accountsWithdrawn: new AccountWithdrawnHandler(purge, undefined, { due, logger: service.logger }),
      saleChanged: new EventSaleChangedHandler(new ApplySaleChange(new RedisSaleStates(redis), new RedisEventSchedules(redis, systemClock), systemClock)),
    },
    registry: service.metrics.registry,
    logger: service.logger,
  });
  consumers.started.catch((err: unknown) => {
    service.logger.error({ dep: 'kafka', err: errorSummary(err) }, 'Kafka 소비자를 켜지 못해 queue-svc를 끝낸다');
    process.exitCode = 1;
    shutdown();
  });
}

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  // Kafka 소비자를 먼저 멈추고(받기를 멈추고 처리 중인 키를 마친 뒤 커밋), 서비스를 닫은 뒤 연결을 닫는다. 어느 단계가 실패해도 연결은 닫는다
  void (consumers?.stop() ?? Promise.resolve())
    .then(() => dueWorker?.stop())
    .catch((err: unknown) => service.logger.error({ err: errorSummary(err) }, 'Kafka 소비자 멈추기 실패(나머지는 그대로 끝낸다)'))
    .then(() => service.close())
    .catch((err: unknown) => service.logger.error({ err }, 'queue-svc 종료 실패'))
    .finally(() => Promise.all([redis.close(), waitRedis?.close()]));
}
process.once('SIGTERM', shutdown);
