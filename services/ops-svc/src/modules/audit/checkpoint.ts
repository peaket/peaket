// 감사 체크포인트(BAT-465 GAT-310, docs/features/control-tower.md §7, ADR-0075).
// 감사 체인의 일정 구간을 SHA-256 루트로 묶고, 직전 체크포인트 루트와 이어 사슬을 만든다.
// 이 첫 몫은 공개 앵커·서명·OpenTimestamps 없이 내부 체크포인트와 검증만 둔다(후속).
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database, ProblemError } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { appendAuditIn, type AuditChain, type AuditRecord } from './audit.js';

export interface AuditChainEntry {
  readonly seq: number;
  readonly hash: string;
}

/** 감사 체인의 읽기 면. 체크포인트가 구간의 해시를 다시 모으는 데 쓴다 */
export interface AuditChainReader {
  headSeq(): Promise<number>;
  headHash(): Promise<string>;
  entriesBetween(fromSeq: number, toSeq: number): Promise<readonly AuditChainEntry[]>;
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
}

export interface AuditCheckpointStore {
  create(input: NewAuditCheckpoint): Promise<AuditCheckpoint>;
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

/** 체크포인트를 만들고, 만든 사실을 감사 체인에 덧붙인다. 검증은 구간 기록을 다시 모아 루트와 직전 사슬을 본다 */
export class AuditCheckpointService {
  constructor(
    private readonly store: AuditCheckpointStore,
    private readonly chain: AuditChain & AuditChainReader,
    private readonly nowMs: () => number,
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
    const checkpoint = await this.store.create({
      checkpointId,
      fromSeq,
      toSeq,
      rootHash: auditCheckpointRoot(entries),
      prevCheckpointHash: last?.rootHash ?? '',
      reason: q.reason,
      actorRef: q.actorRef,
      nowMs,
    });
    await this.chain.append({
      recordType: 'AUDIT_CHECKPOINT_CREATED',
      recordId: checkpointId,
      payload: { fromSeq, toSeq, rootHash: checkpoint.rootHash, prevCheckpointHash: checkpoint.prevCheckpointHash },
      nowMs,
    });
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
    const rootValid = entries.length === checkpoint.toSeq - checkpoint.fromSeq + 1 && auditCheckpointRoot(entries) === checkpoint.rootHash;
    const previous = await this.store.findPrevious(checkpoint.fromSeq);
    const prevValid = checkpoint.prevCheckpointHash === (previous?.rootHash ?? '');
    return {
      checkpointId: checkpoint.checkpointId,
      valid: rootValid && prevValid,
      rootValid,
      prevValid,
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
      select seq, encode(record_sha256, 'hex') as hash from audit_chain
      where seq between ${fromSeq}::bigint and ${toSeq}::bigint order by seq`)).rows as { seq: number | string; hash: string }[];
    return rows.map((r) => ({ seq: Number(r.seq), hash: r.hash }));
  }
}

@Injectable()
export class DrizzleAuditCheckpointStore implements AuditCheckpointStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async create(input: NewAuditCheckpoint): Promise<AuditCheckpoint> {
    const [row] = (await this.database.db.execute(sql`
      insert into audit_checkpoint (id, from_seq, to_seq, root_hash, prev_hash, reason, actor_ref, created_at)
      values (${input.checkpointId}::uuid, ${input.fromSeq}::bigint, ${input.toSeq}::bigint, decode(${input.rootHash}, 'hex'), decode(${input.prevCheckpointHash || ''}, 'hex'),
              ${input.reason}, ${input.actorRef}, ${new Date(input.nowMs)}::timestamptz)
      returning id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at`)).rows as unknown as CheckpointRow[];
    if (!row) throw new Error('감사 체크포인트를 쓰지 못했다');
    return toCheckpoint(row);
  }

  async list(limit: number): Promise<readonly AuditCheckpoint[]> {
    const rows = (await this.database.db.execute(sql`
      select id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at
      from audit_checkpoint order by created_at desc, to_seq desc limit ${limit}`)).rows as unknown as CheckpointRow[];
    return rows.map(toCheckpoint);
  }

  async find(checkpointId: string): Promise<AuditCheckpoint | undefined> {
    const [row] = (await this.database.db.execute(sql`
      select id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at
      from audit_checkpoint where id = ${checkpointId}::uuid`)).rows as unknown as CheckpointRow[];
    return row ? toCheckpoint(row) : undefined;
  }

  async head(): Promise<AuditCheckpoint | undefined> {
    const [row] = (await this.database.db.execute(sql`
      select id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at
      from audit_checkpoint order by to_seq desc, created_at desc limit 1`)).rows as unknown as CheckpointRow[];
    return row ? toCheckpoint(row) : undefined;
  }

  async findPrevious(fromSeq: number): Promise<AuditCheckpoint | undefined> {
    const [row] = (await this.database.db.execute(sql`
      select id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at
      from audit_checkpoint where to_seq < ${fromSeq}::bigint order by to_seq desc limit 1`)).rows as unknown as CheckpointRow[];
    return row ? toCheckpoint(row) : undefined;
  }
}
