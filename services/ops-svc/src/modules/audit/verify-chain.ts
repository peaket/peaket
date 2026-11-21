// 감사 체인 검증 잡(ADR-0341 결정 6, ADR-0053 결정 12). 1시간 [가정]마다 따로 띄우는 작업(src/jobs/verify-audit-chain.ts)이 부른다.
// (가) 마지막 검증 지점 뒤의 행과 지난 25시간 [가정]에 쓴 행: seq 빈틈, record_json으로 다시 계산한 기록 해시와 prev_hash 연쇄, 원본 행 대조, 직전 mac 연결과 VerifyMac.
// (나) 그 구간의 앵커마다 같은 seq 행이 있고 mac이 앵커 값과 같은지(앵커의 원본은 불변 저장소 객체, 없으면 DB 행).
// (다) 25시간보다 오래된 행은 모든 체크포인트의 검증(로컬 해시)을 다시 돌려 지킨다.
// 하나라도 어긋나면 SEV2 audit-chain-mismatch(첫 어긋난 seq·까닭)와 감사 기록 AUDIT_CHAIN_MISMATCH. 검증하지 못했으면(두 리전 KMS 실패 등) ERROR이고 통과로 적지 않는다.
// 남는 한계: 마지막 앵커 뒤 끝 기록 삭제는 드러나지 않는다(C-T27 ③). mac이 빈 동안의 행도 변조 탐지를 받지 않는다.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { OpsAlertStore } from '../alerts/index.js';
import { auditHash, type AuditChain, type AuditRecord } from './audit.js';
import { AUDIT_ALERT_EVENT_KEY, AUDIT_CHAIN_MISMATCH_ALERT } from './chain-worker.js';
import { auditRecordFromJson, type AuditChainEntry, type AuditCheckpointService } from './checkpoint.js';
import { auditMacInput, AuditMacKeyUnavailable, type AuditMacKey } from './mac.js';
import type { MacAnchor, MacAnchorLedger, MacAnchorStore } from './mac-anchor.js';

/** 검증 창 25시간 [가정](하루 한 번 만드는 체크포인트와 겹치게, ADR-0341 결정 6) */
export const AUDIT_VERIFY_WINDOW_MS = 25 * 60 * 60_000;
/** 검증 잡 간격 1시간 [가정](운영 CronJob은 구간 5) */
export const AUDIT_VERIFY_INTERVAL_MS = 60 * 60_000;
const PAGE = 500;

export type AuditVerificationResult = 'VALID' | 'MISMATCH' | 'ERROR';
/** 어긋난 까닭(docs/data.md audit_verification_run.reason) */
export type AuditMismatchReason = 'gap' | 'record' | 'prev-hash' | 'source' | 'mac' | 'anchor' | 'checkpoint';

export interface AuditVerification {
  readonly runId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly result: AuditVerificationResult;
  readonly firstBadSeq?: number;
  readonly reason?: AuditMismatchReason | string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}

export interface AuditVerifyRow {
  readonly seq: number;
  readonly hash: string;
  readonly prevHash: string;
  readonly record?: AuditRecord;
  readonly mac?: Buffer;
}

/** 검증 잡이 읽는 체인 면 */
export interface AuditVerifyStore {
  /** 마지막 VALID 검증의 to_seq(없으면 0) */
  lastVerifiedSeq(): Promise<number>;
  /** created_at이 since 이상인 가장 작은 seq(없으면 undefined) */
  firstSeqSince(sinceMs: number): Promise<number | undefined>;
  rows(fromSeq: number, toSeq: number): Promise<readonly AuditVerifyRow[]>;
  /** seq 행의 기록 해시·mac(seq 0은 빈 값) */
  boundary(seq: number): Promise<{ readonly hash: string; readonly mac?: Buffer } | undefined>;
  recordRun(run: AuditVerification): Promise<void>;
}

export interface AuditChainVerifierDeps {
  readonly store: AuditVerifyStore;
  readonly key: AuditMacKey;
  /** 앵커 행(audit_mac_anchor). 저장소가 durable이 아니면 이것을 앵커로 본다 */
  readonly ledger: Pick<MacAnchorLedger, 'anchorsBetween'>;
  readonly anchors?: MacAnchorStore;
  /** 원본 행 대조(DrizzleAuditChain.sourceMatches). 없으면 해당 없음 */
  readonly sourceMatches?: (entry: AuditChainEntry) => Promise<boolean>;
  /** 체크포인트 재검증(25시간보다 오래된 행) */
  readonly checkpoints?: AuditCheckpointService;
  readonly alerts?: OpsAlertStore;
  /** AUDIT_CHAIN_MISMATCH 감사 기록 */
  readonly audit?: AuditChain;
  readonly windowMs?: number;
}

type Failure = { readonly seq: number; readonly reason: AuditMismatchReason };

export class AuditChainVerifier {
  readonly #windowMs: number;

  constructor(private readonly deps: AuditChainVerifierDeps) {
    this.#windowMs = deps.windowMs ?? AUDIT_VERIFY_WINDOW_MS;
  }

  /** 앵커의 원본: 불변 저장소(durable)면 그 객체, 아니면 DB 앵커 행 */
  async #anchors(fromSeq: number, toSeq: number): Promise<readonly MacAnchor[]> {
    if (this.deps.anchors?.durable) return this.deps.anchors.list(fromSeq, toSeq);
    return this.deps.ledger.anchorsBetween(fromSeq, toSeq);
  }

  /**
   * 구간 하나를 본다(seq 빈틈·기록 해시·직전 해시·원본 행·mac·앵커). 첫 어긋남을 돌려주고, 맞으면 undefined.
   * 머리 행(mac_seq·last_seq)은 고칠 수 있으므로 믿지 않는다: 있는 행을 차례로 보고, 앵커가 찍힌 seq까지는 행과 mac이 꼭 있어야 한다.
   * 앵커 뒤 맨 끝 행이 없는 것은 드러나지 않는다(남는 한계). mac이 빈 행 뒤에 mac이 찬 행이 오면 mac을 지운 변조로 본다.
   * @returns 검증한 마지막 seq와 첫 어긋남
   * @throws AuditMacKeyUnavailable 두 리전 KMS 모두 부르지 못함(ERROR)
   */
  async verifyRange(fromSeq: number, toSeq: number = Number.MAX_SAFE_INTEGER): Promise<{ readonly lastSeq: number; readonly failure?: Failure }> {
    const { store, key } = this.deps;
    const anchors = await this.#anchors(fromSeq, toSeq);
    const anchorBySeq = new Map(anchors.map((a) => [a.seq, a]));
    const lastAnchor = anchors.reduce((m, a) => Math.max(m, a.seq), 0);
    const before = fromSeq > 1 ? await store.boundary(fromSeq - 1) : { hash: '' };
    if (!before) return { lastSeq: fromSeq - 1, failure: { seq: fromSeq - 1, reason: 'gap' } };
    let prevHash = before.hash;
    let prevMac: Buffer = before.mac ?? Buffer.alloc(0);
    let expected = fromSeq;
    let pending = false;
    for (;;) {
      if (expected > toSeq) break;
      const pageEnd = Math.min(toSeq, expected + PAGE - 1);
      const rows = await store.rows(expected, pageEnd);
      for (const row of rows) {
        if (row.seq !== expected) return { lastSeq: expected - 1, failure: { seq: expected, reason: 'gap' } };
        const fail = (reason: AuditMismatchReason) => ({ lastSeq: row.seq - 1, failure: { seq: row.seq, reason } });
        if (!row.record || auditHash(row.prevHash, row.record) !== row.hash) return fail('record');
        if (row.prevHash !== prevHash) return fail('prev-hash');
        if (this.deps.sourceMatches && !(await this.deps.sourceMatches({ seq: row.seq, hash: row.hash, prevHash: row.prevHash, record: row.record }))) return fail('source');
        if (row.mac) {
          if (pending) return fail('mac');
          // mac이 직전 mac 연결을 담는다: 직전 행의 mac을 바꾸면 이 행 검증도 어긋난다
          if (!(await key.verify(auditMacInput(row.seq, prevMac, Buffer.from(row.hash, 'hex')), row.mac))) return fail('mac');
        } else {
          // 앵커가 찍힌 seq까지는 mac이 있어야 한다(앵커는 mac을 채운 뒤에만 쓴다)
          if (row.seq <= lastAnchor) return fail('mac');
          pending = true;
        }
        const anchor = anchorBySeq.get(row.seq);
        if (anchor && row.mac?.toString('hex') !== anchor.mac) return fail('anchor');
        prevHash = row.hash;
        prevMac = row.mac ?? Buffer.alloc(0);
        expected += 1;
      }
      if (expected <= pageEnd) {
        // 더 읽을 행이 없다. 앵커가 찍힌 seq 행이 지워졌으면 드러난다
        if (expected <= lastAnchor) return { lastSeq: expected - 1, failure: { seq: expected, reason: 'gap' } };
        break;
      }
    }
    return { lastSeq: expected - 1 };
  }

  /** (다) 모든 체크포인트를 다시 검증한다. 어긋난 첫 체크포인트의 시작 seq */
  async #checkpoints(): Promise<Failure | undefined> {
    const cps = this.deps.checkpoints;
    if (!cps) return undefined;
    const list = [...(await cps.list(10_000))].sort((a, b) => a.fromSeq - b.fromSeq);
    for (const c of list) {
      const v = await cps.verify(c.checkpointId);
      if (!v.valid) return { seq: c.fromSeq, reason: 'checkpoint' };
    }
    return undefined;
  }

  /** 범위를 주면 그 구간만, 주지 않으면 마지막 검증 지점 뒤와 지난 25시간의 행을 본다. 결과를 남기고 어긋나면 SEV2·감사 기록을 낸다 */
  async verify(range: { fromSeq?: number; toSeq?: number } = {}, nowMs: number = Date.now()): Promise<AuditVerification> {
    const { store } = this.deps;
    const runId = randomUUID();
    let fromSeq = 1;
    let toSeq = 0;
    let result: AuditVerificationResult = 'VALID';
    let failure: Failure | undefined;
    let errorReason: string | undefined;
    try {
      const lastVerified = await store.lastVerifiedSeq();
      const since = await store.firstSeqSince(nowMs - this.#windowMs);
      fromSeq = Math.max(1, range.fromSeq ?? Math.min(lastVerified + 1, since ?? lastVerified + 1));
      const r = await this.verifyRange(fromSeq, range.toSeq ?? Number.MAX_SAFE_INTEGER);
      toSeq = r.lastSeq;
      failure = r.failure;
      if (!failure && range.fromSeq === undefined) failure = await this.#checkpoints();
      if (failure) result = 'MISMATCH';
    } catch (e) {
      result = 'ERROR';
      errorReason = e instanceof AuditMacKeyUnavailable ? `kms:${e.errorName}` : e instanceof Error ? e.name : 'error';
    }
    const run: AuditVerification = {
      runId,
      fromSeq,
      toSeq: Math.max(toSeq, fromSeq - 1),
      result,
      ...(failure ? { firstBadSeq: failure.seq, reason: failure.reason } : {}),
      ...(errorReason !== undefined ? { reason: errorReason } : {}),
      startedAtMs: nowMs,
      finishedAtMs: nowMs,
    };
    await store.recordRun(run);
    if (failure) {
      await this.deps.alerts?.open({
        alertId: randomUUID(),
        eventKey: AUDIT_ALERT_EVENT_KEY,
        kind: AUDIT_CHAIN_MISMATCH_ALERT,
        severity: 'SEV2',
        source: 'ops-svc',
        reason: '감사 체인 검증이 어긋났다(변조·삭제 의심)',
        detail: { firstBadSeq: failure.seq, reason: failure.reason, runId },
        nowMs,
      });
      await this.deps.audit?.append({ recordType: 'AUDIT_CHAIN_MISMATCH', recordId: runId, payload: { runId, firstBadSeq: failure.seq, reason: failure.reason, fromSeq: run.fromSeq, toSeq: run.toSeq }, nowMs });
    }
    return run;
  }
}

/** PostgreSQL 검증 면 */
@Injectable()
export class DrizzleAuditVerifyStore implements AuditVerifyStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async lastVerifiedSeq(): Promise<number> {
    const [row] = (await this.database.db.execute(sql`select coalesce(max(to_seq), 0) as seq from audit_verification_run where result = 'VALID'`)).rows as { seq: number | string }[];
    return Number(row?.seq ?? 0);
  }

  async firstSeqSince(sinceMs: number): Promise<number | undefined> {
    const [row] = (await this.database.db.execute(sql`select min(seq) as seq from audit_chain where created_at >= ${new Date(sinceMs)}::timestamptz`)).rows as { seq: number | string | null }[];
    return row?.seq === null || row?.seq === undefined ? undefined : Number(row.seq);
  }

  async rows(fromSeq: number, toSeq: number): Promise<readonly AuditVerifyRow[]> {
    if (toSeq < fromSeq) return [];
    const rows = (
      await this.database.db.execute(sql`
        select seq, encode(record_sha256, 'hex') as hash, encode(prev_hash, 'hex') as prev_hash, record_json, mac
        from audit_chain where seq between ${fromSeq}::bigint and ${toSeq}::bigint order by seq`)
    ).rows as { seq: number | string; hash: string; prev_hash: string | null; record_json: unknown; mac: Buffer | null }[];
    return rows.map((r) => {
      const record = r.record_json === null ? undefined : auditRecordFromJson(r.record_json);
      return { seq: Number(r.seq), hash: r.hash, prevHash: r.prev_hash ?? '', ...(record ? { record } : {}), ...(r.mac ? { mac: Buffer.from(r.mac) } : {}) };
    });
  }

  async boundary(seq: number): Promise<{ hash: string; mac?: Buffer } | undefined> {
    if (seq <= 0) return { hash: '' };
    const [row] = (await this.database.db.execute(sql`select encode(record_sha256, 'hex') as hash, mac from audit_chain where seq = ${seq}::bigint`)).rows as { hash: string; mac: Buffer | null }[];
    return row ? { hash: row.hash, ...(row.mac ? { mac: Buffer.from(row.mac) } : {}) } : undefined;
  }

  async recordRun(run: AuditVerification): Promise<void> {
    await this.database.db.execute(sql`
      insert into audit_verification_run (run_id, from_seq, to_seq, result, first_bad_seq, reason, started_at, finished_at)
      values (${run.runId}::uuid, ${run.fromSeq}::bigint, ${run.toSeq}::bigint, ${run.result}, ${run.firstBadSeq ?? null}::bigint, ${run.reason ?? null},
              ${new Date(run.startedAtMs)}::timestamptz, ${new Date(run.finishedAtMs)}::timestamptz)`);
  }
}
