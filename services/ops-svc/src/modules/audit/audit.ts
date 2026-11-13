// 불변 감사 로그의 최소 해시 체인(GAT-110, docs/features/control-tower.md §7, docs/data.md audit_chain·audit_chain_head).
// 각 기록의 record_sha256 = SHA-256(직전 해시 || 정규화한 기록 JSON)이고, audit_chain_head.last_hash가 마지막 해시다.
// mac(HMAC)은 체인 작업자가 채우는 자리로 비워 둔다. leaf_salt는 기록 파기 때 함께 파기할 32바이트 난수다.
import { createHash, randomBytes } from 'node:crypto';
import type { DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';

export interface AuditRecord {
  readonly recordType: string;
  readonly recordId: string;
  readonly payload: Record<string, unknown>;
  readonly nowMs: number;
}

export interface AuditEntry {
  readonly seq: number;
  readonly recordType: string;
  readonly recordId: string;
  readonly hash: string;
  readonly prevHash: string;
  readonly createdAtMs: number;
}

/** 해시 체인에 한 기록을 더한다. 구현은 DB 트랜잭션 안(운영) 또는 메모리(시험)다 */
export interface AuditChain {
  append(record: AuditRecord): Promise<void>;
}

/** 키 순서에 흔들리지 않는 정규화 JSON. 배열 순서는 뜻이 있으므로 그대로 둔다 */
const sortValue = (v: unknown): unknown => {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortValue((v as Record<string, unknown>)[k])]));
  return v;
};
const canonical = (r: AuditRecord): string => JSON.stringify(sortValue({ recordType: r.recordType, recordId: r.recordId, payload: r.payload, at: new Date(r.nowMs).toISOString() }));

/** prevHash(16진)와 기록을 이어 붙인 SHA-256(16진) */
export function auditHash(prevHash: string, record: AuditRecord): string {
  return createHash('sha256').update(prevHash).update(canonical(record)).digest('hex');
}

/** 시험용 메모리 체인. append와 같은 규칙으로 해시를 이어 붙인다 */
export class MemoryAuditChain implements AuditChain {
  readonly entries: AuditEntry[] = [];
  async append(record: AuditRecord): Promise<void> {
    const prevHash = this.entries.at(-1)?.hash ?? '';
    this.entries.push({
      seq: this.entries.length + 1,
      recordType: record.recordType,
      recordId: record.recordId,
      hash: auditHash(prevHash, record),
      prevHash,
      createdAtMs: record.nowMs,
    });
  }
}

/**
 * DB 트랜잭션 안에서 체인에 한 기록을 더한다. audit_chain_head 행을 잠가 seq를 올리고, 직전 해시를 읽어 해시를 잇는다.
 * 호출자는 명령 쓰기와 같은 트랜잭션에 넣어야 한다.
 */
export async function appendAuditIn(tx: DbTransaction, record: AuditRecord): Promise<void> {
  const head = await tx.execute(sql`select last_seq, encode(last_hash, 'hex') as last_hash from audit_chain_head where id = 1 for update`);
  const row = head.rows[0] as { last_seq: number | string; last_hash: string } | undefined;
  if (!row) throw new Error('audit_chain_head 행이 없다(마이그레이션 0000)');
  const seq = Number(row.last_seq) + 1;
  const prevHash = row.last_hash;
  const hash = auditHash(prevHash, record);
  await tx.execute(sql`
    insert into audit_chain (seq, record_type, record_id, record_sha256, leaf_salt, created_at)
    values (${seq}::bigint, ${record.recordType}, ${record.recordId}::uuid, decode(${hash}, 'hex'), ${randomBytes(32)}, ${new Date(record.nowMs)}::timestamptz)`);
  await tx.execute(sql`update audit_chain_head set last_seq = ${seq}::bigint, last_hash = decode(${hash}, 'hex') where id = 1`);
}
