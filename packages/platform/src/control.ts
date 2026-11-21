// 제어 상태 시작 작업·방송형 소비·다시 맞춤(openspec 변경 add-maintenance-control-and-consumers 결정 7~10, ADR-0103 결정 2·3·4,
// ADR-0143 결정 2, D-T29). Kafka 클라이언트와 상관없게 방송형 읽기 포트(BroadcastSource) 뒤에서 돈다. Kafka 구현은 stream-worker.
// - 시작 작업 셋(제어 상태, control.settings 끝까지, control.sessions-terminated 지금 − 15분부터)이 끝나야 준비 상태
// - Kafka에 닿지 못하면 30초 [가정] 뒤 그 작업을 끝난 것으로 치고 control_sync_lagging{kind}=1(따라잡으면 0)
// - 제어 상태는 2초 [가정]마다 다시 읽어 판 번호가 큰 쪽을 남긴다. 설정은 키마다 큰 판(occurredAt)만, 지우는 표시는 지움, 만료는 무시
// - 읽지 못한 레코드는 건너뛰고 control_sync_skipped_total{service,topic,reason="unreadable"}로 센다. 종료 사건의 종료 시각을 읽지 못하거나
//   믿을 범위(그 레코드의 Kafka 시각 k에 대해 k − 15분 < 종료 시각 ≤ k + 1분) 밖이면 받은 때부터 막고 reason="time_replaced"로 센다(ADR-0333 결정 4)
// - 정상 로그 줄 표본(LOG_SAMPLING, ADR-0334 결정 2, C-T75): 이 서비스 대상(`PLATFORM:LOG_SAMPLING:*`·`PLATFORM:LOG_SAMPLING:<서비스 이름>`)의 사건은
//   저장 전에 거른다. 본 eventKey는 다시 적용하지 않고, 범위·갈래·만료 시각이 틀리면 버리고 경고 줄 하나를 남긴다. 살아 있는 값(서비스 이름 쪽이 먼저)을
//   바로 setSampleOneIn으로 적용하고, 둘 다 없거나 만료되면 시작 설정 값(PEAKET_LOG_SAMPLE_ONE_IN)으로 돌린다
// - 신원 처리기가 없는 서비스(trust-svc·realtime-gw·admission-ctrl)는 sessions: false로 설정 토픽만 읽는다(docs/features/identity.md §3 '서비스에 잇기')
import { Counter, Gauge, type Registry } from '@prometheus-io/client';
import { TERMINATED_SESSION_TTL_MS } from './auth.js';
import type { Clock } from './clock.js';
import { logSamplingValue } from './control-codec.js';
import { CONTROL_TOPICS } from './outbox.js';
import { realSleep } from './outbox-relay.js';
import type { Readiness } from './readiness.js';

export const CONTROL_SYNC_DEFAULTS = {
  /** Kafka에 닿지 못해도 이만큼 뒤에는 준비 상태로 간다 [가정] */
  degradeAfterMs: 30_000,
  /** 시작 작업을 다시 해 보는 간격 [가정] */
  retryMs: 1_000,
  /** 제어 상태 다시 맞춤·설정 만료 확인 주기 [가정] */
  reconcileMs: 2_000,
  /** 끝 위치를 다시 재 소비 지연을 내는 주기 [가정] */
  measureMs: 5_000,
  /** 종료 세션 되감기(종료 세션 목록을 두는 시간, ADR-0011 결정 2) */
  sessionsRewindMs: 15 * 60_000,
} as const;

/** 종료 시각을 그대로 쓰는 미래 쪽 끝: 그 레코드의 Kafka 시각 + 1분 [가정](노드 시계 차이에 둔 여유, ADR-0333 결정 4) */
const TERMINATED_AT_FUTURE_SKEW_MS = 60_000;

/** 정상 로그 줄 표본 설정의 종류와 모든 서비스 대상 메시지 키(ADR-0334 결정 1) */
const LOG_SAMPLING = 'LOG_SAMPLING';
const LOG_SAMPLING_ALL = `PLATFORM:${LOG_SAMPLING}:*`;
/** 한 번 적용한 LOG_SAMPLING eventKey를 기억하는 수 [가정](하루 몇 건이라 넉넉하다. 넘으면 오래된 것부터 잊고, 그 뒤 같은 사건은 판 번호 비교가 막는다) */
const LOG_SAMPLING_SEEN_MAX = 256;

/** LOG_SAMPLING을 버린 까닭(경고 줄의 reason) */
type LogSamplingRejectReason = 'scope' | 'branch' | 'range' | 'expires_at';

/** control_sync_skipped_total의 까닭(ADR-0333 결정 4) */
type ControlSyncSkipReason = 'unreadable' | 'time_replaced';

/**
 * 종료 사건의 종료 시각을 그대로 믿어도 되는가(ADR-0333 결정 4). 기준 k는 레코드의 Kafka 시각이고, 0 이하이거나 유한하지 않으면 받은 때다.
 * k − 15분 < 종료 시각 ≤ k + 1분이고 Date로 나타낼 수 있어야 한다. 밖이면 받은 때부터 막는다(닫힌 쪽 실패)
 */
function trustedTerminatedAt(terminatedAt: number, recordTimestamp: number, receivedAt: number): Date | undefined {
  if (!Number.isFinite(terminatedAt)) return undefined;
  const k = Number.isFinite(recordTimestamp) && recordTimestamp > 0 ? recordTimestamp : receivedAt;
  if (terminatedAt <= k - TERMINATED_SESSION_TTL_MS || terminatedAt > k + TERMINATED_AT_FUTURE_SKEW_MS) return undefined;
  const at = new Date(terminatedAt);
  return Number.isFinite(at.getTime()) ? at : undefined;
}

export interface BroadcastRecord {
  topic: string;
  partition: number;
  offset: bigint;
  key: string | null;
  /** 지우는 표시는 null */
  value: Buffer | null;
  headers: Record<string, string>;
  /** Kafka 레코드 시각(밀리초) */
  timestamp: number;
}

/** 방송형 읽기 포트: 파드마다 따로, 커밋 없이 읽는다(ADR-0103 결정 3). Kafka 구현은 @peaket/platform/stream-worker */
export interface BroadcastSource {
  /** 파티션마다 처음(low)과 끝(high, 다음에 쓸 오프셋) */
  watermarks(topic: string): Promise<Map<number, { low: bigint; high: bigint }>>;
  /** 파티션마다 그 시각 이후 첫 레코드의 오프셋(없으면 끝) */
  offsetsAt(topic: string, timestampMs: number): Promise<Map<number, bigint>>;
  /** from 위치부터 읽어 onRecord를 차례로 부른다. signal이 끊으면 끝나고, 연결이 끊기면 던진다 */
  read(topic: string, from: Map<number, bigint>, onRecord: (r: BroadcastRecord) => Promise<void> | void, signal: AbortSignal): Promise<void>;
}

/** control.settings 값(docs/api/avro/peaket/control/SettingChanged.avsc) */
export interface SettingChanged {
  commandId: string;
  /** BOT_LEVEL·LOG_LEVEL·FEATURE_FLAG·DEGRADED_MODE·LOBBY_BANNER·PG_ASSIGNMENT·… */
  key: string;
  /** PLATFORM 또는 회차 ID */
  scope: string;
  value: unknown;
  expiresAt: number | null;
  actor: string;
  occurredAt: number;
  eventKey: string;
}

/** control.sessions-terminated 값(SessionTerminated.avsc) */
export interface SessionTerminated {
  accountId: string;
  sessionId: string;
  reason: string;
  /** 종료 시각(밀리초). 읽지 못했으면 NaN이고, startControlSync가 받은 때를 쓴다 */
  terminatedAt: number;
}

/** 제어 사건 값 해석 포트. 던지면 그 레코드를 건너뛰고 센다. 운영 JSON 해독기는 controlEventCodec, Avro(Confluent 형식)는 BAS-030이 만든다 */
export interface ControlCodec {
  setting(value: Buffer): SettingChanged;
  sessionTerminated(value: Buffer): SessionTerminated;
}

export class ControlSyncMetrics {
  readonly lagging: Gauge<'service' | 'kind'>;
  readonly consumerLag: Gauge<'service' | 'topic'>;
  readonly appliedVersion: Gauge<'service' | 'key'>;
  /** 읽지 못해 건너뛴 레코드(unreadable)와 종료 시각을 받은 때로 바꾼 종료 사건(time_replaced). 1건 이상이면 SEV3(ADR-0333 결정 4) */
  readonly skipped: Counter<'service' | 'topic' | 'reason'>;
  constructor(
    registry: Registry,
    readonly service: string,
  ) {
    const registers = [registry];
    this.lagging = new Gauge({ name: 'control_sync_lagging', help: 'Kafka에 닿지 못한 채 준비 상태로 간 시작 작업(따라잡으면 0, ADR-0103 결정 2)', labelNames: ['service', 'kind'], registers });
    this.consumerLag = new Gauge({ name: 'control_consumer_lag_seconds', help: '방송형 토픽에서 처리한 마지막 메시지의 나이(끝을 따라잡으면 0)', labelNames: ['service', 'topic'], registers });
    this.appliedVersion = new Gauge({ name: 'control_settings_applied_version', help: '적용한 설정의 판 번호(occurredAt 밀리초, ADR-0143 결정 2)', labelNames: ['service', 'key'], registers });
    this.skipped = new Counter({ name: 'control_sync_skipped_total', help: '방송형 제어 토픽의 레코드. reason=unreadable은 값을 읽지 못해 건너뛴 것(보안 통제가 레코드 하나만큼 빠졌다), reason=time_replaced는 종료 사건의 종료 시각을 읽지 못하거나 믿을 범위 밖이라 받은 때로 바꾼 것(ADR-0333 결정 4)', labelNames: ['service', 'topic', 'reason'], registers });
  }
}

export interface SettingEntry {
  /** 메시지 키 `<범위>:<종류>:<대상>` */
  key: string;
  kind: string;
  scope: string;
  value: unknown;
  /** 판 번호(occurredAt) */
  version: number;
  expiresAt: number | null;
  commandId: string;
}

type SettingListener = (key: string, entry: SettingEntry | undefined) => void;

/** 설정 저장: 키마다 마지막(가장 큰) 판. 지우는 표시는 지우고, 만료가 지난 값은 없는 것으로 본다 */
export class SettingsStore {
  readonly #entries = new Map<string, SettingEntry>();
  readonly #listeners = new Set<SettingListener>();
  readonly #expired = new Set<string>();

  constructor(
    private readonly clock: Clock,
    private readonly metrics?: ControlSyncMetrics,
  ) {}

  apply(key: string, s: SettingChanged | null): boolean {
    if (s === null) {
      const had = this.#entries.delete(key);
      this.#expired.delete(key);
      if (had) this.#emit(key, undefined);
      return had;
    }
    const cur = this.#entries.get(key);
    if (cur && s.occurredAt <= cur.version) return false;
    this.#entries.set(key, { key, kind: s.key, scope: s.scope, value: s.value, version: s.occurredAt, expiresAt: s.expiresAt, commandId: s.commandId });
    this.#expired.delete(key);
    this.metrics?.appliedVersion.set({ service: this.metrics.service, key }, s.occurredAt);
    const live = this.get(key);
    if (!live) this.#expired.add(key);
    this.#emit(key, live);
    return true;
  }

  get(key: string): SettingEntry | undefined {
    const e = this.#entries.get(key);
    if (!e) return undefined;
    return e.expiresAt !== null && e.expiresAt <= this.clock.now() ? undefined : e;
  }

  entries(): SettingEntry[] {
    return [...this.#entries.keys()].map((k) => this.get(k)).filter((e): e is SettingEntry => e !== undefined);
  }

  /** 새로 만료된 값을 알린다(다시 맞춤 주기마다) */
  sweep(): void {
    for (const key of this.#entries.keys()) {
      if (this.#expired.has(key) || this.get(key)) continue;
      this.#expired.add(key);
      this.#emit(key, undefined);
    }
  }

  onChange(fn: SettingListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(key: string, e: SettingEntry | undefined): void {
    for (const fn of this.#listeners) fn(key, e);
  }
}

/** 제어 상태 한 칸(예: purchase-svc의 sale_control 한 행) */
export interface ControlEntry {
  key: string;
  /** 그 범위·종류에서 늘어나기만 하는 판 번호 */
  version: number;
  value: unknown;
}

/** 서비스가 넘기는 제어 상태 읽기(자기 저장소, 예: purchase DB sale_control) */
export interface ControlStateSource {
  read(): Promise<ControlEntry[]>;
}

type ControlListener = (key: string, entry: ControlEntry) => void;

/** 파드 메모리의 제어 상태. 판 번호가 지금보다 클 때만 바꾼다(비교하고 쓰기) */
export class ControlState {
  readonly #entries = new Map<string, ControlEntry>();
  readonly #listeners = new Set<ControlListener>();

  apply(e: ControlEntry): boolean {
    const cur = this.#entries.get(e.key);
    if (cur && e.version <= cur.version) return false;
    this.#entries.set(e.key, e);
    for (const fn of this.#listeners) fn(e.key, e);
    return true;
  }

  get(key: string): ControlEntry | undefined {
    return this.#entries.get(key);
  }

  entries(): ControlEntry[] {
    return [...this.#entries.values()];
  }

  onChange(fn: ControlListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}

/** startControlSync가 쓰는 서비스의 부분(PlatformService가 채운다) */
export interface ControlSyncHost {
  name: string;
  clock: Clock;
  readiness: Readiness;
  metrics: { registry: Registry };
  logger: { level: string; warn(o: object, msg?: string): void; info(o: object, msg?: string): void };
  /** logLevel·sampleOneIn: 만료된 설정을 되돌릴 시작 설정 값(PEAKET_LOG_LEVEL·PEAKET_LOG_SAMPLE_ONE_IN) */
  config: { logLevel: string; sampleOneIn: number };
  /** 정상 로그 줄 표본 비율(LOG_SAMPLING이 바꾼다, ADR-0334 결정 2) */
  logs: { setSampleOneIn(oneIn: number): void; readonly sampleOneIn: number };
  auth: { terminateSession(e: { sessionId: string; terminatedAt?: string }): void };
}

export interface ControlSyncOptions {
  source: BroadcastSource;
  codec: ControlCodec;
  /** 제어 상태를 갖는 서비스만(purchase-svc sale_control, payment-svc pg_switch 등) */
  controlState?: ControlStateSource;
  degradeAfterMs?: number;
  retryMs?: number;
  reconcileMs?: number;
  measureMs?: number;
  /**
   * 종료 세션 토픽(control.sessions-terminated)도 읽는다. 기본 true. false면 설정 토픽(control.settings)만 읽는다:
   * 게이트웨이 신원 머리를 받는 처리기가 없는 서비스(ADR-0333 결정 1, 추천 적용 2026-11-22 BAT-215 구현, ADR-0334 결정 2)
   */
  sessions?: boolean;
}

export interface ControlSync {
  settings: SettingsStore;
  control?: ControlState;
  stop(): Promise<void>;
}

const LOG_LEVELS: Record<string, string> = { INFO: 'info', DEBUG: 'debug', TRACE: 'trace' };

/**
 * 시작 작업을 준비 표시에 걸고(listen 전에 부른다) 백그라운드로 돈다. 세 작업(sessions: false면 종료 세션을 뺀 것)이 끝나면 /ready가 200이 된다.
 * 서비스 로그 수준 설정(`<범위>:LOG_LEVEL:<서비스 이름>`)과 정상 로그 줄 표본 설정(`PLATFORM:LOG_SAMPLING:*`·`PLATFORM:LOG_SAMPLING:<서비스 이름>`)은
 * 바로 적용하고 만료되면 시작 설정 값으로 돌린다
 */
export function startControlSync(host: ControlSyncHost, o: ControlSyncOptions): ControlSync {
  const t = { ...CONTROL_SYNC_DEFAULTS, ...pick(o) };
  const abort = new AbortController();
  const metrics = new ControlSyncMetrics(host.metrics.registry, host.name);
  const settings = new SettingsStore(host.clock, metrics);
  const control = o.controlState ? new ControlState() : undefined;
  const timers: NodeJS.Timeout[] = [];
  const sleep = (ms: number) => realSleep(ms, abort.signal);
  const warn = (msg: string, err: unknown) => host.logger.warn({ kind: 'control-sync', err: err instanceof Error ? { type: err.name, message: err.message } : String(err) }, msg);

  settings.onChange((key, e) => {
    if (key.split(':')[1] !== 'LOG_LEVEL' || key.slice(key.lastIndexOf(':') + 1) !== host.name) return;
    const level = e ? LOG_LEVELS[String((e.value as { level?: unknown } | null)?.level)] : undefined;
    host.logger.level = level ?? host.config.logLevel;
  });

  // 정상 로그 줄 표본(ADR-0334 결정 2). 저장소에는 아래 acceptSetting을 지난 값만 든다
  const samplingKeys = [`PLATFORM:${LOG_SAMPLING}:${host.name}`, LOG_SAMPLING_ALL];
  settings.onChange((key) => {
    if (!samplingKeys.includes(key)) return;
    const live = samplingKeys.map((k) => settings.get(k)).find((x) => x !== undefined);
    const read = live ? logSamplingValue(live.value) : undefined;
    const oneIn = read && 'oneIn' in read ? read.oneIn : host.config.sampleOneIn;
    const changed = oneIn !== host.logs.sampleOneIn;
    host.logs.setSampleOneIn(oneIn);
    if (!changed) return;
    if (live) host.logger.info({ kind: 'control-sync', key: live.key, oneIn, expiresAt: live.expiresAt === null ? null : new Date(live.expiresAt).toISOString() }, 'LOG_SAMPLING 적용');
    else host.logger.info({ kind: 'control-sync', oneIn }, 'LOG_SAMPLING 만료, 시작 설정 값으로 돌림');
  });
  const seenSampling = new Set<string>();
  /**
   * 저장 전에 거른다(ADR-0334 결정 2). 이 서비스 대상 LOG_SAMPLING만 보고 나머지는 그대로 둔다. 거르면 false.
   * 본 eventKey(ops-svc 복제 여럿·재시작이 같은 사건을 다시 낸 것)는 조용히 버리고, 틀린 값은 경고 줄 하나와 함께 버린다(지금 적용한 값은 그대로)
   */
  const acceptSetting = (key: string, s: SettingChanged): boolean => {
    const parts = key.split(':');
    if (parts[1] !== LOG_SAMPLING && s.key !== LOG_SAMPLING) return true;
    const target = parts[parts.length - 1];
    if (target !== '*' && target !== host.name) return true;
    if (seenSampling.has(s.eventKey)) return false;
    seenSampling.add(s.eventKey);
    if (seenSampling.size > LOG_SAMPLING_SEEN_MAX) seenSampling.delete(seenSampling.values().next().value as string);
    const read = logSamplingValue(s.value);
    const reason: LogSamplingRejectReason | undefined =
      parts.length !== 3 || parts[0] !== 'PLATFORM' || s.scope !== 'PLATFORM'
        ? 'scope'
        : parts[1] !== LOG_SAMPLING || s.key !== LOG_SAMPLING || ('invalid' in read && read.invalid === 'branch')
          ? 'branch'
          : 'invalid' in read
            ? 'range'
            : s.expiresAt === null
              ? 'expires_at'
              : undefined;
    if (reason === undefined) return true;
    host.logger.warn({ kind: 'control-sync', key, reason, eventKey: s.eventKey }, 'LOG_SAMPLING 값 무시');
    return false;
  };

  const tasks: Promise<void>[] = [];
  if (control && o.controlState) {
    const source = o.controlState;
    host.readiness.register('control-state');
    tasks.push(
      (async () => {
        let first = true;
        while (!abort.signal.aborted) {
          try {
            for (const e of await source.read()) control.apply(e);
            if (first) host.readiness.complete('control-state');
            first = false;
          } catch (err) {
            warn(first ? '제어 상태를 읽지 못했다(준비 상태가 되지 않는다)' : '제어 상태 다시 맞춤 실패', err);
            if (first) {
              await sleep(t.retryMs);
              continue;
            }
          }
          await sleep(t.reconcileMs);
        }
      })(),
    );
  }

  const topicTask = (kind: 'settings' | 'sessions', topic: string, startAt: () => Promise<Map<number, bigint>>, onRecord: (r: BroadcastRecord) => void) => {
    host.readiness.register(kind);
    const labels = { service: host.name, kind };
    const lagLabels = { service: host.name, topic };
    metrics.lagging.set(labels, 0);
    metrics.consumerLag.set(lagLabels, 0);
    metrics.skipped.inc({ ...lagLabels, reason: 'unreadable' satisfies ControlSyncSkipReason }, 0);
    let caughtUp = false;
    let degraded = false;
    timers.push(
      setTimeout(() => {
        if (caughtUp) return;
        degraded = true;
        metrics.lagging.set(labels, 1);
        host.readiness.complete(kind);
      }, t.degradeAfterMs),
    );
    return (async () => {
      while (!abort.signal.aborted) {
        let high: Map<number, bigint>;
        let pos: Map<number, bigint>;
        try {
          const marks = await o.source.watermarks(topic);
          high = new Map([...marks].map(([p, w]) => [p, w.high]));
          pos = await startAt();
          for (const [p, w] of marks) if (!pos.has(p)) pos.set(p, w.low);
        } catch (err) {
          if (!degraded) warn(`${topic} 시작 위치를 재지 못했다`, err);
          await sleep(t.retryMs);
          continue;
        }
        let last = 0;
        const check = () => {
          for (const [p, h] of high) if ((pos.get(p) ?? 0n) < h) return false;
          return true;
        };
        const reached = () => {
          metrics.consumerLag.set(lagLabels, 0);
          if (caughtUp) return;
          caughtUp = true;
          if (degraded) metrics.lagging.set(labels, 0);
          host.readiness.complete(kind);
        };
        if (check()) reached();
        const measure = setInterval(() => {
          void o.source
            .watermarks(topic)
            .then((marks) => {
              for (const [p, w] of marks) high.set(p, w.high);
              if (check()) reached();
              else if (last > 0) metrics.consumerLag.set(lagLabels, Math.max(0, host.clock.now() - last) / 1000);
            })
            .catch(() => {});
        }, t.measureMs);
        try {
          const from = new Map(pos);
          await o.source.read(
            topic,
            from,
            (r) => {
              pos.set(r.partition, r.offset + 1n);
              last = r.timestamp;
              try {
                onRecord(r);
              } catch (err) {
                metrics.skipped.inc({ ...lagLabels, reason: 'unreadable' satisfies ControlSyncSkipReason });
                warn(`${topic} 사건을 읽지 못해 건너뛴다(파티션 ${r.partition}, 오프셋 ${r.offset})`, err);
              }
              if (check()) reached();
              else metrics.consumerLag.set(lagLabels, Math.max(0, host.clock.now() - r.timestamp) / 1000);
            },
            abort.signal,
          );
        } catch (err) {
          if (!abort.signal.aborted) warn(`${topic} 읽기가 끊겼다(다시 시작한다)`, err);
        } finally {
          clearInterval(measure);
        }
        if (!abort.signal.aborted) await sleep(t.retryMs);
      }
    })();
  };

  tasks.push(
    topicTask(
      'settings',
      CONTROL_TOPICS.settings,
      async () => new Map(),
      (r) => {
        const key = r.key ?? '';
        if (r.value === null) {
          settings.apply(key, null);
          return;
        }
        const s = o.codec.setting(r.value);
        if (acceptSetting(key, s)) settings.apply(key, s);
      },
    ),
  );
  const sessionsTopic = CONTROL_TOPICS.sessionsTerminated;
  const replacedLabels = { service: host.name, topic: sessionsTopic, reason: 'time_replaced' satisfies ControlSyncSkipReason };
  // 세 줄(두 토픽의 unreadable, 종료 사건 토픽의 time_replaced)을 0으로 미리 낸다. unreadable은 topicTask가 낸다. 설정만 읽으면 한 줄이다
  if (o.sessions !== false) {
    metrics.skipped.inc(replacedLabels, 0);
    tasks.push(
      topicTask(
        'sessions',
        sessionsTopic,
        // Kafka가 돌아올 때마다 '지금 − 15분'을 다시 잰다
        () => o.source.offsetsAt(sessionsTopic, host.clock.now() - t.sessionsRewindMs),
        (r) => {
          if (r.value === null) return;
          const e = o.codec.sessionTerminated(r.value);
          const at = trustedTerminatedAt(e.terminatedAt, r.timestamp, host.clock.now());
          if (at) {
            // 범위 안의 옛 사건(받은 때 이미 15분이 지난 것)은 TerminatedSessions가 넣지 않는다(그 세션의 토큰은 이미 수명이 끝났다)
            host.auth.terminateSession({ sessionId: e.sessionId, terminatedAt: at.toISOString() });
            return;
          }
          // 읽지 못하거나 범위 밖이면 시각 없이 넘겨 받은 때부터 15분 막는다(그대로 받거나 건너뛰면 그 세션이 열린 쪽으로 실패한다, ADR-0333 결정 4).
          // 로그에는 sid·값을 싣지 않는다
          host.auth.terminateSession({ sessionId: e.sessionId });
          metrics.skipped.inc(replacedLabels);
          host.logger.warn(
            { kind: 'control-sync', topic: sessionsTopic, partition: r.partition, offset: String(r.offset), reason: 'time_replaced' },
            `${sessionsTopic} 종료 시각을 읽지 못하거나 믿을 범위 밖이라 받은 때부터 막는다(파티션 ${r.partition}, 오프셋 ${r.offset})`,
          );
        },
      ),
    );
  }
  timers.push(setInterval(() => settings.sweep(), t.reconcileMs));

  return {
    settings,
    control,
    async stop() {
      abort.abort();
      for (const x of timers) clearTimeout(x);
      await Promise.allSettled(tasks);
    },
  };
}

function pick(o: ControlSyncOptions) {
  const out: Partial<Record<'degradeAfterMs' | 'retryMs' | 'reconcileMs' | 'measureMs', number>> = {};
  for (const k of ['degradeAfterMs', 'retryMs', 'reconcileMs', 'measureMs'] as const) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
