// 자동 제어 상태 감시(F-03-3 OPS-380, ADR-0371 결정 6·7, docs/features/control-tower.md §6의 6·§8).
// 파드마다 1초 [가정]마다 대기열 Redis에서 진행 중 회차와 회차마다 ctl, 회차와 무관한 q:{admission}:ctl을 읽어 control 값을 만든다.
// - 늘 여는 흐름: 고른 회차를 보는 연결에 붙을 때 한 번, 바뀔 때마다 control 사건을 보낸다(알림 표에 쓰지 않는 지금 값, 결정 6)
// - 입력 없음 경보: inputStale이 켜지면 경보 기록 표에 (회차, control) SEV2를 열고 꺼지면 푼다. 같은 (회차, 종류)는 한 건이라 파드가 여럿이어도 한 건이다.
//   Prometheus·Alertmanager를 거치지 않는다(§8 '제어 입력 없음 SEV2는 … Alertmanager가 멈춰도 뜬다')
// - 대기열 Redis를 읽지 못하면 그 회차들은 unknown이고, 1분 [가정] 넘게 이어지면 SEV3(control)를 연다(§16 운영 확인 줄)
import { randomUUID } from 'node:crypto';
import type { PlatformLogger } from '@peaket/platform';
import type { OpsAlertStore } from '../../alerts/index.js';
import { NO_INPUT_ALERT, PLATFORM_CTL_KEY, controlOf, ctlKeyOf, inputStaleOf, sameControl, type ControlValue } from '../domain/control.js';
import type { ControlReader } from '../domain/ports.js';

/** 감시 주기 1초 [가정](계획 6-7) */
export const CONTROL_WATCH_TICK_MS = 1_000;
/** 읽기 실패가 이만큼 이어지면 SEV3 [가정](control-tower §16) */
export const CONTROL_READ_ALERT_AFTER_MS = 60_000;
/** 읽기 실패 SEV3의 경보 키 */
export const CONTROL_READ_ALERT_KEY = 'ops-control-read';

export type ControlListener = (v: ControlValue) => void;

export interface ControlWatchOptions {
  readonly tickMs?: number;
  readonly now: () => number;
  readonly logger?: PlatformLogger;
  /** 읽기 실패 수(지표 ops_control_read_errors_total) */
  readonly onReadError?: () => void;
}

export class ControlWatch {
  readonly #listeners = new Map<string, Set<ControlListener>>();
  readonly #last = new Map<string, ControlValue>();
  /** 이 파드가 입력 없음 경보를 연 회차 */
  readonly #open = new Set<string>();
  /** 이 파드가 한 번이라도 본 회차(처음 본 정상 회차는 남은 경보를 한 번 푼다: 파드가 다시 떴을 때) */
  readonly #seen = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #failingSinceMs: number | undefined;
  #readAlertOpen = false;

  constructor(
    /** 없으면(대기열 Redis 주소 없음, local·ci) 모든 회차가 unknown이고 경보를 열지 않는다 */
    private readonly reader: ControlReader | undefined,
    private readonly alerts: OpsAlertStore,
    private readonly o: ControlWatchOptions,
  ) {}

  get enabled(): boolean {
    return this.reader !== undefined;
  }

  start(): void {
    if (!this.reader || this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.o.tickMs ?? CONTROL_WATCH_TICK_MS);
    this.#timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 회차의 control을 듣는다. 아는 값이 있으면 바로 한 번 준다(원천이 없으면 unknown 한 번) */
  watch(eventId: string, listener: ControlListener): () => void {
    let set = this.#listeners.get(eventId);
    if (!set) {
      set = new Set();
      this.#listeners.set(eventId, set);
    }
    set.add(listener);
    const known = this.#last.get(eventId);
    if (known) listener(known);
    else if (!this.reader) listener({ eventId, kind: 'unknown', updatedAt: new Date(this.o.now()).toISOString() });
    else void this.tick();
    const s = set;
    return () => {
      s.delete(listener);
      if (s.size === 0) this.#listeners.delete(eventId);
    };
  }

  private emit(v: ControlValue): void {
    const prev = this.#last.get(v.eventId);
    this.#last.set(v.eventId, v);
    if (sameControl(prev, v)) return;
    for (const l of [...(this.#listeners.get(v.eventId) ?? [])]) {
      try {
        l(v);
      } catch {
        // 한 연결의 오류가 다른 연결을 막지 않는다
      }
    }
  }

  /** 한 주기(시험이 바로 부를 수 있다) */
  async tick(): Promise<void> {
    if (!this.reader || this.#running) return;
    this.#running = true;
    const nowMs = this.o.now();
    try {
      let active: string[];
      let platform: Record<string, string>;
      try {
        [active, platform] = await Promise.all([this.reader.activeEvents(nowMs), this.reader.hash(PLATFORM_CTL_KEY).then((h) => h ?? {})]);
      } catch (err) {
        this.readFailed(nowMs, err);
        return;
      }
      const ids = [...new Set([...active, ...this.#listeners.keys()])];
      const activeSet = new Set(active);
      let failed = false;
      await Promise.all(
        ids.map(async (eventId) => {
          let fields: Record<string, string> | undefined;
          try {
            fields = await this.reader!.hash(ctlKeyOf(eventId));
          } catch (err) {
            failed = true;
            this.o.logger?.warn({ kind: 'control-watch', err: err instanceof Error ? err.name : 'error' }, '대기열 Redis 제어 상태를 읽지 못했다');
            this.emit({ eventId, kind: 'unknown', updatedAt: new Date(nowMs).toISOString() });
            return;
          }
          this.emit(controlOf(eventId, fields, platform, nowMs));
          if (activeSet.has(eventId) || fields !== undefined) await this.settleAlert(eventId, fields, nowMs);
        }),
      );
      if (failed) this.readFailed(nowMs, undefined);
      else await this.readRecovered(nowMs);
    } finally {
      this.#running = false;
    }
  }

  private async settleAlert(eventId: string, fields: Record<string, string> | undefined, nowMs: number): Promise<void> {
    const stale = inputStaleOf(fields);
    const firstSeen = !this.#seen.has(eventId);
    this.#seen.add(eventId);
    try {
      if (stale && !this.#open.has(eventId)) {
        await this.alerts.open({
          alertId: randomUUID(),
          eventKey: eventId,
          kind: NO_INPUT_ALERT.kind,
          severity: NO_INPUT_ALERT.severity,
          source: NO_INPUT_ALERT.source,
          reason: NO_INPUT_ALERT.reason,
          detail: { inputStaleKinds: (fields?.inputStaleKinds ?? '').split(',').filter((s) => s.length > 0), ...(fields?.inputStaleAt ? { inputStaleAt: fields.inputStaleAt } : {}) },
          nowMs,
        });
        this.#open.add(eventId);
      } else if (!stale && fields !== undefined && (this.#open.has(eventId) || firstSeen)) {
        await this.alerts.resolve({ eventKey: eventId, kind: NO_INPUT_ALERT.kind, reason: 'input-restored', nowMs });
        this.#open.delete(eventId);
      }
    } catch (err) {
      // 경보 기록 실패는 다음 주기에 다시 한다(열린 것으로 적지 않았다)
      this.o.logger?.warn({ kind: 'control-watch', err: err instanceof Error ? err.name : 'error' }, '입력 없음 경보를 기록하지 못했다');
    }
  }

  private readFailed(nowMs: number, err: unknown): void {
    this.o.onReadError?.();
    if (err !== undefined) {
      this.o.logger?.warn({ kind: 'control-watch', err: err instanceof Error ? err.name : 'error' }, '대기열 Redis 제어 상태를 읽지 못했다');
      for (const eventId of this.#listeners.keys()) this.emit({ eventId, kind: 'unknown', updatedAt: new Date(nowMs).toISOString() });
    }
    this.#failingSinceMs ??= nowMs;
    if (!this.#readAlertOpen && nowMs - this.#failingSinceMs >= CONTROL_READ_ALERT_AFTER_MS) {
      this.#readAlertOpen = true;
      void this.alerts
        .open({ alertId: randomUUID(), eventKey: CONTROL_READ_ALERT_KEY, kind: 'control', severity: 'SEV3', source: NO_INPUT_ALERT.source, reason: '자동 제어 상태를 1분 넘게 읽지 못했습니다', detail: {}, nowMs })
        .catch(() => {
          this.#readAlertOpen = false;
        });
    }
  }

  private async readRecovered(nowMs: number): Promise<void> {
    this.#failingSinceMs = undefined;
    if (!this.#readAlertOpen) return;
    this.#readAlertOpen = false;
    await this.alerts.resolve({ eventKey: CONTROL_READ_ALERT_KEY, kind: 'control', reason: 'read-restored', nowMs }).catch(() => undefined);
  }
}
