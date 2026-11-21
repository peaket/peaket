// 감사 체인 작업자·빈 행 경보(ADR-0341 결정 3·4, ADR-0102). 기록 트랜잭션은 mac을 비운 채 커밋하고, 작업자 하나가 커밋 뒤 seq 차례로 채운다.
// 작업자는 ops DB 임대 행(ops_worker_lease, 이름 audit-chain-mac, 15초 [가정], 5초 [가정]마다 늘림)으로 고른다.
// 1초 [가정]마다 mac_seq 뒤 행을 seq 차례로 100개 [가정]까지 읽어 트랜잭션 밖에서 mac을 계산하고, 짧은 트랜잭션에서 mac_seq = 읽은 값 조건으로 쓴다(맞지 않으면 그 바퀴를 버린다).
// 다음 seq가 없는데 그 뒤 행이 있으면(빈틈) 멈추고 SEV2 audit-chain-mismatch를 연다.
// 빈 행 경보: 10초 [가정]마다 mac이 빈 가장 오래된 행의 나이를 보고, 60,000ms를 넘으면(정각은 아직 아니다) SEV2 audit-mac-lag, 빈 행이 없어지면 푼다.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Counter, DATABASE, Gauge, type Database, type Registry } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { OpsAlertStore } from '../alerts/index.js';
import type { MemoryAuditChain } from './audit.js';
import { auditMacInput, type AuditMacKey } from './mac.js';
import type { MacAnchor, MacAnchorLedger } from './mac-anchor.js';

export const AUDIT_CHAIN_LEASE = 'audit-chain-mac';
/** ADR-0341 결정 3·4의 시간 값 [가정] */
export const AUDIT_WORKER_DEFAULTS = Object.freeze({
  tickMs: 1_000,
  leaseMs: 15_000,
  renewMs: 5_000,
  batch: 100,
  lagCheckMs: 10_000,
  /** 가장 오래된 빈 행이 이것을 넘으면 SEV2(같으면 아직 아니다) */
  lagAlertMs: 60_000,
});
/** ops 경보의 사건 키(감사 체인 하나) */
export const AUDIT_ALERT_EVENT_KEY = 'audit-chain';
export const AUDIT_MAC_LAG_ALERT = 'audit-mac-lag';
export const AUDIT_CHAIN_MISMATCH_ALERT = 'audit-chain-mismatch';

export interface AuditMacRow {
  readonly seq: number;
  readonly recordSha256: Buffer;
}

/** 작업자가 쓰는 체인 면 */
export interface AuditMacStore {
  macHead(): Promise<{ readonly macSeq: number; readonly lastMac: Buffer }>;
  /** seq > macSeq인 행을 seq 차례로 limit개까지 */
  pendingAfter(macSeq: number, limit: number): Promise<readonly AuditMacRow[]>;
  /** mac_seq = expectedMacSeq일 때만 빈 mac을 채우고 머리를 옮긴다. 맞지 않으면 아무것도 쓰지 않고 거짓 */
  fill(expectedMacSeq: number, fills: readonly { readonly seq: number; readonly mac: Buffer }[]): Promise<boolean>;
  /** mac이 빈 가장 오래된 행(없으면 undefined) */
  oldestPending(): Promise<{ readonly seq: number; readonly createdAtMs: number } | undefined>;
}

/** 작업 하나를 맡을 파드를 고르는 임대(ops_worker_lease) */
export interface WorkerLease {
  /** 비었거나 끝났거나 내가 쥔 임대면 holder로 leaseUntil까지 잡는다. 잡았으면 참 */
  acquire(name: string, holder: string, nowMs: number, leaseUntilMs: number): Promise<boolean>;
}

/** 감사 체인 지표(ops_audit_mac_lag_seconds, ops_audit_kms_failover_total{op}). 등록은 시작 조립이 서비스 레지스트리에 한다(register) */
export class AuditSignals {
  readonly macLagSeconds = new Gauge({ name: 'ops_audit_mac_lag_seconds', help: 'mac이 빈 가장 오래된 감사 체인 행의 나이(초, 없으면 0, ADR-0341 결정 4)', registers: [] });
  readonly kmsFailoverTotal = new Counter({ name: 'ops_audit_kms_failover_total', help: '감사 체인 키 호출을 복제 키 리전으로 넘긴 수(ADR-0341 결정 2)', labelNames: ['op'] as const, registers: [] });

  failover(op: string): void {
    this.kmsFailoverTotal.inc({ op });
  }

  register(registry: Registry): void {
    registry.registerMetric(this.macLagSeconds);
    registry.registerMetric(this.kmsFailoverTotal);
  }
}

export interface AuditChainWorkerDeps {
  readonly store: AuditMacStore;
  readonly key: AuditMacKey;
  readonly alerts?: OpsAlertStore;
  readonly batch?: number;
}

export interface AuditWorkerRound {
  readonly filled: number;
  /** 빈틈이 있었던 seq */
  readonly gapSeq?: number;
  /** mac을 계산하지 못한 까닭(오류 이름) */
  readonly error?: string;
  /** 조건부 쓰기가 맞지 않아 버린 바퀴 */
  readonly discarded?: boolean;
}

/** 체인 작업자 한 바퀴. 임대를 쥔 파드만 부른다 */
export class AuditChainWorker {
  readonly #batch: number;

  constructor(private readonly deps: AuditChainWorkerDeps) {
    this.#batch = deps.batch ?? AUDIT_WORKER_DEFAULTS.batch;
  }

  async runOnce(nowMs: number): Promise<AuditWorkerRound> {
    const { store, key } = this.deps;
    const head = await store.macHead();
    const rows = await store.pendingAfter(head.macSeq, this.#batch);
    if (rows.length === 0) return { filled: 0 };
    const fills: { seq: number; mac: Buffer }[] = [];
    let prev: Buffer = head.macSeq === 0 ? Buffer.alloc(0) : head.lastMac;
    let expected = head.macSeq + 1;
    let gapSeq: number | undefined;
    let error: string | undefined;
    for (const row of rows) {
      if (row.seq !== expected) {
        gapSeq = expected;
        break;
      }
      try {
        const mac = Buffer.from(await key.mac(auditMacInput(row.seq, prev, row.recordSha256)));
        fills.push({ seq: row.seq, mac });
        prev = mac;
        expected += 1;
      } catch (e) {
        error = e instanceof Error ? e.name : 'mac-failed';
        break;
      }
    }
    if (gapSeq !== undefined) await this.#gap(gapSeq, nowMs);
    if (fills.length === 0) return { filled: 0, ...(gapSeq !== undefined ? { gapSeq } : {}), ...(error !== undefined ? { error } : {}) };
    const ok = await store.fill(head.macSeq, fills);
    return { filled: ok ? fills.length : 0, ...(ok ? {} : { discarded: true }), ...(gapSeq !== undefined ? { gapSeq } : {}), ...(error !== undefined ? { error } : {}) };
  }

  async #gap(seq: number, nowMs: number): Promise<void> {
    await this.deps.alerts?.open({
      alertId: randomUUID(),
      eventKey: AUDIT_ALERT_EVENT_KEY,
      kind: AUDIT_CHAIN_MISMATCH_ALERT,
      severity: 'SEV2',
      source: 'ops-svc',
      reason: '감사 체인 seq에 빈틈이 있어 mac 채우기를 멈췄다',
      detail: { firstBadSeq: seq, reason: 'gap' },
      nowMs,
    });
  }
}

/** 빈 행 경보 한 바퀴(파드마다 돌아도 경보는 (사건 키, 종류) 하나로 모인다) */
export class AuditMacLagMonitor {
  constructor(
    private readonly store: Pick<AuditMacStore, 'oldestPending'>,
    private readonly alerts?: OpsAlertStore,
    private readonly signals?: AuditSignals,
    private readonly alertAfterMs: number = AUDIT_WORKER_DEFAULTS.lagAlertMs,
  ) {}

  async runOnce(nowMs: number): Promise<{ readonly lagMs: number; readonly alerted: boolean }> {
    const oldest = await this.store.oldestPending();
    const lagMs = oldest ? Math.max(0, nowMs - oldest.createdAtMs) : 0;
    this.signals?.macLagSeconds.set(lagMs / 1000);
    if (oldest && lagMs > this.alertAfterMs) {
      await this.alerts?.open({
        alertId: randomUUID(),
        eventKey: AUDIT_ALERT_EVENT_KEY,
        kind: AUDIT_MAC_LAG_ALERT,
        severity: 'SEV2',
        source: 'ops-svc',
        reason: '감사 체인 mac이 빈 행이 60초를 넘었다(변조 탐지가 밀림)',
        detail: { oldestSeq: oldest.seq, lagMs },
        nowMs,
      });
      return { lagMs, alerted: true };
    }
    if (!oldest) await this.alerts?.resolve({ eventKey: AUDIT_ALERT_EVENT_KEY, kind: AUDIT_MAC_LAG_ALERT, reason: 'caught-up', nowMs });
    return { lagMs, alerted: false };
  }
}

/** PostgreSQL 감사 체인의 mac 면·임대·앵커 행 */
@Injectable()
export class DrizzleAuditMacStore implements AuditMacStore, WorkerLease, MacAnchorLedger {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async macHead(): Promise<{ macSeq: number; lastMac: Buffer }> {
    const [row] = (await this.database.db.execute(sql`select mac_seq, last_mac from audit_chain_head where id = 1`)).rows as { mac_seq: number | string; last_mac: Buffer }[];
    if (!row) throw new Error('audit_chain_head 행이 없다(마이그레이션 0000)');
    return { macSeq: Number(row.mac_seq), lastMac: Buffer.from(row.last_mac) };
  }

  async pendingAfter(macSeq: number, limit: number): Promise<readonly AuditMacRow[]> {
    const rows = (await this.database.db.execute(sql`select seq, record_sha256 from audit_chain where seq > ${macSeq}::bigint order by seq limit ${limit}`)).rows as { seq: number | string; record_sha256: Buffer }[];
    return rows.map((r) => ({ seq: Number(r.seq), recordSha256: Buffer.from(r.record_sha256) }));
  }

  async fill(expectedMacSeq: number, fills: readonly { seq: number; mac: Buffer }[]): Promise<boolean> {
    const last = fills.at(-1);
    if (!last) return false;
    return this.database.transaction(async (tx) => {
      const moved = await tx.execute(sql`
        update audit_chain_head set mac_seq = ${last.seq}::bigint, last_mac = ${last.mac} where id = 1 and mac_seq = ${expectedMacSeq}::bigint returning 1 as moved`);
      if (moved.rows.length !== 1) return false;
      for (const f of fills) await tx.execute(sql`update audit_chain set mac = ${f.mac} where seq = ${f.seq}::bigint and mac is null`);
      return true;
    });
  }

  async oldestPending(): Promise<{ seq: number; createdAtMs: number } | undefined> {
    const [row] = (await this.database.db.execute(sql`select seq, created_at from audit_chain where mac is null order by seq limit 1`)).rows as { seq: number | string; created_at: Date | string }[];
    return row ? { seq: Number(row.seq), createdAtMs: new Date(row.created_at).getTime() } : undefined;
  }

  async acquire(name: string, holder: string, nowMs: number, leaseUntilMs: number): Promise<boolean> {
    const r = await this.database.db.execute(sql`
      insert into ops_worker_lease (name, holder, lease_until) values (${name}, ${holder}, ${new Date(leaseUntilMs)}::timestamptz)
      on conflict (name) do update set holder = excluded.holder, lease_until = excluded.lease_until
        where ops_worker_lease.holder = excluded.holder or ops_worker_lease.lease_until < ${new Date(nowMs)}::timestamptz
      returning holder`);
    return r.rows.length === 1;
  }

  async lastAnchorSeq(): Promise<number> {
    const [row] = (await this.database.db.execute(sql`select coalesce(max(seq), 0) as seq from audit_mac_anchor`)).rows as { seq: number | string }[];
    return Number(row?.seq ?? 0);
  }

  async recordAnchor(a: { seq: number; mac: Buffer; objectKey: string; keyId: string; nowMs: number }): Promise<void> {
    await this.database.db.execute(sql`
      insert into audit_mac_anchor (seq, mac, object_key, key_id, anchored_at)
      values (${a.seq}::bigint, ${a.mac}, ${a.objectKey}, ${a.keyId}, ${new Date(a.nowMs)}::timestamptz)
      on conflict (seq) do nothing`);
  }

  async anchorsBetween(fromSeq: number, toSeq: number): Promise<readonly MacAnchor[]> {
    const rows = (
      await this.database.db.execute(sql`
        select seq, encode(mac, 'hex') as mac, key_id, anchored_at from audit_mac_anchor where seq between ${fromSeq}::bigint and ${toSeq}::bigint order by seq`)
    ).rows as { seq: number | string; mac: string; key_id: string; anchored_at: Date | string }[];
    return rows.map((r) => ({ v: 1, seq: Number(r.seq), mac: r.mac, keyId: r.key_id, at: new Date(r.anchored_at).toISOString() }));
  }
}

/** 시험용 메모리 mac 면(MemoryAuditChain 위). 임대는 늘 잡힌다 */
export class MemoryAuditMacStore implements AuditMacStore, WorkerLease, MacAnchorLedger {
  readonly macs = new Map<number, Buffer>();
  readonly anchors = new Map<number, { seq: number; mac: Buffer; objectKey: string; keyId: string; anchoredAtMs: number }>();
  macSeq = 0;
  lastMac: Buffer = Buffer.alloc(0);
  readonly #leases = new Map<string, { holder: string; untilMs: number }>();

  constructor(readonly chain: MemoryAuditChain) {}

  async macHead(): Promise<{ macSeq: number; lastMac: Buffer }> {
    return { macSeq: this.macSeq, lastMac: this.lastMac };
  }

  async pendingAfter(macSeq: number, limit: number): Promise<readonly AuditMacRow[]> {
    return this.chain.entries
      .filter((e) => e.seq > macSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((e) => ({ seq: e.seq, recordSha256: Buffer.from(e.hash, 'hex') }));
  }

  async fill(expectedMacSeq: number, fills: readonly { seq: number; mac: Buffer }[]): Promise<boolean> {
    const last = fills.at(-1);
    if (!last || this.macSeq !== expectedMacSeq) return false;
    for (const f of fills) if (!this.macs.has(f.seq)) this.macs.set(f.seq, f.mac);
    this.macSeq = last.seq;
    this.lastMac = last.mac;
    return true;
  }

  async oldestPending(): Promise<{ seq: number; createdAtMs: number } | undefined> {
    const e = this.chain.entries.filter((x) => !this.macs.has(x.seq)).sort((a, b) => a.seq - b.seq)[0];
    return e ? { seq: e.seq, createdAtMs: e.createdAtMs } : undefined;
  }

  async acquire(name: string, holder: string, nowMs: number, leaseUntilMs: number): Promise<boolean> {
    const cur = this.#leases.get(name);
    if (cur && cur.holder !== holder && cur.untilMs >= nowMs) return false;
    this.#leases.set(name, { holder, untilMs: leaseUntilMs });
    return true;
  }

  async lastAnchorSeq(): Promise<number> {
    return Math.max(0, ...this.anchors.keys());
  }

  async recordAnchor(a: { seq: number; mac: Buffer; objectKey: string; keyId: string; nowMs: number }): Promise<void> {
    if (!this.anchors.has(a.seq)) this.anchors.set(a.seq, { seq: a.seq, mac: a.mac, objectKey: a.objectKey, keyId: a.keyId, anchoredAtMs: a.nowMs });
  }

  async anchorsBetween(fromSeq: number, toSeq: number): Promise<readonly MacAnchor[]> {
    return [...this.anchors.values()]
      .filter((a) => a.seq >= fromSeq && a.seq <= toSeq)
      .sort((a, b) => a.seq - b.seq)
      .map((a) => ({ v: 1, seq: a.seq, mac: a.mac.toString('hex'), keyId: a.keyId, at: new Date(a.anchoredAtMs).toISOString() }));
  }
}
