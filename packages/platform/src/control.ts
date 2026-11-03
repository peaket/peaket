// 제어 상태 시작 작업·방송형 소비·다시 맞춤(openspec 변경 add-maintenance-control-and-consumers 결정 7~10, ADR-0103 결정 2·3·4,
// ADR-0143 결정 2, D-T29). Kafka 클라이언트와 상관없게 방송형 읽기 포트(BroadcastSource) 뒤에서 돈다. Kafka 구현은 stream-worker.
// - 시작 작업 셋(제어 상태, control.settings 끝까지, control.sessions-terminated 지금 − 15분부터)이 끝나야 준비 상태
// - Kafka에 닿지 못하면 30초 [가정] 뒤 그 작업을 끝난 것으로 치고 control_sync_lagging{kind}=1(따라잡으면 0)
// - 제어 상태는 2초 [가정]마다 다시 읽어 판 번호가 큰 쪽을 남긴다. 설정은 키마다 큰 판(occurredAt)만, 지우는 표시는 지움, 만료는 무시
import { Gauge, type Registry } from '@prometheus-io/client';
import type { Clock } from './clock.js';
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
  terminatedAt: number;
}

/** 제어 사건 값 해석 포트. Avro(Confluent 형식)는 BAS-030이 만든다 */
export interface ControlCodec {
  setting(value: Buffer): SettingChanged;
  sessionTerminated(value: Buffer): SessionTerminated;
}

export class ControlSyncMetrics {
  readonly lagging: Gauge<'service' | 'kind'>;
  readonly consumerLag: Gauge<'service' | 'topic'>;
  readonly appliedVersion: Gauge<'service' | 'key'>;
  constructor(
    registry: Registry,
    readonly service: string,
  ) {
    const registers = [registry];
    this.lagging = new Gauge({ name: 'control_sync_lagging', help: 'Kafka에 닿지 못한 채 준비 상태로 간 시작 작업(따라잡으면 0, ADR-0103 결정 2)', labelNames: ['service', 'kind'], registers });
    this.consumerLag = new Gauge({ name: 'control_consumer_lag_seconds', help: '방송형 토픽에서 처리한 마지막 메시지의 나이(끝을 따라잡으면 0)', labelNames: ['service', 'topic'], registers });
    this.appliedVersion = new Gauge({ name: 'control_settings_applied_version', help: '적용한 설정의 판 번호(occurredAt 밀리초, ADR-0143 결정 2)', labelNames: ['service', 'key'], registers });
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
  logger: { level: string; warn(o: object, msg?: string): void };
  config: { logLevel: string };
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
}

export interface ControlSync {
  settings: SettingsStore;
  control?: ControlState;
  stop(): Promise<void>;
}

const LOG_LEVELS: Record<string, string> = { INFO: 'info', DEBUG: 'debug', TRACE: 'trace' };

/**
 * 시작 작업을 준비 표시에 걸고(listen 전에 부른다) 백그라운드로 돈다. 세 작업이 끝나면 /ready가 200이 된다.
 * 서비스 로그 수준 설정(`<범위>:LOG_LEVEL:<서비스 이름>`)은 바로 적용하고 만료되면 설정의 기본으로 돌린다
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
                warn(`${topic} 사건을 읽지 못해 건너뛴다(오프셋 ${r.offset})`, err);
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
        settings.apply(r.key ?? '', r.value === null ? null : o.codec.setting(r.value));
      },
    ),
  );
  tasks.push(
    topicTask(
      'sessions',
      CONTROL_TOPICS.sessionsTerminated,
      // Kafka가 돌아올 때마다 '지금 − 15분'을 다시 잰다
      () => o.source.offsetsAt(CONTROL_TOPICS.sessionsTerminated, host.clock.now() - t.sessionsRewindMs),
      (r) => {
        if (r.value === null) return;
        const e = o.codec.sessionTerminated(r.value);
        host.auth.terminateSession({ sessionId: e.sessionId, terminatedAt: new Date(e.terminatedAt).toISOString() });
      },
    ),
  );
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
