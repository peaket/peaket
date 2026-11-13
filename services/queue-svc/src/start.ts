// queue-svc 조립(BUILD_ORDER PRF-215, ADR-0262 결정 4). 서비스 시작 파일 main.ts와 한 프로세스 합본(services/bundle)이 같은 함수를 부른다.
// 환경 값은 인자로만 받는다(process.env를 읽지 않는다. 합본은 서비스마다 다른 환경 값을 넘긴다). 조립과 종료 차례는 나누기 전의 main.ts 그대로다.
// 앱 포트(REST: 사전 검증 POST /v1/queues/{eventId}/pre-verifications, 진입 POST …/entries, 대기 상태 파일 GET …/segment-states/{segment}.json, 입장 확정 POST …/admission,
// 추가 검증 POST·GET …/verification)·관리 포트(/metrics, /ready)는 서비스 뼈대가 연다. 업무 gRPC 포트(VerificationAppealService, BOT-090)는 이 함수가 연다.
// 듣기 시작한 뒤 Kafka 소비자(구매 세션·탈퇴·회차 판매 상태, ADR-0214)를 켠다.
import 'reflect-metadata';
import type { Writable } from 'node:stream';
import { CircuitBreaker, Counter, createHotRedis, createService, errorSummary, Gauge, HotPathMetrics, loadPlatformConfig, ReloadingAsnTable, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { kafkaConsumersFromEnv } from './consumers/index.js';
import { type QueueConsumers, startQueueConsumers } from './consumers/start.js';
import { startGrpcServer } from './grpc-server.js';
import { Es256AdmissionTokens, priorityGrantHandlers, PromAdmissionSignals, PurchaseSessionHandler, PurchaseSessionSlots, SetPriorityGrant } from './modules/admission/index.js';
import { AccountWithdrawnHandler, GrpcTrustRisk, kmsSealClient, MemoryDegradedLimits, PromRiskSignals, seedSealerFromEnv, HmacArrivalCookies, HmacFirstVisitCookies, HmacQueueTokens, PromArrivalSignals, PromEligibilitySignals, PromFirstVisitSignals, PromLeaveSignals, PromLobbySignals, PurgeWithdrawnKeys, RedisEventSchedules, RedisWithdrawnDue, RedisWithdrawnKeys, ShuffleCommits, ShuffleCommitWorker, TRUST_BREAKER, unavailableRisk, WithdrawnDueWorker } from './modules/entry/index.js';
import { ApplySaleChange, type EdgeFlagSync, edgeSyncPausedFromEnv, EventSaleChangedHandler, RedisSaleStates } from './modules/sale/index.js';
import { type CaseRequestPublisher, GetVerificationAppeal, GrpcReverification, KafkaCaseRequests, LocalCaseRequests, PromVerificationSignals, queuePackage, ResolveVerificationAppeal, verificationAppealHandlers } from './modules/verification/index.js';

const SERVICE = 'queue-svc';
/** 업무 gRPC 포트 [가정](trust-svc·identity-svc와 같은 기본값, BUILD_ORDER BAS-080이 공용 설정으로 옮긴다) */
export const DEFAULT_GRPC_PORT = 50051;

export interface StartOptions {
  /** 이 서비스의 환경 값(시작 파일은 process.env, 합본은 공통 값과 이 서비스의 환경 파일을 합친 값) */
  env: Record<string, string | undefined>;
  /** 로그 목적지(기본 표준 출력, 시험에서 바꿔 끼운다) */
  logDestination?: Writable;
  /** 듣기 시작한 뒤의 치명적 실패(Kafka 소비자를 켜지 못함). 서비스는 이미 종료 차례를 시작했다. 시작 파일은 종료 코드 1을 둔다 */
  onFatal?: (err: unknown) => void;
}

export interface StartedService {
  /** 종료 차례대로 닫는다. 여러 번 불러도 한 번만 닫고 같은 약속을 돌려준다 */
  close(): Promise<void>;
}

export async function start(o: StartOptions): Promise<StartedService> {
  const { env } = o;
  const grpcPort = Number(env.PEAKET_GRPC_PORT ?? DEFAULT_GRPC_PORT);
  if (!(Number.isInteger(grpcPort) && grpcPort > 0 && grpcPort <= 65535)) throw new Error(`PEAKET_GRPC_PORT가 틀렸다: ${env.PEAKET_GRPC_PORT}`);
  // 대기열 Redis: 로컬·CI는 단일 노드 주소, 운영은 클러스터 시작 노드 주소들(쉼표)
  const clusterUrls = (env.PEAKET_QUEUE_REDIS_CLUSTER_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const url = env.PEAKET_QUEUE_REDIS_URL;
  if (!url && clusterUrls.length === 0) throw new Error('PEAKET_QUEUE_REDIS_URL이나 PEAKET_QUEUE_REDIS_CLUSTER_URLS가 없다(비밀 관리에서 넣는다)');

  const tokens = HmacQueueTokens.fromEnv(env);
  // 입장 토큰 서명 키(개인 JWK)와 발급자: 비밀 관리에서 시작 때 메모리로 읽는다(OPEN[10] 추천 적용, docs/security/secrets-and-keys.md)
  const signer = Es256AdmissionTokens.fromEnv(env);
  const signals = new PromAdmissionSignals();
  const redis = await createHotRedis(clusterUrls.length > 0 ? { clusterUrls } : { url });
  // RB-05 복제 확인(WAIT)은 그 연결을 막으므로 클러스터에서는 따로 연결한다(ADR-0186). 단일 노드(로컬·CI)는 복제본이 없어 기다리지 않는다
  const waitRedis = clusterUrls.length > 0 ? await createHotRedis({ clusterUrls }) : undefined;
  // 위험 판정(BOT-050): trust-svc ScoreRisk. 주소가 없으면 local·ci·demo만 늘 축소 운영(사람 확인 보류)으로 시작하고, 그 밖은 시작하지 않는다(운영에서 조용히 판정을 잃지 않게).
  // 차단기는 서비스 지표 저장소가 생긴 뒤 진짜를 단다(그 전에는 요청을 받지 않아 부르지 않는다). 판정을 못 받을 때의 파드 메모리 한도(§11.2)에는 ASN 분류표 사본을 쓴다
  const SERVICE_ENV = env.PEAKET_ENV || 'prod';
  const trustGrpc = env.PEAKET_TRUST_GRPC_URL;
  if (!trustGrpc && !['local', 'ci', 'demo'].includes(SERVICE_ENV)) throw new Error('PEAKET_TRUST_GRPC_URL이 없다(trust-svc host:port)');
  const trustBreakerHolder: { b?: CircuitBreaker } = {};
  const riskSignals = new PromRiskSignals();
  const trustRisk = trustGrpc
    ? new GrpcTrustRisk(trustGrpc, loadPlatformConfig(env).grpcLbProfile, { run: (a) => (trustBreakerHolder.b ? trustBreakerHolder.b.run(a) : a()) }, riskSignals)
    : undefined;
  const asnFile = env.PEAKET_ASN_TABLE_FILE;
  const asnLog: { warn?: (reason: string) => void } = {};
  const asnTable = new ReloadingAsnTable({ load: asnFile ? () => import('node:fs/promises').then((f) => f.readFile(asnFile, 'utf8')) : async () => undefined, clock: systemClock, onError: (reason) => asnLog.warn?.(reason) });
  const degradedLimits = new MemoryDegradedLimits(systemClock, asnTable);
  // 추가 검증 제출의 본인확인 재통과(BOT-090, identity.proto CheckReverification). 주소가 없으면 local·ci·demo만 늘 503으로 시작하고, 그 밖은 시작하지 않는다(trust-svc 주소와 같은 규칙)
  const identityGrpc = env.PEAKET_IDENTITY_GRPC_URL;
  if (!identityGrpc && !['local', 'ci', 'demo'].includes(SERVICE_ENV)) throw new Error('PEAKET_IDENTITY_GRPC_URL이 없다(identity-svc host:port)');
  const identityBreakerHolder: { b?: CircuitBreaker } = {};
  const reverification = identityGrpc ? new GrpcReverification(identityGrpc, loadPlatformConfig(env).grpcLbProfile, { run: (a) => (identityBreakerHolder.b ? identityBreakerHolder.b.run(a) : a()) }) : undefined;
  const verificationSignals = new PromVerificationSignals();
  // 대기열 파일의 교차 출처 허용: 소비자 웹 하나(환경마다 주소가 다르다, 없으면 운영 주소)
  const webOrigin = env.PEAKET_WEB_ORIGIN;
  // Kafka 소비자 설정은 듣기 전에 읽는다(브로커 주소가 없으면 local·ci만 경고로 끄고 그 밖은 여기서 시작에 실패한다)
  const kafka = kafkaConsumersFromEnv(env);
  // 이의 건 요청(support.cases-requested, 거래·제어 클러스터 = 소비자와 같은 PEAKET_KAFKA_BROKERS, ADR-0259 결정 6). queue-svc의 첫 Kafka 생산자다.
  // 브로커가 없으면(local·ci만 허락) 이의만 503이다. Kafka를 띄우지 못하는 PC의 화면 연결은 '발행 성공' 대역(PEAKET_CASE_REQUESTS_STUB=accept, local·ci 전용)을 쓴다
  const caseStub = env.PEAKET_CASE_REQUESTS_STUB;
  if (caseStub !== undefined && (caseStub !== 'accept' || !['local', 'ci'].includes(SERVICE_ENV))) throw new Error('PEAKET_CASE_REQUESTS_STUB는 local·ci에서 accept만 쓴다');
  const caseWarnings: string[] = [];
  /** 발행 대역의 로그는 서비스 로거가 생긴 뒤 단다 */
  const caseLog: { warn?: (fields: Record<string, unknown>, message: string) => void } = {};
  let kafkaCases: KafkaCaseRequests | undefined;
  let cases: CaseRequestPublisher | undefined;
  if (kafka.enabled) {
    try {
      // 네이티브 모듈은 켤 때만 싣는다(시험과 Kafka 없는 환경은 모듈 없이 돈다). 싣지 못해도 시작은 막지 않는다(이의만 503)
      const { createKafkaProducer, withTraceHeaders } = await import('@peaket/platform/stream-worker');
      const pod = (env.PEAKET_POD ?? env.HOSTNAME ?? 'local').slice(0, 64);
      const { brokers, auth, env: kafkaEnv } = kafka;
      kafkaCases = new KafkaCaseRequests(() => createKafkaProducer({ kind: 'default', brokers, clientId: `queue-svc-${kafkaEnv}-${pod}`, auth }), () => withTraceHeaders());
      cases = kafkaCases;
    } catch {
      caseWarnings.push('Kafka 클라이언트를 싣지 못해 이의 접수가 503이다');
    }
  } else if (caseStub === 'accept') {
    cases = new LocalCaseRequests((c) => caseLog.warn?.({ dep: 'kafka', appealId: c.sourceId, eventKey: c.eventKey }, '건 요청 발행 대역(local·ci): 내지 않고 받은 것으로 친다'));
    caseWarnings.push('이의 건 요청이 발행 대역이다(PEAKET_CASE_REQUESTS_STUB=accept, local·ci 전용)');
  } else {
    caseWarnings.push('PEAKET_KAFKA_BROKERS가 없어 이의 접수가 503이다(추가 검증 제출은 그대로다)');
  }
  // 도착 시각 쿠키 키(ADR-0223): 없으면 쿠키를 읽지 않는다(그 환경은 쿠키 없는 일반 진입뿐이다, 시작에는 실패하지 않는다)
  const arrivals = HmacArrivalCookies.fromEnv(env);
  const arrivalSignals = new PromArrivalSignals();
  // 최초 방문 쿠키 키(ADR-0249): 없거나 틀리면 경고하고 쿠키를 읽지 않는다(시작은 막지 않는다. 값 있음은 배포 검사가 막는다)
  const firstVisitWarnings: string[] = [];
  const firstVisit = HmacFirstVisitCookies.fromEnv(env, (m) => firstVisitWarnings.push(m));
  const firstVisitSignals = new PromFirstVisitSignals();
  // 시드 봉인(ADR-0239 결정 5): 운영은 KMS Encrypt이고 키가 없으면 시작하지 않는다. local·ci·demo는 시험 봉인(admission-ctrl과 같은 PEAKET_TEST_BATCH_RANDOMNESS)이고, 값이 없으면 봉인 없이 시작해 로비 참가와 공시는 503이다
  const sealer = seedSealerFromEnv(env, (endpoint, region) => kmsSealClient({ region, ...(endpoint ? { endpoint } : {}) }));
  const lobbySignals = new PromLobbySignals();
  const leaveSignals = new PromLeaveSignals();
  const eligibilitySignals = new PromEligibilitySignals();
  // 핫패스 구간 진단(BAT-027): 레지스트리는 createService 뒤에 생기므로 지표 객체만 먼저 만들고, 듣기 전에 붙인다
  const hotPath = new HotPathMetrics(SERVICE);
  const service = await createService({
    name: SERVICE,
    env,
    hotPath,
    ...(o.logDestination ? { logDestination: o.logDestination } : {}),
    module: AppModule.register({
      redis,
      ...(waitRedis ? { waitRedis } : {}),
      tokens,
      risk: trustRisk ?? unavailableRisk,
      degradedLimits,
      hotPath,
      ...(sealer ? { sealer } : {}),
      lobbySignals,
      leaveSignals,
      eligibilitySignals,
      state: { ...(webOrigin ? { webOrigin } : {}), ...(env.PEAKET_BATCH_RESULT_DIR ? { resultDir: env.PEAKET_BATCH_RESULT_DIR } : {}) },
      admission: { signer, signals },
      ...(arrivals ? { arrivals } : {}),
      arrivalSignals,
      ...(firstVisit ? { firstVisit } : {}),
      firstVisitSignals,
      // trust-svc 클라이언트 하나가 진입 판정과 추가 검증(VERIFICATION)을 함께 맡는다(같은 차단기: 서킷이 열리면 제출도 503, B-T6 ④)
      verification: { ...(reverification ? { reverification } : {}), ...(trustRisk ? { risk: trustRisk } : {}), ...(cases ? { cases } : {}), signals: verificationSignals },
    }),
  });
  arrivalSignals.register(service.metrics.registry);
  hotPath.register(service.metrics.registry);
  firstVisitSignals.register(service.metrics.registry);
  riskSignals.register(service.metrics.registry);
  trustBreakerHolder.b = new CircuitBreaker({ service: SERVICE, dependency: 'trust-svc', registry: service.metrics.registry, logger: service.logger, ...TRUST_BREAKER });
  identityBreakerHolder.b = new CircuitBreaker({ service: SERVICE, dependency: 'identity-svc', registry: service.metrics.registry, logger: service.logger });
  verificationSignals.register(service.metrics.registry);
  caseLog.warn = (fields, message) => service.logger.warn(fields, message);
  if (!reverification) service.logger.warn({ dep: 'identity-svc' }, 'PEAKET_IDENTITY_GRPC_URL이 없어 추가 검증 제출이 늘 503이다(local·ci·demo)');
  for (const w of caseWarnings) service.logger.warn({ dep: 'kafka' }, w);
  kafkaCases?.warm();
  if (!trustRisk) service.logger.warn({ dep: 'trust-svc' }, 'PEAKET_TRUST_GRPC_URL이 없어 위험 판정이 늘 축소 운영이다(local·ci·demo)');
  if (!asnFile) service.logger.warn({ dep: 'asn-table' }, 'PEAKET_ASN_TABLE_FILE이 없어 축소 운영의 IP 한도를 걸지 않는다');
  asnLog.warn = (reason) => service.logger.warn({ dep: 'asn-table', reason }, 'ASN 분류표를 읽지 못해 마지막 판을 쓴다');
  // 경고 함수를 단 뒤에 읽기 시작한다(첫 읽기 실패 경고를 잃지 않게). 파드가 요청을 받기 전이라 그 사이 축소 운영은 IP 한도 없이 간다
  asnTable.start();
  if (!arrivals) service.logger.warn({ dep: 'edge-arrival-key' }, '도착 시각 쿠키 키(PEAKET_ARRIVAL_COOKIE_KEY)가 없어 진입 Degraded의 쿠키를 읽지 않는다');
  for (const w of firstVisitWarnings) service.logger.warn({ dep: 'edge-first-visit-key' }, w);
  signals.register(service.metrics.registry);
  lobbySignals.register(service.metrics.registry);
  leaveSignals.register(service.metrics.registry);
  eligibilitySignals.register(service.metrics.registry);
  await service.listen();

  // 업무 gRPC 포트(VerificationAppealService): 부르는 쪽을 ops-svc로 줄이는 것은 메시 L7 허용 목록이다(HOT-400).
  // 열지 못하면(포트 겹침 등) 이미 연 서비스를 닫고 던진다(시작 실패, 합본도 같은 길로 끝난다)
  let grpc: Awaited<ReturnType<typeof startGrpcServer>>;
  try {
    grpc = await startGrpcServer({
      host: env.PEAKET_GRPC_HOST ?? '0.0.0.0',
      port: grpcPort,
      services: [
        {
          definition: queuePackage().VerificationAppealService.service,
          handlers: verificationAppealHandlers({ get: service.app.get(GetVerificationAppeal), resolve: service.app.get(ResolveVerificationAppeal) }, (method, err) =>
            service.logger.error({ err: errorSummary(err), method }, 'VerificationAppealService 처리 실패'),
          ),
        },
        {
          definition: queuePackage().PriorityGrantService.service,
          handlers: priorityGrantHandlers({ run: (i) => service.app.get(SetPriorityGrant).run(i) }, (method, err) =>
            service.logger.error({ err: errorSummary(err), method }, 'PriorityGrantService 처리 실패'),
          ),
        },
      ],
    });
  } catch (err) {
    asnTable.stop();
    await service.close().catch(() => undefined);
    trustBreakerHolder.b?.shutdown();
    identityBreakerHolder.b?.shutdown();
    trustRisk?.close();
    reverification?.close();
    await Promise.allSettled([redis.close(), waitRedis?.close(), kafkaCases?.close()]);
    throw err;
  }
  service.logger.info({ port: grpc.port }, '업무 gRPC 포트를 열었다');

  // 셔플 커밋 공시 일꾼(ADR-0231 결정 6): 봉인이 있으면 파드마다 돈다. 먼저 쓴 값 하나로 남는다
  const commitWorker = sealer ? new ShuffleCommitWorker(service.app.get(ShuffleCommits), new RedisEventSchedules(redis, systemClock), (now) => new RedisWithdrawnKeys(redis).activeEvents(now), systemClock, service.logger) : undefined;
  commitWorker?.start();
  if (!sealer) service.logger.warn({ dep: 'seed-sealer' }, '시드 봉인이 없어 로비 참가와 커밋 공시를 하지 않는다(로컬·CI)');

  // Kafka 소비자(ADR-0214 결정 1): 듣기 시작한 뒤 켠다. 연결·구독이 실패하면 오류 한 줄 뒤 SIGTERM과 같은 차례로 끝내고 종료 코드 1로 나간다(쿠버네티스가 다시 띄운다)
  let consumers: QueueConsumers | undefined;
  let dueWorker: WithdrawnDueWorker | undefined;
  let edgeSync: EdgeFlagSync | undefined;
  if (!kafka.enabled) service.logger.warn({ dep: 'kafka' }, kafka.warning);
  else {
    const pod = (env.PEAKET_POD ?? env.HOSTNAME ?? 'local').slice(0, 64);
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
    // 엣지 매진 표시(ADR-0219): 실제 KeyValueStore 어댑터는 HOT-012(OPEN[24]·OPEN[25] 대기)라 아직 없다. 그동안 엣지 410 없이 원본 410만 낸다.
    // 지표는 지금 만들어 둔다(엣지 포트가 없으면 늘 0, docs/observability.md §5). 멈춤 스위치 PEAKET_EDGE_SYNC(off·false·0이면 멈춤)는 엣지를 손으로 바꾸는 런북이 쓴다(바꾸면 다시 시작)
    const edgeSyncOff = edgeSyncPausedFromEnv(env);
    service.logger.warn({ dep: 'edge-kvs', paused: edgeSyncOff }, '엣지 매진 표시 저장소가 없어 엣지 410을 켜지 않는다(원본 410만, BUILD_ORDER HOT-012)');
    const edgeFailed = new Counter({ name: 'queue_edge_flag_failures_total', help: '엣지 매진 표시(키 값 저장소 sale:{회차}) 쓰기 실패', registers });
    const edgeUnsynced = new Gauge({ name: 'queue_edge_flag_unsynced_events', help: '마지막 쓰기가 실패해 notice와 맞추지 못한 회차 수(want: 바라는 값 on·off)', labelNames: ['want'] as const, registers });
    const edgeAhead = new Gauge({ name: 'queue_edge_flag_ahead_events', help: 'notice보다 큰 판의 엣지 매진 표시가 있어 바꾸지 못한 회차 수(꾸민 값이거나 notice를 잃었다)', registers });
    const edgeSignals = { failed: () => edgeFailed.inc(), unsynced: (want: 'on' | 'off', n: number) => edgeUnsynced.set({ want }, n), ahead: (n: number) => edgeAhead.set(n) };
    const applySale = new ApplySaleChange(new RedisSaleStates(redis), new RedisEventSchedules(redis, systemClock), systemClock, {
      logger: service.logger,
      signals: edgeSignals,
      paused: () => edgeSyncOff,
      registry: service.metrics.registry,
    });
    // 엣지 포트가 생기면(HOT-012) 파드 안 다시 맞추기(5초 [가정])를 돌린다
    edgeSync = applySale.edgeSync;
    edgeSync?.start();
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
        saleChanged: new EventSaleChangedHandler(applySale),
      },
      registry: service.metrics.registry,
      logger: service.logger,
    });
    consumers.started.catch((err: unknown) => {
      service.logger.error({ dep: 'kafka', err: errorSummary(err) }, 'Kafka 소비자를 켜지 못해 queue-svc를 끝낸다');
      void close();
      o.onFatal?.(err);
    });
  }

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    // Kafka 소비자를 먼저 멈추고(받기를 멈추고 처리 중인 키를 마친 뒤 커밋), 서비스를 닫은 뒤 연결을 닫는다. 어느 단계가 실패해도 연결은 닫는다
    closing ??= (() => {
      commitWorker?.stop();
      asnTable.stop();
      // 받는 gRPC 호출을 먼저 닫고(처리 중인 결과 반영은 마친다), Kafka 소비자를 멈춘다
      return grpc
        .close()
        .then(() => consumers?.stop())
        .then(() => dueWorker?.stop())
        .then(() => edgeSync?.stop())
        .catch((err: unknown) => service.logger.error({ err: errorSummary(err) }, 'Kafka 소비자 멈추기 실패(나머지는 그대로 끝낸다)'))
        .then(() => service.close())
        .catch((err: unknown) => service.logger.error({ err }, 'queue-svc 종료 실패'))
        .finally(() => {
          trustBreakerHolder.b?.shutdown();
          identityBreakerHolder.b?.shutdown();
          trustRisk?.close();
          reverification?.close();
          return Promise.all([redis.close(), waitRedis?.close(), kafkaCases?.close()]);
        })
        .then(() => undefined);
    })();
    return closing;
  }
  return { close };
}
