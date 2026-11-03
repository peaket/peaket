// 정비 반복(openspec 변경 add-maintenance-control-and-consumers 결정 16, ADR-0086·0114·0116, docs/data.md §2).
// 서비스별 Outbox 릴레이 프로세스 안에서 Lease 리더가 돈다. 10분 [가정]마다 깨어나 '매일' 일은 한국 시각 하루에 한 번 성공할 때까지,
// '정비 시간' 일은 04:00~06:00 안에서 그날 성공할 때까지 한다. 일마다 마지막 성공 시각과 실패 수를 지표로 낸다.
import { Counter, Gauge, type Registry } from '@prometheus-io/client';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import { deleteReprocessedHeldEvents } from './held-events.js';
import { deleteExpiredIdempotencyRecords } from './idempotency.js';
import { dropExpiredOutboxPartitions, ensureOutboxPartitions, inMaintenanceWindow, kstDayStart, OUTBOX_TABLE } from './outbox.js';
import type { LeaderState } from './outbox-relay.js';
import { realSleep } from './outbox-relay.js';
import { analyzeTable, dropMonthlyPartitions, ensureMonthlyPartitions, monthlyPartitionsAhead, type MonthlyPartition, type MonthlyPartitionSpec } from './partitions.js';
import { deleteExpiredRows, reindexBloatedIndexes, retentionOverdueSeconds, type RetentionSpec } from './retention.js';
import { takeStatSnapshot } from './stat-snapshot.js';

export const MAINTENANCE_DEFAULTS = { everyMs: 600_000 } as const;

export interface MaintenanceTask {
  name: string;
  /** daily: 하루 한 번(시간 무관), window: 정비 시간(04:00~06:00 KST) 안에서 하루 한 번 */
  when: 'daily' | 'window';
  /** signal: 반복을 멈출 때(프로세스 종료) 끊긴다. 나눠 지우는 일은 묶음 사이에 보고 멈춘다 */
  run(signal?: AbortSignal): Promise<unknown>;
}

export interface MaintenanceMetrics {
  lastSuccess: Gauge<'service' | 'task'>;
  failures: Counter<'service' | 'task'>;
  partitionsAhead: Gauge<'service' | 'table'>;
  retentionIncomplete: Gauge<'service' | 'table'>;
  retentionOverdue: Gauge<'service' | 'table'>;
  service: string;
}

export function maintenanceMetrics(registry: Registry, service: string): MaintenanceMetrics {
  const registers = [registry];
  return {
    service,
    lastSuccess: new Gauge({ name: 'maintenance_task_last_success_timestamp_seconds', help: '정비 일의 마지막 성공 시각(유닉스 초)', labelNames: ['service', 'task'], registers }),
    failures: new Counter({ name: 'maintenance_task_failures_total', help: '정비 일의 실패 수', labelNames: ['service', 'task'], registers }),
    partitionsAhead: new Gauge({ name: 'partitions_ahead', help: '이번 달 뒤로 미리 만든 월 파티션 수(2 [가정]보다 적으면 SEV2)', labelNames: ['service', 'table'], registers }),
    retentionIncomplete: new Gauge({ name: 'maintenance_retention_incomplete', help: '그날 보존 기한이 지난 행을 다 지우지 못했다(SEV3 hygiene)', labelNames: ['service', 'table'], registers }),
    retentionOverdue: new Gauge({ name: 'maintenance_retention_overdue_seconds', help: '남은 가장 오래된 지울 행이 기한을 넘긴 시간(5일 [가정] 넘으면 SEV2 legal)', labelNames: ['service', 'table'], registers }),
  };
}

export interface MaintenanceRunnerOptions {
  service: string;
  clock: Clock;
  leader: LeaderState;
  tasks: MaintenanceTask[];
  registry?: Registry;
  metrics?: MaintenanceMetrics;
  everyMs?: number;
  logger?: { warn(o: object, msg?: string): void; info?(o: object, msg?: string): void };
}

export class MaintenanceRunner {
  readonly metrics: MaintenanceMetrics | undefined;
  readonly #done = new Map<string, number>();
  #stop: AbortController | undefined;
  #loop: Promise<void> | undefined;

  constructor(private readonly o: MaintenanceRunnerOptions) {
    this.metrics = o.metrics ?? (o.registry ? maintenanceMetrics(o.registry, o.service) : undefined);
  }

  /** 한 번 깨어난다. 리더가 아니면 아무것도 하지 않는다. signal이 끊기면 남은 일을 하지 않고, 끊긴 뒤 끝난 일은 성공으로 적지 않는다 */
  async tick(signal?: AbortSignal): Promise<{ ran: string[]; failed: string[] }> {
    const out = { ran: [] as string[], failed: [] as string[] };
    if (!this.o.leader.isLeader()) return out;
    for (const task of this.o.tasks) {
      if (signal?.aborted) break;
      const now = this.o.clock.now();
      const day = kstDayStart(now);
      if (this.#done.get(task.name) === day) continue;
      if (task.when === 'window' && !inMaintenanceWindow(now)) continue;
      try {
        const report = await task.run(signal);
        if (signal?.aborted) break;
        this.#done.set(task.name, day);
        this.metrics?.lastSuccess.set({ service: this.o.service, task: task.name }, Math.floor(this.o.clock.now() / 1000));
        this.o.logger?.info?.({ kind: 'maintenance', task: task.name, report }, '정비 일 끝');
        out.ran.push(task.name);
      } catch (err) {
        if (signal?.aborted) break;
        this.metrics?.failures.inc({ service: this.o.service, task: task.name });
        this.o.logger?.warn({ kind: 'maintenance', task: task.name, err: err instanceof Error ? { type: err.name, message: err.message } : String(err) }, '정비 일 실패(다음에 다시 한다)');
        out.failed.push(task.name);
      }
    }
    return out;
  }

  start(): void {
    if (this.#loop) return;
    const stop = new AbortController();
    this.#stop = stop;
    this.#loop = (async () => {
      while (!stop.signal.aborted) {
        this.#again = false;
        await this.tick(stop.signal);
        if (this.#again) continue;
        const wake = new AbortController();
        this.#wake = wake;
        await realSleep(this.o.everyMs ?? MAINTENANCE_DEFAULTS.everyMs, AbortSignal.any([stop.signal, wake.signal]));
        this.#wake = undefined;
      }
    })();
  }

  /**
   * 쉬는 반복을 바로 깨운다. 리더가 된 복제가 10분 [가정]을 기다리지 않고 정비를 하게 릴레이 프로세스가 부른다(BUILD_ORDER FND-110).
   * 도는 중이면 끝난 뒤 한 번 더 돈다(겹쳐 돌지 않는다)
   */
  wake(): void {
    if (this.#wake) this.#wake.abort();
    else this.#again = true;
  }

  #wake: AbortController | undefined;
  #again = false;

  /**
   * 반복을 멈춘다. 도는 일에 멈춤 신호를 주고 끝나기를 기다린다. timeoutMs를 주면 그만큼만 기다리고 돌아온다
   * (끝나지 않은 일은 프로세스가 끝나며 DB 연결과 함께 끊긴다. 릴레이 프로세스가 Lease를 붙잡지 않게, 코드 리뷰 2026-11-01)
   */
  async stop(o: { timeoutMs?: number } = {}): Promise<void> {
    this.#stop?.abort();
    const loop = this.#loop;
    if (loop && o.timeoutMs !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((r) => (timer = setTimeout(r, o.timeoutMs)));
      await Promise.race([loop, limit]);
      clearTimeout(timer);
    } else await loop;
    this.#loop = undefined;
  }
}

// ---- 기본 정비 일 ----

/** 모든 서비스: Outbox 파티션 만들기·부모 ANALYZE(매일)·지우기(정비 시간), 멱등 기록·보류 행 지우기, 통계 스냅샷 */
export function platformMaintenanceTasks(database: Database, clock: Clock, o: { idempotencyTable?: string } = {}): MaintenanceTask[] {
  return [
    {
      name: 'outbox-partitions-ensure',
      when: 'daily',
      run: async () => {
        const r = await ensureOutboxPartitions(database, clock);
        await analyzeTable(database, OUTBOX_TABLE);
        return r;
      },
    },
    {
      name: 'outbox-partitions-drop',
      when: 'window',
      run: async () => {
        const r = await dropExpiredOutboxPartitions(database, clock);
        if (r.failed.length > 0) throw new Error(`Outbox 파티션을 지우지 못했다: ${r.failed.join(', ')}`);
        return r;
      },
    },
    {
      name: 'idempotency-records-delete',
      when: 'window',
      run: (signal) => deleteExpiredIdempotencyRecords(database, { clock, table: o.idempotencyTable, signal }),
    },
    { name: 'held-events-delete', when: 'window', run: () => deleteReprocessedHeldEvents(database, clock) },
    { name: 'stat-snapshot', when: 'daily', run: () => takeStatSnapshot(database, clock) },
  ];
}

/** 월 파티션 표 하나: 만들기·부모 ANALYZE·미리 만든 달 지표(매일), 조건부 지우기(정비 시간) */
export function monthlyPartitionTasks(database: Database, clock: Clock, spec: MonthlyPartitionSpec, canDrop: (p: MonthlyPartition) => Promise<boolean>, metrics?: MaintenanceMetrics): MaintenanceTask[] {
  return [
    {
      name: `${spec.table}-partitions-ensure`,
      when: 'daily',
      run: async () => {
        const r = await ensureMonthlyPartitions(database, clock, spec);
        await analyzeTable(database, spec.table);
        metrics?.partitionsAhead.set({ service: metrics.service, table: spec.table }, await monthlyPartitionsAhead(database, clock, spec));
        return r;
      },
    },
    {
      name: `${spec.table}-partitions-drop`,
      when: 'window',
      run: async () => {
        const r = await dropMonthlyPartitions(database, clock, spec, canDrop);
        if (r.failed.length > 0) throw new Error(`${spec.table} 파티션을 떼어 내지 못했다(가리키는 행이 남았을 수 있다): ${r.failed.join(', ')}`);
        return r;
      },
    },
  ];
}

/** 나누지 않는 표 하나의 보존 나눠 지우기(정비 시간). 다 못 지우면 실패로 남겨 다음 깨어남에 이어 한다 */
export function retentionTask(database: Database, clock: Clock, spec: RetentionSpec, o: { guard?: () => Promise<string | undefined>; metrics?: MaintenanceMetrics; batchSize?: number } = {}): MaintenanceTask {
  return {
    name: `${spec.table}-retention`,
    when: 'window',
    run: async (signal) => {
      const r = await deleteExpiredRows(database, clock, spec, { guard: o.guard, batchSize: o.batchSize, signal });
      if (r.stopped === 'aborted') return r;
      const labels = { service: o.metrics?.service ?? '', table: spec.table };
      o.metrics?.retentionIncomplete.set(labels, r.stopped === 'done' ? 0 : 1);
      o.metrics?.retentionOverdue.set(labels, await retentionOverdueSeconds(database, clock, spec));
      if (r.stopped !== 'done') throw new Error(`${spec.table} 보존 지우기를 멈췄다(${r.stopped}${r.reason ? `: ${r.reason}` : ''}), 지운 ${r.deleted}건`);
      return r;
    },
  };
}

/** 큰 삭제 뒤 부푼 인덱스 다시 만들기(정비 시간) */
export function reindexTask(database: Database, tables: string[]): MaintenanceTask {
  return { name: 'reindex-bloated', when: 'window', run: () => reindexBloatedIndexes(database, { tables }) };
}
