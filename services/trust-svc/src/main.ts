// trust-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱 포트·관리 포트(/metrics, /ready)는 서비스 뼈대가, 업무 gRPC 포트(ScoreRisk)는 이 파일이 연다.
// 비공개 규칙 설정을 읽어야 준비 상태가 된다(docs/features/bot-defense.md §4.4). 기준값·가중치는 파일로만 받고 저장소에 두지 않는다(POL-006).
import 'reflect-metadata';
import { CircuitBreaker, createHotRedis, createService, ReloadingAsnTable, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { startGrpcServer } from './grpc-server.js';
import { hmacDeviceRefsFromEnv, LogVerdictRecorder, PromTrustSignals, RedisFeatureStore, RuleBook, ScoreRisk, startRuleRefresh, TURNSTILE_BREAKER, trustPackage, trustServiceHandlers, turnstileFromEnv } from './modules/scoring/index.js';

const SERVICE = 'trust-svc';
/** 업무 gRPC 포트 [가정](identity-svc와 같은 기본값, BUILD_ORDER BAS-080이 공용 설정으로 옮긴다) */
const DEFAULT_GRPC_PORT = 50051;
const RULES_READY_TASK = 'trust-rules';

const env = process.env;
const grpcPort = Number(env.PEAKET_GRPC_PORT ?? DEFAULT_GRPC_PORT);
if (!(Number.isInteger(grpcPort) && grpcPort > 0 && grpcPort <= 65535)) throw new Error(`PEAKET_GRPC_PORT가 틀렸다: ${env.PEAKET_GRPC_PORT}`);

// 판정 피처 Redis(세션·캐시 클러스터, docs/data.md §3): 로컬·CI는 단일 노드 주소, 운영은 클러스터 시작 노드 주소들(쉼표)
const clusterUrls = (env.PEAKET_TRUST_REDIS_CLUSTER_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const redisUrl = env.PEAKET_TRUST_REDIS_URL;
if (!redisUrl && clusterUrls.length === 0) throw new Error('PEAKET_TRUST_REDIS_URL이나 PEAKET_TRUST_REDIS_CLUSTER_URLS가 없다(비밀 관리에서 넣는다)');
const rulesFile = env.PEAKET_TRUST_RULES_FILE;
if (!rulesFile) throw new Error('PEAKET_TRUST_RULES_FILE이 없다(비공개 규칙 설정 파일 경로, 비밀 관리에서 넣는다)');
const devices = hmacDeviceRefsFromEnv(env);
const asnFile = env.PEAKET_ASN_TABLE_FILE;

const redis = await createHotRedis(clusterUrls.length > 0 ? { clusterUrls } : { url: redisUrl });
const service = await createService({ name: SERVICE, module: AppModule });
const signals = new PromTrustSignals();
signals.register(service.metrics.registry);
for (const w of devices.warning ? [devices.warning] : []) service.logger.warn({ dep: 'inv-ref-key-device' }, w);

const breaker = new CircuitBreaker({ service: SERVICE, dependency: 'turnstile', registry: service.metrics.registry, logger: service.logger, ...TURNSTILE_BREAKER });
const rules = new RuleBook(rulesFile, { warn: (m) => service.logger.warn({ dep: 'trust-rules' }, m) });
const asn = new ReloadingAsnTable({
  load: asnFile ? () => import('node:fs/promises').then((f) => f.readFile(asnFile, 'utf8')) : async () => undefined,
  clock: systemClock,
  onError: (reason) => service.logger.warn({ dep: 'asn-table', reason }, 'ASN 분류표를 읽지 못해 마지막 판을 쓴다'),
});
if (!asnFile) service.logger.warn({ dep: 'asn-table' }, 'PEAKET_ASN_TABLE_FILE이 없어 ASN을 모두 그 밖으로 본다');
asn.start();
const pending = new Set<Promise<void>>();
const score = new ScoreRisk({
  rules,
  human: turnstileFromEnv(env, breaker),
  features: new RedisFeatureStore(redis),
  devices: devices.refs,
  asn,
  recorder: new LogVerdictRecorder(service.logger),
  signals,
  clock: systemClock,
  after: (work) => {
    const p = work().finally(() => pending.delete(p));
    pending.add(p);
  },
});

// 설정을 읽어야 준비 상태가 된다(§4.4). 처음에 못 읽었으면 5초마다, 읽은 뒤에는 5분마다 다시 읽는다(실패하면 마지막 판을 쓴다)
const rulesLoop = startRuleRefresh({ rules, readiness: service.readiness, task: RULES_READY_TASK });
await rulesLoop.first;

await service.listen();
const grpc = await startGrpcServer({
  host: env.PEAKET_GRPC_HOST ?? '0.0.0.0',
  port: grpcPort,
  services: [{ definition: trustPackage().TrustService.service, handlers: trustServiceHandlers(score, (method, err) => service.logger.error({ err, method }, 'TrustService 처리 실패')) }],
});
service.logger.info({ port: grpc.port }, '업무 gRPC 포트를 열었다');

process.once('SIGTERM', () => {
  rulesLoop.stop();
  asn.stop();
  // 받는 호출을 먼저 닫고, 처리 중인 일과 응답 뒤로 미룬 쓰기가 끝나면 연결을 닫는다
  void grpc
    .close()
    .then(() => Promise.all(pending))
    .then(() => service.close())
    .catch((err: unknown) => service.logger.error({ err }, 'trust-svc 종료 실패'))
    .finally(() => {
      breaker.shutdown();
      return redis.close();
    });
});
