// 감사 공개 앵커 신호(ADR-0348 결정 10, docs/observability.md '감사 공개 앵커 신호'). ops-svc 프로세스가 1분 [가정]마다 표를 읽는다.
// 지표: audit_checkpoint_last_published_timestamp(마지막 게시 시각, 초, 없으면 0), audit_checkpoint_pending_ots(PENDING 수), audit_checkpoint_mismatch_total(어긋남 수).
// 경보(ops 경보, 사건 키 audit-checkpoint):
//   게시 안 된 가장 오래된 공개 체크포인트가 만든 지 6시간 [가정](정각 포함)이면 SEV3 audit-checkpoint-publish-lag, 밀림이 없어지면 푼다.
//   PENDING인 가장 오래된 체크포인트가 만든 지 24시간 [가정](정각 포함)이면 SEV3 audit-ots-incomplete, 없어지면 푼다.
// 어긋남(임대를 쥔 파드만): 서명 전 공개 체크포인트를 같은 검증(AuditCheckpointService.verify)으로 한 번씩 보고, 루트·직전 해시가 맞지 않으면
//   SEV2 audit-checkpoint-mismatch(사건 키 audit-checkpoint:<번호>)와 감사 기록 AUDIT_CHAIN_MISMATCH(그 체크포인트 ID, 한 번)를 남긴다. 게시 작업은 그 체크포인트를 서명·게시하지 않는다.
import { randomUUID } from 'node:crypto';
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { OpsAlertStore } from '../alerts/index.js';
import type { AuditChain } from './audit.js';
import type { AuditChainReader, AuditCheckpoint, AuditCheckpointVerification } from './checkpoint.js';

export const AUDIT_CHECKPOINT_ALERT_EVENT_KEY = 'audit-checkpoint';
export const AUDIT_CHECKPOINT_PUBLISH_LAG_ALERT = 'audit-checkpoint-publish-lag';
export const AUDIT_OTS_INCOMPLETE_ALERT = 'audit-ots-incomplete';
export const AUDIT_CHECKPOINT_MISMATCH_ALERT = 'audit-checkpoint-mismatch';
/** ADR-0348 결정 10의 시간 값 [가정] */
export const CHECKPOINT_SIGNAL_DEFAULTS = Object.freeze({
  intervalMs: 60_000,
  /** 이 나이와 같거나 넘으면 SEV3 */
  publishLagMs: 6 * 60 * 60_000,
  otsIncompleteMs: 24 * 60 * 60_000,
  /** 한 바퀴에 검증할 서명 전 체크포인트 */
  verifyBatch: 20,
});

/** 공개 앵커 지표 셋. 등록은 시작 조립이 서비스 레지스트리에 한다(AuditSignals.register가 함께 붙인다) */
export class CheckpointSignals {
  readonly lastPublished = new Gauge({ name: 'audit_checkpoint_last_published_timestamp', help: '마지막으로 게시한 공개 감사 체크포인트의 게시 시각(유닉스 초, 없으면 0, ADR-0348 결정 10)', registers: [] });
  readonly pendingOts = new Gauge({ name: 'audit_checkpoint_pending_ots', help: '공개 타임스탬프가 대기(PENDING)인 체크포인트 수(ADR-0348 결정 10)', registers: [] });
  readonly mismatchTotal = new Counter({ name: 'audit_checkpoint_mismatch_total', help: '체인을 다시 모은 루트가 저장된 공개 체크포인트와 다른 수(ADR-0348 결정 10)', registers: [] });

  register(registry: Registry): void {
    registry.registerMetric(this.lastPublished);
    registry.registerMetric(this.pendingOts);
    registry.registerMetric(this.mismatchTotal);
  }
}

/** 신호가 읽는 표 요약 */
export interface CheckpointSignalSnapshot {
  readonly lastPublishedAtMs?: number;
  readonly pendingOts: number;
  readonly oldestUnpublished?: { readonly no: number; readonly createdAtMs: number };
  readonly oldestPending?: { readonly no: number; readonly createdAtMs: number };
}

export interface CheckpointSignalSource {
  snapshot(): Promise<CheckpointSignalSnapshot>;
  unsignedPublic(limit: number): Promise<readonly AuditCheckpoint[]>;
}

export interface CheckpointSignalMonitorDeps {
  readonly source: CheckpointSignalSource;
  readonly verify: (checkpointId: string) => Promise<AuditCheckpointVerification>;
  readonly alerts?: OpsAlertStore;
  readonly signals?: CheckpointSignals;
  /** AUDIT_CHAIN_MISMATCH를 남길 체인(entriesOfRecord가 있으면 이미 남긴 것을 거른다) */
  readonly audit?: AuditChain & Partial<Pick<AuditChainReader, 'entriesOfRecord'>>;
  readonly publishLagMs?: number;
  readonly otsIncompleteMs?: number;
}

export class CheckpointSignalMonitor {
  /** 이 프로세스에서 이미 검증한 체크포인트 ID(다시 모으는 값이 크다) */
  readonly #checked = new Set<string>();

  constructor(private readonly deps: CheckpointSignalMonitorDeps) {}

  async runOnce(nowMs: number, o: { readonly leader?: boolean } = {}): Promise<{ readonly publishLag: boolean; readonly otsIncomplete: boolean; readonly mismatches: readonly number[] }> {
    const s = await this.deps.source.snapshot();
    this.deps.signals?.lastPublished.set(s.lastPublishedAtMs !== undefined ? Math.floor(s.lastPublishedAtMs / 1000) : 0);
    this.deps.signals?.pendingOts.set(s.pendingOts);
    const lagMs = this.deps.publishLagMs ?? CHECKPOINT_SIGNAL_DEFAULTS.publishLagMs;
    const otsMs = this.deps.otsIncompleteMs ?? CHECKPOINT_SIGNAL_DEFAULTS.otsIncompleteMs;
    const publishLag = s.oldestUnpublished !== undefined && nowMs - s.oldestUnpublished.createdAtMs >= lagMs;
    const otsIncomplete = s.oldestPending !== undefined && nowMs - s.oldestPending.createdAtMs >= otsMs;
    const alerts = this.deps.alerts;
    if (alerts) {
      if (publishLag) {
        await alerts.open({
          alertId: randomUUID(),
          eventKey: AUDIT_CHECKPOINT_ALERT_EVENT_KEY,
          kind: AUDIT_CHECKPOINT_PUBLISH_LAG_ALERT,
          severity: 'SEV3',
          source: 'ops-svc',
          reason: '감사 체크포인트 게시가 6시간 넘게 밀렸다',
          detail: { no: s.oldestUnpublished!.no, ageMs: nowMs - s.oldestUnpublished!.createdAtMs },
          nowMs,
        });
      } else await alerts.resolve({ eventKey: AUDIT_CHECKPOINT_ALERT_EVENT_KEY, kind: AUDIT_CHECKPOINT_PUBLISH_LAG_ALERT, reason: 'caught-up', nowMs });
      if (otsIncomplete) {
        await alerts.open({
          alertId: randomUUID(),
          eventKey: AUDIT_CHECKPOINT_ALERT_EVENT_KEY,
          kind: AUDIT_OTS_INCOMPLETE_ALERT,
          severity: 'SEV3',
          source: 'ops-svc',
          reason: '공개 타임스탬프가 24시간 넘게 완료되지 않았다',
          detail: { no: s.oldestPending!.no, ageMs: nowMs - s.oldestPending!.createdAtMs },
          nowMs,
        });
      } else await alerts.resolve({ eventKey: AUDIT_CHECKPOINT_ALERT_EVENT_KEY, kind: AUDIT_OTS_INCOMPLETE_ALERT, reason: 'completed', nowMs });
    }
    const mismatches: number[] = [];
    if (o.leader) {
      for (const c of await this.deps.source.unsignedPublic(CHECKPOINT_SIGNAL_DEFAULTS.verifyBatch)) {
        if (this.#checked.has(c.checkpointId)) continue;
        const v = await this.deps.verify(c.checkpointId);
        this.#checked.add(c.checkpointId);
        if (v.rootValid && v.prevValid) continue;
        mismatches.push(c.no!);
        await this.#mismatch(c, v, nowMs);
      }
    }
    return { publishLag, otsIncomplete, mismatches };
  }

  async #mismatch(c: AuditCheckpoint, v: AuditCheckpointVerification, nowMs: number): Promise<void> {
    this.deps.signals?.mismatchTotal.inc();
    const reason = v.rootValid ? 'prev-hash' : 'root';
    await this.deps.alerts?.open({
      alertId: randomUUID(),
      eventKey: `${AUDIT_CHECKPOINT_ALERT_EVENT_KEY}:${c.no}`,
      kind: AUDIT_CHECKPOINT_MISMATCH_ALERT,
      severity: 'SEV2',
      source: 'ops-svc',
      reason: '감사 체인을 다시 모은 값이 공개 체크포인트와 다르다(게시하지 않는다)',
      detail: { no: c.no, checkpointId: c.checkpointId, reason },
      nowMs,
    });
    const audit = this.deps.audit;
    if (!audit) return;
    if (audit.entriesOfRecord) {
      const seen = await audit.entriesOfRecord(c.checkpointId, { limit: 50 });
      if (seen.entries.some((e) => e.recordType === 'AUDIT_CHAIN_MISMATCH')) return;
    }
    await audit.append({ recordType: 'AUDIT_CHAIN_MISMATCH', recordId: c.checkpointId, payload: { checkpointId: c.checkpointId, no: c.no, firstBadSeq: c.fromSeq, reason: `checkpoint-${reason}`, fromSeq: c.fromSeq, toSeq: c.toSeq }, nowMs });
  }
}

/** 메모리 체크포인트 행에서 신호 요약을 만든다(시험·메모리 조립) */
export function checkpointSignalSnapshotOf(rows: readonly AuditCheckpoint[]): CheckpointSignalSnapshot {
  const pub = rows.filter((c) => c.no !== undefined).sort((a, b) => a.no! - b.no!);
  const published = pub.filter((c) => c.publishedAtMs !== undefined);
  const lastPublishedAtMs = published.length ? Math.max(...published.map((c) => c.publishedAtMs!)) : undefined;
  const unpublished = pub.filter((c) => c.publishedAtMs === undefined).sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
  const pending = pub.filter((c) => c.otsState === 'PENDING').sort((a, b) => a.createdAtMs - b.createdAtMs);
  return {
    ...(lastPublishedAtMs !== undefined ? { lastPublishedAtMs } : {}),
    pendingOts: pending.length,
    ...(unpublished ? { oldestUnpublished: { no: unpublished.no!, createdAtMs: unpublished.createdAtMs } } : {}),
    ...(pending[0] ? { oldestPending: { no: pending[0].no!, createdAtMs: pending[0].createdAtMs } } : {}),
  };
}
