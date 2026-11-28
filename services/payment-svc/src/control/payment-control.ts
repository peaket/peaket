// payment-svc 명령 6 결제 갈래 조립(F-02-2 OPS-310, ADR-0366 결정 1·2·3·5·8·9). 시작 파일(start.ts)은 이 함수 하나를 부르고 손잡이 넷만 잇는다:
// - 만들 때(듣기 전): 준비 표시에 'control-state'를 걸고 pg_switch를 한 번 읽어야 끝낸다(읽지 못하면 1초 [가정]마다 다시, 그동안 준비 상태가 아니다, ADR-0366 결정 3).
//   그 뒤의 다시 맞춤은 결제사 선택 캐시 수명 1초 [가정]가 맡는다(따로 돌지 않는다). Kafka가 없어도 같다(플랫폼 제어 동기화와 무관하게 돈다)
//   같은 시작 작업이 새 결제 정지 캐시도 핫패스 풀로 한 번 읽어야 끝나고, 그 뒤 1초 [가정]마다 다시 읽는다(payment.md §2 '정지 행 읽기': 파드마다 1초마다 읽어 메모리에 둔다).
//   그래서 준비된 파드의 첫 결제 시도가 한 번도 읽지 못한 정지 캐시·연결 없는 핫패스 풀(연결 대기 100ms)에 걸려 실패하지 않는다(C-T53 ④, 플랫폼 제어 동기화가
//   멈춘 브로커를 30초 기다리는 동안 쉬는 연결이 10초에 닫히는 것도 막는다)
// - extend: 업무 gRPC PaymentService 처리기 묶음에 ResolvePgSwitch를 더한다
// - listen: PEAKET_PAYMENT_CONTROL_GRPC_PORT가 있으면 제어 전용 포트를 연다(운영 50061, local·ci·시험은 0이면 빈 포트)
// - stop: 시작 읽기를 멈추고 제어 포트를 닫는다
// 환경 값은 인자로만 받는다(process.env를 읽지 않는다).
import { type Clock, CONTROL_SYNC_DEFAULTS, type Database, type GrpcLbProfile, type PlatformMetrics, runbookGateConfigFromProcess } from '@peaket/platform';
import { ENTRY_PAUSE_CACHE_TTL_MS } from '../modules/payment/server.js';
import type * as grpc from '@grpc/grpc-js';
import {
  ApplyEntryPauseRelease,
  ApplyPgSwitch,
  DrizzleEntryPause,
  DrizzlePgSelectionBatch,
  DrizzlePgSwitchControl,
  type EntryPauseJudgeLog,
  type EntryPauseJudgeSignals,
  type PgName,
  type PgPlatformDefaults,
  ReleaseEntryPause,
  ResolvePgSwitch,
  withResolvePgSwitch,
} from '../modules/payment/server.js';
import { startPaymentControlServer } from './control-server.js';

/** 준비 표시에 거는 작업 이름(플랫폼 시작 작업의 제어 상태와 같은 이름, purchase-svc와 같다) */
export const PG_SWITCH_READINESS_TASK = 'control-state';
/** SIMULATOR 해제를 받는 환경(ADR-0366 결정 8) */
const SIMULATOR_RELEASE_ENVS: readonly string[] = ['local', 'ci'];
/** 포트 0(빈 포트)을 받는 환경 */
const ZERO_PORT_ENVS: readonly string[] = ['local', 'ci', 'test'];

interface Logger {
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

/**
 * 제어 포트 설정을 읽는다. 없으면 undefined(제어 포트를 열지 않는다). 0은 local·ci·test만(빈 포트).
 * @throws Error 정수가 아니거나 범위 밖
 */
export function paymentControlPortOf(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const raw = env.PEAKET_PAYMENT_CONTROL_GRPC_PORT?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  const zeroOk = env.PEAKET_ENV !== undefined && ZERO_PORT_ENVS.includes(env.PEAKET_ENV);
  if (!/^\d{1,5}$/.test(raw) || port > 65_535 || (port === 0 && !zeroOk)) throw new Error('PEAKET_PAYMENT_CONTROL_GRPC_PORT는 1~65535 정수여야 한다(local·ci는 0도 받는다)');
  return port;
}

export interface PaymentControlOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readiness: { register(task: string): void; complete(task: string): void };
  readonly logger: Logger;
  readonly metrics?: PlatformMetrics;
  readonly profile?: GrpcLbProfile;
  /** 일반 풀(쓰기 인스턴스). pg_switch 쓰기·읽기, 정지 해제, ResolvePgSwitch의 회차 지정 읽기 */
  readonly database: Database;
  /** 이 파드의 결제사 선택 캐시(CachedPgSelectionReader) */
  readonly selection: { invalidate(eventId?: string): void };
  /** 이 파드의 정지 캐시(CachedEntryPauseReader). 시작 작업이 한 번 읽고 그 뒤 1초마다 다시 읽는다 */
  readonly pauses: { invalidate(): void; read(): Promise<unknown> };
  /** 채널별 호출 보호기(PgCallGuards). 해제 뒤 이 파드의 그 결제사 서킷을 닫는다 */
  readonly guards: { of(pg: PgName): { closeCircuit(): void } | undefined };
  readonly defaults: PgPlatformDefaults;
  readonly approvalTps: ReadonlyMap<PgName, number>;
  readonly entryLog: Pick<EntryPauseJudgeLog, 'transition' | 'released'>;
  readonly entrySignals: Pick<EntryPauseJudgeSignals, 'writeConflict'>;
  readonly clock: Clock;
  readonly podName: string;
  /** 시작 읽기 다시 하기 간격(기본 CONTROL_SYNC_DEFAULTS.retryMs). 시험만 바꾼다 */
  readonly retryMs?: number;
}

export interface PaymentControlPlane {
  /** 업무 gRPC PaymentService 처리기 묶음에 ResolvePgSwitch를 더한다 */
  extend(handlers: grpc.UntypedServiceImplementation, onError: (method: string, err: unknown) => void): grpc.UntypedServiceImplementation;
  /** 제어 포트를 연다(설정이 없으면 하지 않는다). 연 포트 */
  listen(): Promise<number | undefined>;
  /** 시작 읽기를 멈추고 제어 포트를 닫는다. 여러 번 불러도 된다 */
  stop(): Promise<void>;
  readonly applyPgSwitch: ApplyPgSwitch;
  readonly applyEntryPauseRelease: ApplyEntryPauseRelease;
  readonly resolvePgSwitch: ResolvePgSwitch;
}

export function paymentControlPlane(o: PaymentControlOptions): PaymentControlPlane {
  const port = paymentControlPortOf(o.env);
  const store = new DrizzlePgSwitchControl({ database: o.database });
  const applyPgSwitch = new ApplyPgSwitch({ store, selection: o.selection, clock: o.clock });
  const release = new ReleaseEntryPause({ store: new DrizzleEntryPause({ database: o.database }), clock: o.clock, log: o.entryLog, signals: o.entrySignals });
  const applyEntryPauseRelease = new ApplyEntryPauseRelease({ release, pauses: o.pauses, closeCircuit: (pg) => o.guards.of(pg)?.closeCircuit() });
  const resolvePgSwitch = new ResolvePgSwitch({ selection: new DrizzlePgSelectionBatch({ database: o.database }), defaults: o.defaults, approvalTps: o.approvalTps });
  const allowSimulator = o.env.PEAKET_ENV !== undefined && SIMULATOR_RELEASE_ENVS.includes(o.env.PEAKET_ENV);

  // 새 파드는 pg_switch를 한 번 읽어야 준비 상태가 된다(ADR-0366 결정 3, ADR-0103). 읽은 값은 선택 캐시가 다시 읽으므로 들고 있지 않는다.
  // 정지 캐시도 함께 읽어야 끝나고(핫패스 풀), 끝난 뒤에는 1초마다 다시 읽는다(실패는 캐시가 센다, 마지막 값 규칙은 캐시 그대로)
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let refresh: NodeJS.Timeout | undefined;
  o.readiness.register(PG_SWITCH_READINESS_TASK);
  const firstRead = (): void => {
    if (stopped) return;
    Promise.all([store.readAll(), o.pauses.read()]).then(
      ([rows]) => {
        if (stopped) return;
        o.readiness.complete(PG_SWITCH_READINESS_TASK);
        o.logger.info({ kind: 'payment-control', rows: rows.length }, 'pg_switch와 새 결제 정지를 읽었다(제어 상태 시작 작업 끝)');
        refresh = setInterval(() => void o.pauses.read().catch(() => undefined), ENTRY_PAUSE_CACHE_TTL_MS);
        refresh.unref();
      },
      (err: unknown) => {
        o.logger.warn({ kind: 'payment-control', err: err instanceof Error ? err.name : 'unknown' }, 'pg_switch·새 결제 정지를 읽지 못했다(준비 상태가 되지 않는다, 다시 읽는다)');
        if (stopped) return;
        timer = setTimeout(firstRead, o.retryMs ?? CONTROL_SYNC_DEFAULTS.retryMs);
        timer.unref();
      },
    );
  };
  firstRead();

  let server: { close(): Promise<void> } | undefined;
  let closing: Promise<void> | undefined;
  return {
    applyPgSwitch,
    applyEntryPauseRelease,
    resolvePgSwitch,
    extend: (handlers, onError) => withResolvePgSwitch(handlers, resolvePgSwitch, onError),
    async listen() {
      if (port === undefined) return undefined;
      const started = await startPaymentControlServer({
        host: o.env.PEAKET_CONTROL_GRPC_HOST ?? '0.0.0.0',
        port,
        ...(o.profile ? { profile: o.profile } : {}),
        ...(o.metrics ? { metrics: o.metrics } : {}),
        deps: {
          pgSwitch: applyPgSwitch,
          release: applyEntryPauseRelease,
          podName: o.podName,
          allowSimulator,
          nowMs: () => o.clock.now(),
          runbook: runbookGateConfigFromProcess(o.env, 'payment-svc', (e) => o.logger.warn({ runbookSecurity: e }, '런북 묶음을 거부했다')),
          log: { applied: ({ kind, ...rest }) => o.logger.info({ kind: 'payment-control', controlKind: kind, ...rest }, '제어 명령을 받았다') },
          onError: (method, err) => o.logger.error({ kind: 'payment-control', method, err: err instanceof Error ? err.name : 'unknown' }, '제어 명령 처리 실패'),
        },
      });
      server = started;
      o.logger.info({ kind: 'payment-control', port: started.port }, '제어 gRPC 포트를 열었다');
      return started.port;
    },
    stop() {
      closing ??= (async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        if (refresh) clearInterval(refresh);
        await server?.close();
      })();
      return closing;
    },
  };
}
