// trust-svc 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
// 앱 포트·관리 포트(/metrics, /ready)는 서비스 뼈대가, 업무 gRPC 포트(TrustService.ScoreRisk, TrustLabelService.ApplyLabel, TrustEvidenceService.GetVerdictEvidence)는 이 파일이 연다.
// 비공개 규칙 설정을 읽어야 준비 상태가 된다(docs/features/bot-defense.md §4.4). 기준값·가중치는 파일로만 받고 저장소에 두지 않는다(POL-006).
import 'reflect-metadata';
import { CircuitBreaker, createHotRedis, createService, invRefKeyInfoGauge, kafkaTelemetrySend, type KafkaTelemetrySender, ReloadingAsnTable, systemClock, telemetryDroppedCounter, telemetryKafkaFromEnv, TelemetrySink } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { startGrpcServer } from './grpc-server.js';
import {
  ApplyLabel,
  deviceRefsFromEnv,
  GetVerdictEvidence,
  JsonTelemetryRecorder,
  kmsMacClient,
  LogBlockListChange,
  LogVerdictRecorder,
  PromTrustSignals,
  RecordHoneypot,
  RedisFeatureStore,
  RedisLabelStore,
  RuleBook,
  ScoreRisk,
  startRuleRefresh,
  TURNSTILE_BREAKER,
  trustEvidenceServiceHandlers,
  trustLabelServiceHandlers,
  trustPackage,
  trustServiceHandlers,
  turnstileFromEnv,
} from './modules/scoring/index.js';

const SERVICE = 'trust-svc';
/** 업무 gRPC 포트 [가정](identity-svc와 같은 기본값, BUILD_ORDER BAS-080이 공용 설정으로 옮긴다) */
const DEFAULT_GRPC_PORT = 50051;
const RULES_READY_TASK = 'trust-rules';
/** 종료 때 남은 텔레메트리를 보내는 시간 [가정] */
const TELEMETRY_CLOSE_MS = 2_000;

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
// 기기 라벨 키: 운영은 KMS GenerateMac, local·ci·demo는 설정값. identity-svc와 같은 키여야 같은 기기 가명이 나온다(§4.9, B-T16).
// 키 회전의 이음 기간에는 옛 판(PEAKET_INV_REF_DEVICE_PREVIOUS_*)과 이음 끝(PEAKET_INV_REF_DEVICE_BRIDGE_UNTIL)도 같은 이름으로 읽는다(§4.10)
const devices = deviceRefsFromEnv(env, systemClock, (endpoint) => kmsMacClient({ region: env.AWS_REGION ?? 'ap-northeast-2', ...(endpoint ? { endpoint } : {}) }));
const asnFile = env.PEAKET_ASN_TABLE_FILE;
// 판정 기록·행동 신호(텔레메트리 클러스터, ADR-0249 결정 4). 없거나 틀리면 경고하고 그 기능만 끈다(값 있음은 배포 검사가 막는다)
const telemetryKafka = telemetryKafkaFromEnv(SERVICE, env);

const redis = await createHotRedis(clusterUrls.length > 0 ? { clusterUrls } : { url: redisUrl });
const features = new RedisFeatureStore(redis);
const signals = new PromTrustSignals();
const pending = new Set<Promise<void>>();
const after = (work: () => Promise<void>): void => {
  const p = work().finally(() => pending.delete(p));
  pending.add(p);
};
// 앱 포트의 허니팟 처리기가 쓰므로 뼈대보다 먼저 만들고, 내보내는 쪽은 뼈대의 지표 레지스트리가 생긴 뒤 잇는다
let telemetry: JsonTelemetryRecorder | undefined;
const honeypot = new RecordHoneypot({ features, recorder: { honeypot: (r) => telemetry?.honeypot(r) }, signals, clock: systemClock, after });
const service = await createService({ name: SERVICE, module: AppModule.register({ honeypot }) });
signals.register(service.metrics.registry);
// 꺼져 있어도 낼 기록은 버린 수로 센다(지표로 드러난다)
const dropped = telemetryDroppedCounter(service.metrics.registry);
let sink: TelemetrySink | undefined;
let telemetrySender: KafkaTelemetrySender | undefined;
const telemetryOff = (warning: string): void => {
  telemetry = new JsonTelemetryRecorder({ offer: (record) => dropped(record, 1), dropped: (record) => dropped(record, 1) });
  service.logger.warn({ dep: 'telemetry-kafka' }, warning);
};
if (telemetryKafka.enabled) {
  try {
    // 네이티브 모듈은 켤 때만 싣는다(시험과 Kafka 없는 환경은 모듈 없이 돈다). 싣지 못해도 시작은 막지 않는다
    const { createKafkaProducer } = await import('@peaket/platform/stream-worker');
    const pod = (env.PEAKET_POD ?? env.HOSTNAME ?? 'local').slice(0, 64);
    // 연결은 보낼 때 맺고, 실패하면 새 생산자로 다시 잇는다: 브로커가 멈춰도 파드는 뜨고 판정은 이어진다
    const { brokers, auth, env: kafkaEnv } = telemetryKafka;
    const sender = kafkaTelemetrySend(() => createKafkaProducer({ kind: 'default', brokers, clientId: `${SERVICE}-${kafkaEnv}-${pod}`, auth }));
    telemetrySender = sender;
    const telemetrySink = new TelemetrySink({ send: sender, onDropped: dropped });
    sink = telemetrySink;
    telemetry = new JsonTelemetryRecorder({ offer: (record, topic, m) => telemetrySink.offer(record, topic, m), dropped: (record) => dropped(record, 1) });
  } catch {
    telemetryOff('Kafka 클라이언트를 싣지 못해 판정 기록·행동 신호를 Kafka로 보내지 않는다');
  }
} else {
  telemetryOff(telemetryKafka.warning);
}
for (const w of devices.warnings) service.logger.warn({ dep: 'inv-ref-key-device' }, w);
devices.ring.onMissing((label, reason) => signals.invRefMissing(label, reason));
devices.ring.onRefreshError((label, reason, err) => service.logger.warn({ dep: 'inv-ref-key-device', label, reason, err }, '조사용 가명 라벨 키를 다시 받지 못했다(§4.9)'));
// 라벨 키의 지문(키 값이 아니다): identity-svc의 device 지문과 같아야 한다(B-T16, ADR-0251 배포 조건)
const invRefKeyInfo = invRefKeyInfoGauge(service.metrics.registry, SERVICE);
devices.ring.onFingerprint((label, version, fingerprint) => {
  invRefKeyInfo(label, version, fingerprint);
  service.logger.info({ dep: 'inv-ref-key-device', label, version, fingerprint }, '조사용 가명 라벨 키 지문');
});
// 뜰 때 2초 [가정]까지 먼저 받아 본다. 받지 못해도 시작은 막지 않는다(기기 칸이 비고 degraded로 드러난다)
const deviceKeys = devices.ring.start();
await deviceKeys.ready;

const breaker = new CircuitBreaker({ service: SERVICE, dependency: 'turnstile', registry: service.metrics.registry, logger: service.logger, ...TURNSTILE_BREAKER });
const rules = new RuleBook(rulesFile, { warn: (m) => service.logger.warn({ dep: 'trust-rules' }, m) });
const asn = new ReloadingAsnTable({
  load: asnFile ? () => import('node:fs/promises').then((f) => f.readFile(asnFile, 'utf8')) : async () => undefined,
  clock: systemClock,
  onError: (reason) => service.logger.warn({ dep: 'asn-table', reason }, 'ASN 분류표를 읽지 못해 마지막 판을 쓴다'),
});
if (!asnFile) service.logger.warn({ dep: 'asn-table' }, 'PEAKET_ASN_TABLE_FILE이 없어 ASN을 모두 그 밖으로 본다');
asn.start();
const logRecorder = new LogVerdictRecorder(service.logger);
const score = new ScoreRisk({
  rules,
  human: turnstileFromEnv(env, breaker),
  features,
  devices: devices.refs,
  asn,
  recorder: {
    record: (r) => {
      logRecorder.record(r);
      telemetry?.record(r);
    },
  },
  behaviors: { behavior: (r) => telemetry?.behavior(r) },
  signals,
  clock: systemClock,
  after,
});

// 라벨 반영(§9 '첫 구현'): 차단 기기 목록을 바꾸는 유일한 길이다. 부르는 쪽을 ops-svc로 줄이는 것은 메시 L7 허용 목록이다
const applyLabel = new ApplyLabel({
  store: new RedisLabelStore(redis),
  recorder: { label: (r) => telemetry?.label(r) },
  // 처리자는 서비스 뼈대의 로그 가명(정규 로그 줄의 accountRef와 같은 키)으로만 남긴다
  log: new LogBlockListChange(service.logger, service.pseudonymizer),
  signals,
  devices: devices.refs,
  clock: systemClock,
});

// 판정 근거 조회(§12 '판정에 쓰는 자료'): 이의 심사가 판정 근거 키와 그 기기의 이력을 읽기만 한다. 부르는 쪽을 ops-svc로 줄이는 것은 메시 L7 허용 목록이다(B-T15 ②)
const verdictEvidence = new GetVerdictEvidence({ store: features, clock: systemClock });

// 설정을 읽어야 준비 상태가 된다(§4.4). 처음에 못 읽었으면 5초마다, 읽은 뒤에는 5분마다 다시 읽는다(실패하면 마지막 판을 쓴다)
const rulesLoop = startRuleRefresh({ rules, readiness: service.readiness, task: RULES_READY_TASK });
await rulesLoop.first;

await service.listen();
const grpc = await startGrpcServer({
  host: env.PEAKET_GRPC_HOST ?? '0.0.0.0',
  port: grpcPort,
  services: [
    { definition: trustPackage().TrustService.service, handlers: trustServiceHandlers(score, (method, err) => service.logger.error({ err, method }, 'TrustService 처리 실패')) },
    { definition: trustPackage().TrustLabelService.service, handlers: trustLabelServiceHandlers(applyLabel, (method, err) => service.logger.error({ err, method }, 'TrustLabelService 처리 실패')) },
    { definition: trustPackage().TrustEvidenceService.service, handlers: trustEvidenceServiceHandlers(verdictEvidence, (method, err) => service.logger.error({ err, method }, 'TrustEvidenceService 처리 실패')) },
  ],
});
service.logger.info({ port: grpc.port }, '업무 gRPC 포트를 열었다');

process.once('SIGTERM', () => {
  rulesLoop.stop();
  asn.stop();
  deviceKeys.stop();
  // 받는 호출을 먼저 닫고, 처리 중인 일과 응답 뒤로 미룬 쓰기가 끝나면 연결을 닫는다
  void grpc
    .close()
    .then(() => Promise.all(pending))
    .then(() => service.close())
    .catch((err: unknown) => service.logger.error({ err }, 'trust-svc 종료 실패'))
    .finally(async () => {
      breaker.shutdown();
      // 남은 기록은 짧게 보내 보고 넘기지 못한 것은 센다. 텔레메트리라 종료를 붙들지 않는다
      await sink?.close(TELEMETRY_CLOSE_MS);
      await telemetrySender?.disconnect(TELEMETRY_CLOSE_MS);
      return redis.close();
    });
});
