// admission-ctrl 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// 관리 포트(/metrics, /ready)는 서비스 뼈대가 연다. 리더 하나만 200ms 루프를 돈다(쿠버네티스 Lease, ADR-0056·0182).
import 'reflect-metadata';
import { createHotRedis, createService, inClusterLeaseApi, LeaseElector, type LeaseApi, memoryLeaseApi, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { TestSeedSealer } from '@peaket/shuffle';
import { CommittedSeedSource, LocalResultFiles, minReplicasOf, RedisShuffleRecords, TestRandomness } from './modules/batch/index.js';
import { AdmissionLeader, LeaderMetrics, PrometheusControlInputs } from './modules/leader/index.js';

const SERVICE = 'admission-ctrl';

// 대기열 Redis: 로컬·CI는 단일 노드 주소, 운영은 클러스터 시작 노드 주소들(쉼표)
const clusterUrls = (process.env.PEAKET_QUEUE_REDIS_CLUSTER_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const url = process.env.PEAKET_QUEUE_REDIS_URL;
if (!url && clusterUrls.length === 0) throw new Error('PEAKET_QUEUE_REDIS_URL이나 PEAKET_QUEUE_REDIS_CLUSTER_URLS가 없다(비밀 관리에서 넣는다)');
// 게시 전 복제 확인의 최소 복제본 수(운영 1, 로컬·CI 0 [가정], ADR-0182 결정 7)
const minReplicas = minReplicasOf(process.env.PEAKET_QUEUE_REDIS_MIN_REPLICAS, clusterUrls.length > 0);
// 시드·비콘: 운영의 KMS 봉인과 drand 비콘(BLS 검증)은 BUILD_ORDER HOT-041이다. 그전에는 local·ci·demo의 시험 값만 받는다.
// 시드는 queue-svc 공시 일꾼이 쓴 봉인을 풀어 받는다(같은 PEAKET_TEST_BATCH_RANDOMNESS를 넘긴다, ADR-0231 결정 6)
const randomness = TestRandomness.fromEnv(process.env);
const sealer = TestSeedSealer.fromEnv(process.env);
const resultDir = process.env.PEAKET_BATCH_RESULT_DIR;
if (!resultDir) throw new Error('PEAKET_BATCH_RESULT_DIR가 없다(묶음 결과 파일을 쓸 곳. 운영의 회차별 S3 어댑터는 BUILD_ORDER HOT-012, ADR-0232)');

// 자동 제어 입력(클러스터 안 Prometheus, ADR-0226 결정 13). 운영에서 빠지면 조용히 자동 제어가 꺼지지 않게 시작을 실패시키고, 로컬·CI는 꺼진 채 돈다. 주소가 http(s)가 아니거나 사용자 정보가 있으면 여기서 던져 시작이 실패한다
const promUrl = process.env.PEAKET_PROMETHEUS_URL;
if (!promUrl && clusterUrls.length > 0) throw new Error('PEAKET_PROMETHEUS_URL이 없다(자동 제어 입력을 읽을 클러스터 Prometheus 주소)');
const controlInputs = promUrl ? new PrometheusControlInputs({ baseUrl: promUrl }) : undefined;

const redisOptions = clusterUrls.length > 0 ? { clusterUrls } : { url };
const redis = await createHotRedis(redisOptions);
// WAIT는 그 연결을 막으므로 복제 확인(묶음 게시 전, RB-05 뒤 ADR-0186)은 따로 연결한다. 단일 노드에서 최소 복제본 수가 0이면 기다리지 않아 필요 없다
const waitRedis = minReplicas > 0 || clusterUrls.length > 0 ? await createHotRedis(redisOptions) : undefined;
const metrics = new LeaderMetrics();
// 파드 안이면 쿠버네티스 Lease, 밖(로컬)이면 이 프로세스 하나만 리더다
const baseApi: LeaseApi = process.env.KUBERNETES_SERVICE_HOST ? inClusterLeaseApi(SERVICE) : memoryLeaseApi();
const counted = <T>(p: Promise<T>): Promise<T> => p.catch((err: unknown) => (metrics.leaseFailure(), Promise.reject(err)));
const leaseApi: LeaseApi = { get: () => counted(baseApi.get()), create: (s) => counted(baseApi.create(s)), update: (s, v) => counted(baseApi.update(s, v)) };
// Lease 15초·갱신 시도 5초(docs/infra.md), 갱신 한도 10초 [가정](ADR-0182 결정 1)
const elector = new LeaseElector({ api: leaseApi, identity: process.env.HOSTNAME ?? `${SERVICE}-local`, clock: systemClock, leaseDurationMs: 15_000, renewDeadlineMs: 10_000, retryPeriodMs: 5_000 });

const service = await createService({
  name: SERVICE,
  module: AppModule.register({ redis, elector, metrics, ...(controlInputs ? { controlInputs } : {}), batch: { seeds: new CommittedSeedSource(new RedisShuffleRecords(redis), sealer), beacon: randomness, files: new LocalResultFiles(resultDir), minReplicas, ...(waitRedis ? { waitRedis } : {}) } }),
});
metrics.register(service.metrics.registry);
if (!controlInputs) service.logger.warn({}, '자동 제어 입력이 없어(PEAKET_PROMETHEUS_URL) AIMD를 끈 채 돈다(로컬·CI)');
await service.listen();
const leader = service.app.get(AdmissionLeader);
elector.start();
leader.start();

process.once('SIGTERM', () => {
  // 쓰기를 멈춘 뒤 Lease를 놓고(ADR-0056 결정 3), 서비스와 연결을 닫는다
  void leader
    .stop()
    .then(() => elector.stop())
    .then(() => service.close())
    .catch((err: unknown) => service.logger.error({ err }, 'admission-ctrl 종료 실패'))
    .finally(() => Promise.all([redis.close(), waitRedis?.close()]));
});
