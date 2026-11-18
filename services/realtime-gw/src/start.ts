// realtime-gw 조립(docs/features/seat-hold.md §7 'realtime-gw의 첫 구현', ADR-0296, BUILD_ORDER HOT-090). main.ts와 시험이 같은 함수를 부른다.
// 서비스 템플릿(createService: 앱 포트·관리 포트·로그·지표·준비 확인)에 ws 업그레이드를 붙인다. 업무 규칙과 저장소가 없어 도메인 층을 두지 않는다.
// 좌석 Redis에 시작 마감 안에 붙지 못하면 시작하지 않는다(docs/api/guidelines.md §8 이 행). 박자(100ms)는 실제 타이머 하나다.
import 'reflect-metadata';
import type { Writable } from 'node:stream';
import { type Clock, Counter, createService, Gauge, Histogram, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { loadRealtimeGwConfig } from './config.js';
import { BATCH_INTERVAL_MS, createStreamHub, LAYOUT_REFRESH_MS, LayoutSectionsFile, RedisChannelSubscriber, StreamGateway } from './modules/stream/index.js';

const SERVICE = 'realtime-gw';
/** 내리기 전체 마감(ms, [가정], ADR-0297 결정 5). 넘으면 close()가 거절되고 main.ts가 종료 코드 1로 끝낸다 */
export const SHUTDOWN_DEADLINE_MS = 10_000;

/** 보낸 maxWaitMs의 히스토그램 경계(ms). 경보는 p99 150ms [가정]이다(seat-hold §7 운영 확인 표) */
const BATCH_WAIT_BUCKETS_MS = [5, 10, 25, 50, 75, 100, 150, 200, 300, 500, 1_000, 5_000, 65_535];

export interface StartOptions {
  env: Record<string, string | undefined>;
  /** 로그 목적지. 기본 표준 출력 */
  logDestination?: Writable;
  /** 기본 시스템 시계 */
  clock?: Clock;
}

export interface StartedService {
  ports: { app: number; management: number };
  close(): Promise<void>;
}

export async function start(o: StartOptions): Promise<StartedService> {
  const { env } = o;
  const config = loadRealtimeGwConfig(env);
  const clock = o.clock ?? systemClock;
  // 지표·로거는 서비스를 만든 뒤에 생긴다. 그 전에 난 일(시작 때 Redis 붙음)은 값만 들고 있다가 옮긴다
  let redisUp = false;
  let redisUpGauge: Gauge | undefined;
  let mismatch = 0;
  let mismatchGauge: Gauge | undefined;
  let warn: (obj: object, msg: string) => void = () => {};
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let subscriber: RedisChannelSubscriber | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const layout = new LayoutSectionsFile({ dir: config.seatMapDir, clock, logger: { warn: (obj, msg) => warn(obj, msg) } });
    subscriber = await RedisChannelSubscriber.connect({
      ...(config.seatRedisUrl ? { url: config.seatRedisUrl } : { clusterUrls: config.seatRedisClusterUrls }),
      onUp: (up) => {
        redisUp = up;
        redisUpGauge?.set(up ? 1 : 0);
      },
      onMismatch: (n) => {
        mismatch = n;
        mismatchGauge?.set(n);
      },
      // 채널마다 물러서기 단계가 바뀔 때만 온다(ADR-0297 결정 1)
      onError: (e) => warn({ channel: e.channel, err: e.error }, '좌석 채널 구독·해제가 실패해 물러선 뒤 다시 보낸다'),
    });

    // 지표 받는 곳(서비스를 만든 뒤 채운다)
    const sinks = new Map<string, (labels: Record<string, string>, value: number) => void>();
    const hub = createStreamHub({
      clock,
      subscriber,
      sectionCount: (eventId) => layout.count(eventId),
      onMetric: (name, labels, value) => sinks.get(name)?.(labels, value),
    });

    let connections: Gauge | undefined;
    let rejects: Counter<'status'> | undefined;
    let closes: Counter<'code'> | undefined;
    let canonical: { info(obj: object, msg: string): void } | undefined;
    let accountRef: (accountId: string) => string = () => '';
    const gateway = new StreamGateway({
      hub,
      clock,
      admission: { keys: config.admissionKeys, issuer: config.admissionIssuer },
      webOrigin: config.webOrigin,
      maxConnections: config.maxConnections,
      layout,
      onRejected: (e) => {
        rejects?.inc({ status: String(e.status) });
        canonical?.info({ event: 'ws_rejected', status: e.status, reason: e.reason }, '좌석 델타 핸드셰이크를 거절했다');
      },
      onOpened: () => connections?.inc(),
      onClosed: (e) => {
        connections?.dec();
        closes?.inc({ code: String(e.code) });
        canonical?.info({ event: 'ws_closed', eventId: e.eventId, code: e.code, connectedMs: e.connectedMs, accountRef: accountRef(e.accountId) }, '좌석 델타 연결이 닫혔다');
      },
    });

    service = await createService({
      name: SERVICE,
      env,
      clock,
      module: AppModule.register({ gateway }),
      // 로그 시각은 플랫폼 기본(KST 오프셋 ISO 8601)이다(docs/observability.md §7 정규 로그 줄의 ts, ASVS v5.0.0-16.2.2)
      ...(o.logDestination ? { logDestination: o.logDestination } : {}),
    });
    const started = service;
    const logger = started.logger;
    warn = (obj, msg) => logger.warn(obj, msg);
    // 정규 로그 줄은 서비스 로그 수준과 관계없이 info부터 낸다
    canonical = logger.child({}, { level: 'info' });
    accountRef = (accountId) => started.pseudonymizer.ref(accountId);

    const registers = [started.metrics.registry];
    connections = new Gauge({ name: 'realtime_gw_connections', help: '맺은 좌석 델타 WebSocket 연결 수', registers });
    connections.set(0);
    rejects = new Counter({ name: 'realtime_gw_handshake_rejects_total', help: '거절한 핸드셰이크 수(상태 코드별)', labelNames: ['status'], registers });
    closes = new Counter({ name: 'realtime_gw_closes_total', help: '닫힌 연결 수(닫힘 코드별. 서버가 닫았으면 보낸 코드)', labelNames: ['code'], registers });
    const batches = new Counter({ name: 'realtime_gw_batches_total', help: '보낸 SeatDeltaBatch 수', registers });
    const batchBytes = new Counter({ name: 'realtime_gw_batch_bytes_total', help: '보낸 SeatDeltaBatch 바이트 합', registers });
    const batchWait = new Histogram({ name: 'realtime_gw_batch_wait_ms', help: '보낸 묶음의 maxWaitMs(ms)', buckets: BATCH_WAIT_BUCKETS_MS, registers });
    const messages = new Counter({ name: 'realtime_gw_pubsub_messages_total', help: '받은 좌석 채널 메시지 수(ok·bad·unrouted)', labelNames: ['result'], registers });
    for (const result of ['ok', 'bad', 'unrouted']) messages.inc({ result }, 0);
    redisUpGauge = new Gauge({ name: 'realtime_gw_redis_up', help: '좌석 Redis 구독 연결이 붙어 있으면 1', registers });
    redisUpGauge.set(redisUp ? 1 : 0);
    mismatchGauge = new Gauge({ name: 'realtime_gw_subscribe_mismatch', help: '원하는 구독 상태와 실제가 어긋난 좌석 채널 수(ADR-0297 결정 1)', registers });
    mismatchGauge.set(mismatch);
    sinks.set('realtime_gw_batches_total', (_l, v) => batches.inc(v));
    sinks.set('realtime_gw_batch_bytes_total', (_l, v) => batchBytes.inc(v));
    sinks.set('realtime_gw_batch_wait_ms', (_l, v) => batchWait.observe(v));
    sinks.set('realtime_gw_pubsub_messages_total', (l, v) => {
      const result = l.result;
      if (result === 'ok' || result === 'bad' || result === 'unrouted') messages.inc({ result }, v);
    });

    const listened = await started.listen();
    tickTimer = setInterval(() => hub.tick(), BATCH_INTERVAL_MS);
    refreshTimer = setInterval(() => void layout.refresh(), LAYOUT_REFRESH_MS);
    refreshTimer.unref();
    logger.info({ event: 'realtime_gw_started', port: listened.port, managementPort: listened.managementPort }, 'realtime-gw를 띄웠다');

    const startedSubscriber = subscriber;
    let closing: Promise<void> | undefined;
    const shutdown = async (): Promise<void> => {
      started.readiness.register('shutting-down');
      if (refreshTimer) clearInterval(refreshTimer);
      try {
        // 새 핸드셰이크를 503으로 거절하고 모든 연결을 1012로 닫은 뒤(구독 해제 응답은 1초까지) 서버를 닫는다
        await gateway.shutdown();
        if (tickTimer) clearInterval(tickTimer);
        await started.close();
      } finally {
        if (tickTimer) clearInterval(tickTimer);
        await startedSubscriber.close();
      }
    };
    // 전체는 10초 안에 끝낸다. 넘으면 로그 한 줄을 남기고 거절한다(main.ts가 종료 코드 1로 끝낸다, ADR-0297 결정 5)
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<'late'>((r) => {
          timer = setTimeout(() => r('late'), SHUTDOWN_DEADLINE_MS);
          timer.unref?.();
        });
        const result = await Promise.race([shutdown().then(() => 'done' as const), late]);
        clearTimeout(timer);
        if (result === 'late') {
          logger.error({ event: 'realtime_gw_shutdown_late', deadlineMs: SHUTDOWN_DEADLINE_MS }, '내리기 마감을 넘겼다');
          throw new Error(`realtime-gw 내리기가 ${SHUTDOWN_DEADLINE_MS}ms 마감을 넘겼다`);
        }
      })());
    return { ports: { app: listened.port, management: listened.managementPort }, close };
  } catch (err) {
    if (tickTimer) clearInterval(tickTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    await service?.close().catch(() => {});
    await subscriber?.close().catch(() => {});
    throw err;
  }
}
