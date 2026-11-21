// 명령 정비 작업(30초 [가정] 간격, ADR-0340 결정 3·4·5·8). 때가 된 명령을 FOR UPDATE SKIP LOCKED로 하나씩 골라:
// 승인 기한이 지난 PENDING_APPROVAL → REJECTED(SYSTEM, approval-expired), REVERT_PENDING → ACKED(REVERT_EXPIRED),
// 만료가 지난 명령 2·8 → AUTO_EXPIRED(SYSTEM), 비교 때가 된 명령 → DRY_RUN_COMPARED(예측·실제, 세지 못하면 unavailable)를 남긴다.
// 하루 한 번 3년 [가정] 지난 관리 계정 대응 행을 지운다(삭제 보류 행은 남긴다).
import { ACTOR_MAPPING_PURGE_INTERVAL_MS, ACTOR_MAPPING_RETENTION_MS, type Command } from '../domain/command.js';
import { closeIfApprovalExpired, writeAutoExpired, writeComparison } from '../domain/command-writes.js';
import { compareDryRun, type DryRunPrediction } from '../domain/dry-run.js';
import type { CommandDueKind, CommandStore } from '../domain/ports.js';
import type { ComputeDryRun } from './compute-dry-run.js';

export interface MaintainCommandsOptions {
  /** 한 바퀴에 종류마다 처리하는 명령 수(기본 50 [가정]) */
  readonly batch?: number;
  readonly actorRetentionMs?: number;
  readonly actorPurgeIntervalMs?: number;
}

export interface MaintenanceRound {
  readonly approvalsExpired: number;
  readonly revertsExpired: number;
  readonly autoExpired: number;
  readonly compared: number;
  readonly actorsPurged: number;
}

const predictedOf = (c: Command): DryRunPrediction[] => (Array.isArray(c.dryRun?.predicted) ? (c.dryRun.predicted as DryRunPrediction[]) : []);

export class MaintainCommands {
  readonly #batch: number;
  readonly #retentionMs: number;
  readonly #purgeIntervalMs: number;
  #lastPurgeMs: number | undefined;

  constructor(
    private readonly store: CommandStore,
    private readonly dryRun: ComputeDryRun,
    o: MaintainCommandsOptions = {},
  ) {
    this.#batch = o.batch ?? 50;
    this.#retentionMs = o.actorRetentionMs ?? ACTOR_MAPPING_RETENTION_MS;
    this.#purgeIntervalMs = o.actorPurgeIntervalMs ?? ACTOR_MAPPING_PURGE_INTERVAL_MS;
  }

  async #each(kind: CommandDueKind, nowMs: number, fn: Parameters<CommandStore['mutateDue']>[2]): Promise<number> {
    let n = 0;
    while (n < this.#batch && (await this.store.mutateDue(kind, nowMs, fn))) n += 1;
    return n;
  }

  /** 한 바퀴. 한 종류가 실패해도 다음 종류는 한다(실패는 다음 바퀴에 다시) */
  async runOnce(nowMs: number): Promise<MaintenanceRound> {
    const safe = async (f: () => Promise<number>): Promise<number> => {
      try {
        return await f();
      } catch {
        return 0;
      }
    };
    const approvalsExpired = await safe(() => this.#each('APPROVAL_EXPIRED', nowMs, async (w) => void (await closeIfApprovalExpired(w, nowMs))));
    const revertsExpired = await safe(() => this.#each('REVERT_EXPIRED', nowMs, async (w) => void (await closeIfApprovalExpired(w, nowMs))));
    const autoExpired = await safe(() =>
      this.#each('AUTO_EXPIRE', nowMs, async (w) => {
        if (w.current.expiresAtMs !== undefined && w.current.expiresAtMs <= nowMs) await writeAutoExpired(w, { reason: 'expired', nowMs });
      }),
    );
    const compared = await safe(() => this.compareDue(nowMs));
    let actorsPurged = 0;
    if (this.#lastPurgeMs === undefined || nowMs - this.#lastPurgeMs >= this.#purgeIntervalMs) {
      actorsPurged = await safe(() => this.store.purgeActors(nowMs - this.#retentionMs));
      this.#lastPurgeMs = nowMs;
    }
    return { approvalsExpired, revertsExpired, autoExpired, compared, actorsPurged };
  }

  /** 비교 때가 된 명령의 실제 값을 같은 원천으로 세어 남긴다. 원천을 세지 못하면 그 사실을 unavailable로 남긴다 */
  async compareDue(nowMs: number): Promise<number> {
    let n = 0;
    for (const id of await this.store.dueForCompare(nowMs, this.#batch)) {
      const c = await this.store.find(id);
      if (!c || c.compareDueAtMs === undefined || c.compareDueAtMs > nowMs) continue;
      const actual = await this.dryRun.count({ type: c.type, params: c.params, ...(c.eventId !== undefined ? { eventId: c.eventId } : {}) }, nowMs);
      const comparison = compareDryRun(predictedOf(c), c.params, actual, nowMs);
      if (await this.store.mutate(id, (w) => writeComparison(w, { comparison: comparison as unknown as Record<string, unknown>, nowMs }))) n += 1;
    }
    return n;
  }

  /** 명령 4처럼 다른 작업이 거둔 것을 확인한 뒤 AUTO_EXPIRED(SYSTEM)로 적는다(OPS-290이 쓴다). 적었으면 참 */
  async markAutoExpired(commandId: string, reason: string, nowMs: number): Promise<boolean> {
    return (await this.store.mutate(commandId, (w) => writeAutoExpired(w, { reason, nowMs }))) ?? false;
  }
}
