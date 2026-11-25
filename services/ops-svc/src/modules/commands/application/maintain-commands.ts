// 명령 정비 작업(30초 [가정] 간격, ADR-0340 결정 3·4·5·8). 때가 된 명령을 FOR UPDATE SKIP LOCKED로 하나씩 골라:
// 승인 기한이 지난 PENDING_APPROVAL → REJECTED(SYSTEM, approval-expired), REVERT_PENDING → ACKED(REVERT_EXPIRED),
// 만료가 지난 명령 2·8 → AUTO_EXPIRED(SYSTEM), 비교 때가 된 명령 → DRY_RUN_COMPARED(예측·실제, 세지 못하면 unavailable)를 남긴다.
// 하루 한 번 3년 [가정] 지난 관리 계정 대응 행을 지운다(삭제 보류 행은 남긴다).
// BAT-360(ADR-0349 결정 7·10): 만료가 지난 ACKED 명령 4는 WAF IP 집합 둘을 읽어 대역이 모두 빠졌거나 만료 전 다른 명령 4가 같은 대역을 막을 때만 AUTO_EXPIRED(SYSTEM)로 적고,
//   IP 집합을 읽지 못하면 그대로 두고 다음 바퀴에 다시 본다(ASN 항목이 있는 명령은 이 확인 밖이다). 사후 검토는 놓친 할 일을 열고 기한 넘김 SEV3를 한 번 낸다.
//   새 몫의 수(blocksExpired·postReviewsOpened·postReviewAlerts)는 0이 아닐 때만 결과에 싣는다.
import { ACTOR_MAPPING_PURGE_INTERVAL_MS, ACTOR_MAPPING_RETENTION_MS, type Command } from '../domain/command.js';
import { blockCommandOf, blockExpired, blockExpiryVerdict, ipSetKeys, type IpFamily } from '../domain/block-expiry.js';
import { closeIfApprovalExpired, writeAutoExpired, writeComparison, writeSettingChange } from '../domain/command-writes.js';
import { compareDryRun, type DryRunPrediction } from '../domain/dry-run.js';
import type { BlockIpSetReader, CommandDueKind, CommandStore } from '../domain/ports.js';
import type { ComputeDryRun } from './compute-dry-run.js';
import type { PostReviews } from './post-review.js';

export interface MaintainCommandsOptions {
  /** 한 바퀴에 종류마다 처리하는 명령 수(기본 50 [가정]) */
  readonly batch?: number;
  readonly actorRetentionMs?: number;
  readonly actorPurgeIntervalMs?: number;
}

/** 정비가 더 보는 몫(BAT-360). 주지 않으면 그 몫을 하지 않는다 */
export interface MaintainCommandsExtras {
  /** 명령 4 만료 확인이 읽는 WAF IP 집합 둘. 없으면(local·ci, 설정 없음) 명령 4는 ACKED 그대로다 */
  readonly blockIpSets?: BlockIpSetReader;
  /** 사후 검토 할 일 열기·기한 경보 */
  readonly postReviews?: PostReviews;
  /**
   * 제어 gRPC 명령(F-02-1, ADR-0365 결정 4): DISPATCHED로 남은 명령을 같은 판으로 이어 보내고, AUTO_EXPIRED가 된 명령 2는 새 판으로 입장 일시정지를 푼다.
   * 없으면 하지 않는다
   */
  readonly control?: {
    resumeDispatched(nowMs: number): Promise<number>;
    sendNew(command: Command, phase: 'EXPIRE'): Promise<unknown>;
  };
}

export interface MaintenanceRound {
  readonly approvalsExpired: number;
  readonly revertsExpired: number;
  readonly autoExpired: number;
  readonly compared: number;
  readonly actorsPurged: number;
  /** 명령 4 AUTO_EXPIRED(0이면 없다) */
  readonly blocksExpired?: number;
  /** 연 사후 검토 할 일(0이면 없다) */
  readonly postReviewsOpened?: number;
  /** 이어 보내기를 시작한 제어 명령(0이면 없다) */
  readonly controlsResumed?: number;
  /** 낸 사후 검토 기한 경보(0이면 없다) */
  readonly postReviewAlerts?: number;
}

const predictedOf = (c: Command): DryRunPrediction[] => (Array.isArray(c.dryRun?.predicted) ? (c.dryRun.predicted as DryRunPrediction[]) : []);
/** 명령 4 만료 확인이 한 바퀴에 읽는 ACKED 명령 4 쪽 수 상한(쪽마다 100) */
const BLOCK_PAGES = 5;

export class MaintainCommands {
  readonly #batch: number;
  readonly #retentionMs: number;
  readonly #purgeIntervalMs: number;
  #lastPurgeMs: number | undefined;

  constructor(
    private readonly store: CommandStore,
    private readonly dryRun: ComputeDryRun,
    o: MaintainCommandsOptions = {},
    private readonly extras: MaintainCommandsExtras = {},
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
    const expired: Command[] = [];
    const autoExpired = await safe(() =>
      this.#each('AUTO_EXPIRE', nowMs, async (w) => {
        if (w.current.expiresAtMs !== undefined && w.current.expiresAtMs <= nowMs && (await writeAutoExpired(w, { reason: 'expired', nowMs }))) {
          if (w.current.type === 'LOG_LEVEL') {
            const ok = await writeSettingChange(w, { phase: 'EXPIRE', nowMs });
            if (!ok) throw new Error('settings-outbox-not-wired');
          }
          expired.push(w.current);
        }
      }),
    );
    // 만료 되돌림은 원장의 새 판이다(ADR-0365 결정 1). 받는 쪽(admission-ctrl)도 만료 시각으로 스스로 풀므로 기다리지 않는다(실패는 로그만)
    const control = this.extras.control;
    if (control) for (const c of expired) if (c.type === 'ADMISSION_PAUSE') void control.sendNew(c, 'EXPIRE').catch(() => undefined);
    const controlsResumed = control ? await safe(() => control.resumeDispatched(nowMs)) : 0;
    const compared = await safe(() => this.compareDue(nowMs));
    let actorsPurged = 0;
    if (this.#lastPurgeMs === undefined || nowMs - this.#lastPurgeMs >= this.#purgeIntervalMs) {
      actorsPurged = await safe(() => this.store.purgeActors(nowMs - this.#retentionMs));
      this.#lastPurgeMs = nowMs;
    }
    const blocksExpired = await safe(() => this.expireBlocks(nowMs));
    let review = { opened: 0, alerted: 0 };
    if (this.extras.postReviews) {
      try {
        review = await this.extras.postReviews.maintain(nowMs, this.#batch);
      } catch {
        // 다음 바퀴에 다시
      }
    }
    return {
      approvalsExpired,
      revertsExpired,
      autoExpired,
      compared,
      actorsPurged,
      ...(blocksExpired > 0 ? { blocksExpired } : {}),
      ...(review.opened > 0 ? { postReviewsOpened: review.opened } : {}),
      ...(review.alerted > 0 ? { postReviewAlerts: review.alerted } : {}),
      ...(controlsResumed > 0 ? { controlsResumed } : {}),
    };
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

  /**
   * 만료가 지난 ACKED 명령 4의 AUTO_EXPIRED 확인(ADR-0349 결정 10, C-T61 ⑥). 만료 − 1ms에는 아니다.
   * 만료 전 다른 ACKED 명령 4의 대역은 '덮음'으로 본다. 그 가족의 IP 집합을 읽지 못한 명령은 그대로 둔다. 적은 수
   */
  async expireBlocks(nowMs: number): Promise<number> {
    const sets = this.extras.blockIpSets;
    if (!sets) return 0;
    const acked: Command[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < BLOCK_PAGES; page += 1) {
      const p = await this.store.list({ type: 'BLOCK_ASN_IP', states: ['ACKED'], limit: 100, ...(cursor !== undefined ? { cursor } : {}) });
      acked.push(...p.items);
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    const expired = acked.filter((c) => c.expiresAtMs !== undefined && blockExpired(c.expiresAtMs, nowMs));
    if (expired.length === 0) return 0;
    const live = ipSetKeys(acked.filter((c) => c.expiresAtMs !== undefined && !blockExpired(c.expiresAtMs, nowMs)).flatMap((c) => blockCommandOf(c.commandId, c.params, c.expiresAtMs!).cidrs));
    const read: Partial<Record<IpFamily, ReadonlySet<string>>> = {};
    for (const family of [4, 6] as const) {
      try {
        read[family] = ipSetKeys(await sets.read(family));
      } catch {
        // 읽지 못한 가족의 명령은 다음 바퀴에 다시 본다
      }
    }
    let n = 0;
    for (const c of expired.slice(0, this.#batch)) {
      const verdict = blockExpiryVerdict(blockCommandOf(c.commandId, c.params, c.expiresAtMs!), nowMs, read, live);
      if (!verdict.expire) continue;
      const done = await this.store.mutate(c.commandId, async (w) =>
        w.current.state === 'ACKED' && w.current.expiresAtMs !== undefined && blockExpired(w.current.expiresAtMs, nowMs) ? writeAutoExpired(w, { reason: verdict.reason, nowMs }) : false,
      );
      if (done) n += 1;
    }
    return n;
  }

  /** 명령 4처럼 다른 작업이 거둔 것을 확인한 뒤 AUTO_EXPIRED(SYSTEM)로 적는다(OPS-290이 쓴다). 적었으면 참 */
  async markAutoExpired(commandId: string, reason: string, nowMs: number): Promise<boolean> {
    return (await this.store.mutate(commandId, (w) => writeAutoExpired(w, { reason, nowMs }))) ?? false;
  }
}
