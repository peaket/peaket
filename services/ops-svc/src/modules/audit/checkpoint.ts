// 감사 체크포인트(BAT-465 GAT-310, docs/features/control-tower.md §7, ADR-0075).
// 감사 체인의 일정 구간을 SHA-256 루트로 묶고, 직전 체크포인트 루트와 이어 사슬을 만든다.
// 이 첫 몫은 공개 앵커·서명·OpenTimestamps 없이 내부 체크포인트와 검증만 둔다(후속).
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database, ProblemError } from '@peaket/platform';
import { sql, type SQL } from 'drizzle-orm';
import type { AuditAnchorSigner } from './anchor.js';
import { appendAuditIn, auditHash, type AuditChain, type AuditRecord } from './audit.js';

export interface AuditChainEntry {
  readonly seq: number;
  readonly hash: string;
  /** 직전 기록 해시(첫 기록은 빈 글자). 저장된 연쇄를 검증한다(B3-H03) */
  readonly prevHash?: string;
  /** 정규화 기록. 없으면(0012 이전 행) 기록 재계산 검증이 실패한다 */
  readonly record?: AuditRecord;
}

/** 감사 체인의 읽기 면. 체크포인트가 구간의 해시를 다시 모으는 데 쓴다 */
export interface AuditChainReader {
  headSeq(): Promise<number>;
  headHash(): Promise<string>;
  entriesBetween(fromSeq: number, toSeq: number): Promise<readonly AuditChainEntry[]>;
  /** 구간 첫 기록의 직전 해시를 경계에서 대조하기 위해 읽는다(seq 0은 빈 글자) */
  hashAt(seq: number): Promise<string | undefined>;
  /** 기록 종류·ID가 가리키는 원본 행이 아직 같은 내용인가. 저장소가 없으면 해당 없음(참) */
  sourceMatches?(entry: AuditChainEntry): Promise<boolean>;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** record_json(정규화 기록)을 해시 재계산용 AuditRecord로 되돌린다. 모양이 깨졌으면 undefined */
export function auditRecordFromJson(raw: unknown): AuditRecord | undefined {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!isObject(value)) return undefined;
  const { recordType, recordId, payload, at } = value;
  if (typeof recordType !== 'string' || typeof recordId !== 'string' || typeof at !== 'string' || !isObject(payload)) return undefined;
  const nowMs = Date.parse(at);
  if (!Number.isFinite(nowMs)) return undefined;
  return { recordType, recordId, payload, nowMs };
}

export interface AuditCheckpoint {
  readonly checkpointId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly rootHash: string;
  readonly prevCheckpointHash: string;
  readonly reason: string;
  readonly actorRef: string;
  readonly createdAtMs: number;
  /** Ed25519 서명(base64). 서명기가 없는 시험 조립에서는 없다 */
  readonly signature?: string;
  readonly keyId?: string;
  /** 공개 앵커 참조(외부 불변 저장소의 위치). 이번 몫은 local:<checkpointId>다 */
  readonly anchorRef?: string;
  readonly anchoredAtMs?: number;
}

export interface NewAuditCheckpoint {
  readonly checkpointId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly rootHash: string;
  readonly prevCheckpointHash: string;
  readonly reason: string;
  readonly actorRef: string;
  readonly nowMs: number;
  readonly signature?: string;
  readonly keyId?: string;
  readonly anchorRef?: string;
  readonly anchoredAtMs?: number;
}

export interface AuditCheckpointStore {
  create(input: NewAuditCheckpoint): Promise<AuditCheckpoint>;
  /**
   * 체크포인트 행과 AUDIT_CHECKPOINT_CREATED 체인 기록을 한 트랜잭션에 쓴다(OPS-04).
   * 같은 from_seq가 이미 있으면 그 체크포인트를 돌려준다(중복 생성 금지).
   */
  createWithAudit?(input: NewAuditCheckpoint, record: AuditRecord): Promise<AuditCheckpoint>;
  list(limit: number): Promise<readonly AuditCheckpoint[]>;
  find(checkpointId: string): Promise<AuditCheckpoint | undefined>;
  head(): Promise<AuditCheckpoint | undefined>;
  findPrevious(fromSeq: number): Promise<AuditCheckpoint | undefined>;
}

export interface AuditCheckpointVerification {
  readonly checkpointId: string;
  readonly valid: boolean;
  readonly rootValid: boolean;
  readonly prevValid: boolean;
  /** 서명이 그 체크포인트 값과 맞는가. 서명기가 없는 조립이면 참(해당 없음) */
  readonly signatureValid: boolean;
  /** 공개 앵커 참조가 남았는가 */
  readonly anchorValid: boolean;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly checkedAtMs: number;
}

/** 구간 기록의 (seq, hash)를 순서대로 이어 붙인 SHA-256(16진) */
export function auditCheckpointRoot(entries: readonly AuditChainEntry[]): string {
  const h = createHash('sha256');
  for (const e of entries) h.update(`${e.seq}:${e.hash}\n`);
  return h.digest('hex');
}

export class MemoryAuditCheckpointStore implements AuditCheckpointStore {
  readonly entries: AuditCheckpoint[] = [];

  async create(input: NewAuditCheckpoint): Promise<AuditCheckpoint> {
    const checkpoint: AuditCheckpoint = {
      checkpointId: input.checkpointId,
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      rootHash: input.rootHash,
      prevCheckpointHash: input.prevCheckpointHash,
      reason: input.reason,
      actorRef: input.actorRef,
      createdAtMs: input.nowMs,
      ...(input.signature !== undefined ? { signature: input.signature } : {}),
      ...(input.keyId !== undefined ? { keyId: input.keyId } : {}),
      ...(input.anchorRef !== undefined ? { anchorRef: input.anchorRef } : {}),
      ...(input.anchoredAtMs !== undefined ? { anchoredAtMs: input.anchoredAtMs } : {}),
    };
    this.entries.push(checkpoint);
    return checkpoint;
  }

  async list(limit: number): Promise<readonly AuditCheckpoint[]> {
    return [...this.entries].sort((a, b) => b.createdAtMs - a.createdAtMs || b.toSeq - a.toSeq).slice(0, limit);
  }

  async find(checkpointId: string): Promise<AuditCheckpoint | undefined> {
    return this.entries.find((c) => c.checkpointId === checkpointId);
  }

  async head(): Promise<AuditCheckpoint | undefined> {
    return [...this.entries].sort((a, b) => b.toSeq - a.toSeq || b.createdAtMs - a.createdAtMs)[0];
  }

  async findPrevious(fromSeq: number): Promise<AuditCheckpoint | undefined> {
    return [...this.entries].filter((c) => c.toSeq < fromSeq).sort((a, b) => b.toSeq - a.toSeq)[0];
  }
}

/** 체크포인트를 만들고, 만든 사실을 감사 체인에 덧붙인다. 검증은 구간 기록을 다시 모아 루트·직전 사슬·서명·앵커를 본다 */
export class AuditCheckpointService {
  constructor(
    private readonly store: AuditCheckpointStore,
    private readonly chain: AuditChain & AuditChainReader,
    private readonly nowMs: () => number,
    /** 공개 앵커 서명기(BAT-465 R-584). 없으면 서명·앵커 검증은 해당 없음(참)이다 */
    private readonly signer?: AuditAnchorSigner,
  ) {}

  async create(q: { reason: string; actorRef: string }): Promise<AuditCheckpoint> {
    const last = await this.store.head();
    const fromSeq = (last?.toSeq ?? 0) + 1;
    const toSeq = await this.chain.headSeq();
    if (toSeq < fromSeq) {
      if (last) return last;
      throw new ProblemError({ type: 'checkpoint-empty', status: 409, title: '묶을 감사 기록이 없습니다' });
    }
    const entries = await this.chain.entriesBetween(fromSeq, toSeq);
    if (entries.length !== toSeq - fromSeq + 1) throw new ProblemError({ type: 'audit-chain-broken', status: 409, title: '감사 체인 구간이 비었습니다' });
    const checkpointId = randomUUID();
    const nowMs = this.nowMs();
    const rootHash = auditCheckpointRoot(entries);
    const prevCheckpointHash = last?.rootHash ?? '';
    const sig = this.signer?.sign({ checkpointId, fromSeq, toSeq, rootHash, prevCheckpointHash, createdAtMs: nowMs });
    const anchorRef = `local:${checkpointId}`;
    const input: NewAuditCheckpoint = {
      checkpointId,
      fromSeq,
      toSeq,
      rootHash,
      prevCheckpointHash,
      reason: q.reason,
      actorRef: q.actorRef,
      nowMs,
      ...(sig ? { signature: sig.signature, keyId: sig.keyId } : {}),
      anchorRef,
      anchoredAtMs: nowMs,
    };
    const record: AuditRecord = {
      recordType: 'AUDIT_CHECKPOINT_CREATED',
      recordId: checkpointId,
      payload: { fromSeq, toSeq, rootHash, prevCheckpointHash, anchorRef, ...(sig ? { signature: sig.signature, keyId: sig.keyId } : {}) },
      nowMs,
    };
    if (this.store.createWithAudit) return this.store.createWithAudit(input, record);
    const checkpoint = await this.store.create(input);
    await this.chain.append(record);
    return checkpoint;
  }

  async list(limit: number): Promise<readonly AuditCheckpoint[]> {
    return this.store.list(limit);
  }

  async get(checkpointId: string): Promise<AuditCheckpoint> {
    const checkpoint = await this.store.find(checkpointId);
    if (!checkpoint) throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
    return checkpoint;
  }

  async verify(checkpointId: string): Promise<AuditCheckpointVerification> {
    const checkpoint = await this.get(checkpointId);
    const entries = await this.chain.entriesBetween(checkpoint.fromSeq, checkpoint.toSeq);
    const lengthValid = entries.length === checkpoint.toSeq - checkpoint.fromSeq + 1;
    const rootMatches = lengthValid && auditCheckpointRoot(entries) === checkpoint.rootHash;
    // 저장된 해시만 모으는 것으로는 원본 행 변조를 잡지 못한다. record_json으로 해시를 다시 계산하고
    // prev_hash 연쇄를 경계까지 확인하며, 가능하면 ops_command·command_event 원본과도 대조한다(B3-H03).
    const recordsValid = entries.every((e) => e.record !== undefined && auditHash(e.prevHash ?? '', e.record) === e.hash);
    const boundaryHash = checkpoint.fromSeq > 1 ? await this.chain.hashAt(checkpoint.fromSeq - 1) : '';
    const boundaryValid = checkpoint.fromSeq === 1 ? true : boundaryHash !== undefined;
    const linksValid =
      boundaryValid && entries.every((e, i) => e.prevHash === (i === 0 ? (checkpoint.fromSeq === 1 ? '' : boundaryHash!) : entries[i - 1]!.hash));
    const sourceValid = this.chain.sourceMatches ? (await Promise.all(entries.map((e) => this.chain.sourceMatches!(e)))).every(Boolean) : true;
    const rootValid = rootMatches && recordsValid && linksValid && sourceValid;
    const previous = await this.store.findPrevious(checkpoint.fromSeq);
    const prevValid = checkpoint.prevCheckpointHash === (previous?.rootHash ?? '');
    const signatureValid =
      !this.signer ||
      (checkpoint.signature !== undefined &&
        this.signer.verify(
          {
            checkpointId: checkpoint.checkpointId,
            fromSeq: checkpoint.fromSeq,
            toSeq: checkpoint.toSeq,
            rootHash: checkpoint.rootHash,
            prevCheckpointHash: checkpoint.prevCheckpointHash,
            createdAtMs: checkpoint.createdAtMs,
          },
          checkpoint.signature,
        ));
    const anchorValid = checkpoint.anchorRef !== undefined && checkpoint.anchorRef !== '';
    return {
      checkpointId: checkpoint.checkpointId,
      valid: rootValid && prevValid && signatureValid && anchorValid,
      rootValid,
      prevValid,
      signatureValid,
      anchorValid,
      fromSeq: checkpoint.fromSeq,
      toSeq: checkpoint.toSeq,
      checkedAtMs: this.nowMs(),
    };
  }
}

interface CheckpointRow {
  id: string;
  from_seq: number | string;
  to_seq: number | string;
  root_hash: string;
  prev_hash: string;
  reason: string;
  actor_ref: string;
  created_at: Date | string;
  signature: string | null;
  key_id: string | null;
  anchor_ref: string | null;
  anchored_at: Date | string | null;
}

const toCheckpoint = (r: CheckpointRow): AuditCheckpoint => ({
  checkpointId: r.id,
  fromSeq: Number(r.from_seq),
  toSeq: Number(r.to_seq),
  rootHash: r.root_hash,
  prevCheckpointHash: r.prev_hash,
  reason: r.reason,
  actorRef: r.actor_ref,
  createdAtMs: new Date(r.created_at).getTime(),
  ...(r.signature !== null ? { signature: r.signature } : {}),
  ...(r.key_id !== null ? { keyId: r.key_id } : {}),
  ...(r.anchor_ref !== null ? { anchorRef: r.anchor_ref } : {}),
  ...(r.anchored_at !== null ? { anchoredAtMs: new Date(r.anchored_at).getTime() } : {}),
});

/** PostgreSQL 감사 체인 읽기·쓰기. 체크포인트 표와 같은 DB를 쓴다 */
@Injectable()
export class DrizzleAuditChain implements AuditChain, AuditChainReader {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async append(record: AuditRecord): Promise<void> {
    await this.database.transaction((tx) => appendAuditIn(tx, record));
  }

  async headSeq(): Promise<number> {
    const [row] = (await this.database.db.execute(sql`select last_seq from audit_chain_head where id = 1`)).rows as { last_seq: number | string }[];
    if (!row) throw new Error('audit_chain_head 행이 없다(마이그레이션 0000)');
    return Number(row.last_seq);
  }

  async headHash(): Promise<string> {
    const [row] = (await this.database.db.execute(sql`select encode(last_hash, 'hex') as last_hash from audit_chain_head where id = 1`)).rows as { last_hash: string }[];
    if (!row) throw new Error('audit_chain_head 행이 없다(마이그레이션 0000)');
    return row.last_hash;
  }

  async entriesBetween(fromSeq: number, toSeq: number): Promise<readonly AuditChainEntry[]> {
    if (toSeq < fromSeq) return [];
    const rows = (await this.database.db.execute(sql`
      select seq, encode(record_sha256, 'hex') as hash, encode(prev_hash, 'hex') as prev_hash, record_json from audit_chain
      where seq between ${fromSeq}::bigint and ${toSeq}::bigint order by seq`)).rows as {
      seq: number | string;
      hash: string;
      prev_hash: string | null;
      record_json: unknown;
    }[];
    return rows.map((r) => {
      const record = r.record_json === null ? undefined : auditRecordFromJson(r.record_json);
      return { seq: Number(r.seq), hash: r.hash, prevHash: r.prev_hash ?? '', ...(record !== undefined ? { record } : {}) };
    });
  }

  async hashAt(seq: number): Promise<string | undefined> {
    if (seq <= 0) return '';
    const [row] = (await this.database.db.execute(sql`select encode(record_sha256, 'hex') as hash from audit_chain where seq = ${seq}::bigint`)).rows as { hash: string }[];
    return row?.hash;
  }

  /**
   * record_json과 원본 행을 대조한다(B3-H03). 명령 기록은 ops_command·command_event·command_approval,
   * 체크포인트 기록은 audit_checkpoint를 다시 읽는다. 그 밖의 기록 종류는 원본 대조 대상이 아니다.
   */
  async sourceMatches(entry: AuditChainEntry): Promise<boolean> {
    const record = entry.record;
    if (!record) return false;
    const p = record.payload;
    const id = record.recordId;
    const exists = async (query: SQL): Promise<boolean> => (await this.database.db.execute(query)).rows.length > 0;
    switch (record.recordType) {
      case 'COMMAND_CREATED': {
        const [row] = (await this.database.db.execute(sql`
          select type, reason, requested_by, requested_role from ops_command where id = ${id}::uuid`)).rows as {
          type: string;
          reason: string;
          requested_by: string;
          requested_role: string;
        }[];
        if (!row || row.type !== p.type || row.reason !== p.reason || row.requested_by !== p.requestedBy) return false;
        return (
          (await exists(sql`
            select 1 from command_event where command_id = ${id}::uuid and seq = 1 and type = 'CREATED'
              and actor_ref = ${row.requested_by} and actor_role = ${row.requested_role} and reason = ${row.reason}`)) &&
          (await exists(sql`
            select 1 from command_event where command_id = ${id}::uuid and seq = 2 and type = ${String(p.state)}
              and actor_ref = ${row.requested_by} and actor_role = ${row.requested_role} and reason = ${row.reason}`))
        );
      }
      case 'COMMAND_APPROVED':
      case 'COMMAND_REJECTED': {
        const decision = record.recordType === 'COMMAND_APPROVED' ? 'APPROVED' : 'REJECTED';
        const [row] = (await this.database.db.execute(sql`
          select decision, approver_role, reason from command_approval where command_id = ${id}::uuid and approver_ref = ${String(p.approverRef)}`)).rows as {
          decision: string;
          approver_role: string;
          reason: string | null;
        }[];
        if (!row || row.decision !== decision || row.approver_role !== p.approverRole) return false;
        if ((row.reason ?? undefined) !== p.reason) return false;
        return exists(sql`
          select 1 from command_event where command_id = ${id}::uuid and type = ${decision}
            and actor_ref = ${String(p.approverRef)} and actor_role = ${String(p.approverRole)}`);
      }
      case 'COMMAND_EXECUTION_STARTED': {
        const [row] = (await this.database.db.execute(sql`select attempts from ops_command where id = ${id}::uuid`)).rows as { attempts: number | string }[];
        if (!row || Number(row.attempts) < Number(p.attempt)) return false;
        return exists(sql`
          select 1 from command_event where command_id = ${id}::uuid and type = 'DISPATCHED' and actor_ref = 'system' and actor_role = 'system'`);
      }
      case 'COMMAND_EXECUTION_FAILED':
        return exists(sql`
          select 1 from command_event where command_id = ${id}::uuid and type = 'FAILED' and actor_ref = 'system' and reason = ${String(p.reason)}`);
      case 'COMMAND_SUCCEEDED':
        return exists(sql`
          select 1 from command_event where command_id = ${id}::uuid and type = 'SUCCEEDED' and actor_ref = 'system' and actor_role = 'system'`);
      case 'EVENT_CANCELLATION_REQUESTED':
      case 'EVENT_CANCELLATION_JUDGED':
      case 'EVENT_CANCELLATION_APPROVED':
      case 'EVENT_CANCELLATION_REJECTED':
      case 'EVENT_CANCELLATION_PAUSED':
      case 'EVENT_CANCELLATION_RESUMED': {
        const [row] = (await this.database.db.execute(sql`
          select event_id, kind, reason, requested_by from event_cancellation_request where request_id = ${id}::uuid`)).rows as {
          event_id: string;
          kind: string;
          reason: string;
          requested_by: string;
        }[];
        if (!row) return false;
        return row.event_id === p.eventId && row.kind === p.kind && row.reason === p.requestReason && row.requested_by === p.requestedBy;
      }
      case 'PAYOUT_APPROVAL_REQUESTED':
      case 'PAYOUT_BATCH_EXECUTING':
      case 'PAYOUT_BATCH_DONE':
      case 'PAYOUT_BATCH_FAILED':
      case 'PAYOUT_APPROVAL_REJECTED': {
        const [row] = (await this.database.db.execute(sql`
          select batch_id, pg, pg_store, payout_date, amount, statement_count, requester_id from payout_approval where id = ${id}::uuid`)).rows as {
          batch_id: string;
          pg: string;
          pg_store: string;
          payout_date: string;
          amount: number | string;
          statement_count: number | string;
          requester_id: string;
        }[];
        if (!row) return false;
        return (
          row.batch_id === p.batchId &&
          row.pg === p.pg &&
          row.pg_store === p.pgStore &&
          row.payout_date === p.payoutDate &&
          Number(row.amount) === Number(p.amount) &&
          Number(row.statement_count) === Number(p.statementCount) &&
          row.requester_id === p.requesterId
        );
      }
      case 'PAYOUT_PORTONE_EXECUTION': {
        const [row] = (await this.database.db.execute(sql`
          select amount from payout_approval where batch_id = ${String(p.batchId)}::uuid limit 1`)).rows as { amount: number | string }[];
        return !row || Number(row.amount) === Number(p.amount);
      }
      case 'AUDIT_CHECKPOINT_CREATED': {
        const [row] = (await this.database.db.execute(sql`
          select from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash,
                 anchor_ref, signature
          from audit_checkpoint where id = ${id}::uuid`)).rows as {
          from_seq: number | string;
          to_seq: number | string;
          root_hash: string;
          prev_hash: string;
          anchor_ref: string | null;
          signature: string | null;
        }[];
        if (!row) return false;
        return (
          Number(row.from_seq) === Number(p.fromSeq) &&
          Number(row.to_seq) === Number(p.toSeq) &&
          row.root_hash === p.rootHash &&
          row.prev_hash === p.prevCheckpointHash &&
          (row.anchor_ref ?? undefined) === p.anchorRef &&
          (row.signature ?? undefined) === p.signature
        );
      }
      default:
        return true;
    }
  }
}

@Injectable()
export class DrizzleAuditCheckpointStore implements AuditCheckpointStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** 체크포인트 행과 AUDIT_CHECKPOINT_CREATED를 한 트랜잭션에 쓴다. audit_chain_head 행 잠금으로 같은 구간 중복을 막는다 */
  async createWithAudit(input: NewAuditCheckpoint, record: AuditRecord): Promise<AuditCheckpoint> {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`select 1 from audit_chain_head where id = 1 for update`);
      const existing = (await tx.execute(sql`
        select id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at,
               signature, key_id, anchor_ref, anchored_at
        from audit_checkpoint where from_seq = ${input.fromSeq}::bigint limit 1`)).rows as unknown as CheckpointRow[];
      if (existing[0]) return toCheckpoint(existing[0]);
      const [row] = (await tx.execute(sql`
        insert into audit_checkpoint (id, from_seq, to_seq, root_hash, prev_hash, reason, actor_ref, created_at, signature, key_id, anchor_ref, anchored_at)
        values (${input.checkpointId}::uuid, ${input.fromSeq}::bigint, ${input.toSeq}::bigint, decode(${input.rootHash}, 'hex'), decode(${input.prevCheckpointHash || ''}, 'hex'),
                ${input.reason}, ${input.actorRef}, ${new Date(input.nowMs)}::timestamptz,
                ${input.signature ?? null}, ${input.keyId ?? null}, ${input.anchorRef ?? null},
                ${input.anchoredAtMs !== undefined ? sql`${new Date(input.anchoredAtMs)}::timestamptz` : sql`null`})
        returning id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at,
                  signature, key_id, anchor_ref, anchored_at`)).rows as unknown as CheckpointRow[];
      if (!row) throw new Error('감사 체크포인트를 쓰지 못했다');
      await appendAuditIn(tx, record);
      return toCheckpoint(row);
    });
  }

  async create(input: NewAuditCheckpoint): Promise<AuditCheckpoint> {
    const [row] = (await this.database.db.execute(sql`
      insert into audit_checkpoint (id, from_seq, to_seq, root_hash, prev_hash, reason, actor_ref, created_at, signature, key_id, anchor_ref, anchored_at)
      values (${input.checkpointId}::uuid, ${input.fromSeq}::bigint, ${input.toSeq}::bigint, decode(${input.rootHash}, 'hex'), decode(${input.prevCheckpointHash || ''}, 'hex'),
              ${input.reason}, ${input.actorRef}, ${new Date(input.nowMs)}::timestamptz,
              ${input.signature ?? null},
              ${input.keyId ?? null}, ${input.anchorRef ?? null},
              ${input.anchoredAtMs !== undefined ? sql`${new Date(input.anchoredAtMs)}::timestamptz` : sql`null`})
      returning id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at,
                signature, key_id, anchor_ref, anchored_at`)).rows as unknown as CheckpointRow[];
    if (!row) throw new Error('감사 체크포인트를 쓰지 못했다');
    return toCheckpoint(row);
  }

  async list(limit: number): Promise<readonly AuditCheckpoint[]> {
    const rows = (await this.database.db.execute(sql`
      select id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at,
             signature, key_id, anchor_ref, anchored_at
      from audit_checkpoint order by created_at desc, to_seq desc limit ${limit}`)).rows as unknown as CheckpointRow[];
    return rows.map(toCheckpoint);
  }

  async find(checkpointId: string): Promise<AuditCheckpoint | undefined> {
    const [row] = (await this.database.db.execute(sql`
      select id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at,
             signature, key_id, anchor_ref, anchored_at
      from audit_checkpoint where id = ${checkpointId}::uuid`)).rows as unknown as CheckpointRow[];
    return row ? toCheckpoint(row) : undefined;
  }

  async head(): Promise<AuditCheckpoint | undefined> {
    const [row] = (await this.database.db.execute(sql`
      select id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at,
             signature, key_id, anchor_ref, anchored_at
      from audit_checkpoint order by to_seq desc, created_at desc limit 1`)).rows as unknown as CheckpointRow[];
    return row ? toCheckpoint(row) : undefined;
  }

  async findPrevious(fromSeq: number): Promise<AuditCheckpoint | undefined> {
    const [row] = (await this.database.db.execute(sql`
      select id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at,
             signature, key_id, anchor_ref, anchored_at
      from audit_checkpoint where to_seq < ${fromSeq}::bigint order by to_seq desc limit 1`)).rows as unknown as CheckpointRow[];
    return row ? toCheckpoint(row) : undefined;
  }
}
