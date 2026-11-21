// 감사 체인 작업자·빈 행 경보·5분 앵커의 타이머(ADR-0341 결정 3·4·5). 모듈 수명주기로 켜고 끈다(main.ts를 고치지 않는다).
// 임대(ops_worker_lease, audit-chain-mac)를 쥔 파드만 mac을 채우고 앵커를 쓴다. 빈 행 경보는 파드마다 돈다(경보는 (사건 키, 종류) 하나로 모인다).
// 한 바퀴가 실패해도 다음 바퀴에 다시 한다(경고 로그에는 오류 이름만).
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { PlatformLogger } from '@peaket/platform';
import { AUDIT_CHAIN_LEASE, AUDIT_WORKER_DEFAULTS, type AuditChainWorker, type AuditMacLagMonitor, type WorkerLease } from './chain-worker.js';
import { MAC_ANCHOR_INTERVAL_MS, type AuditMacAnchorer } from './mac-anchor.js';

export interface AuditBackgroundOptions {
  readonly enabled: boolean;
  /** 임대를 쥐는 파드 이름(PEAKET_POD·HOSTNAME, 없으면 시작 때 만든 값) */
  readonly holder: string;
  readonly tickMs?: number;
  readonly renewMs?: number;
  readonly leaseMs?: number;
  readonly lagCheckMs?: number;
  readonly anchorMs?: number;
}

export interface AuditBackgroundDeps {
  readonly worker: AuditChainWorker;
  readonly lease: WorkerLease;
  readonly monitor: AuditMacLagMonitor;
  readonly anchorer: AuditMacAnchorer;
  readonly now: () => number;
  readonly logger?: PlatformLogger;
  readonly options: AuditBackgroundOptions;
  /** 시작 때 한 번 남길 경고(임시 키·메모리 앵커) */
  readonly warnings?: readonly string[];
}

export class AuditBackground implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #timers: NodeJS.Timeout[] = [];
  #leaseUntilMs = 0;
  readonly #busy = new Set<string>();

  constructor(private readonly deps: AuditBackgroundDeps) {}

  /** 임대를 쥐고 있는가(끝 시각 전) */
  get leader(): boolean {
    return this.#leaseUntilMs > this.deps.now();
  }

  onApplicationBootstrap(): void {
    for (const w of this.deps.warnings ?? []) this.deps.logger?.warn({ dep: 'audit-chain' }, w);
    const o = this.deps.options;
    if (!o.enabled || this.#timers.length > 0) return;
    const every = (name: string, ms: number, f: () => Promise<unknown>) => {
      const t = setInterval(() => void this.#once(name, f), ms);
      t.unref();
      this.#timers.push(t);
    };
    void this.#once('lease', () => this.renew());
    every('lease', o.renewMs ?? AUDIT_WORKER_DEFAULTS.renewMs, () => this.renew());
    every('worker', o.tickMs ?? AUDIT_WORKER_DEFAULTS.tickMs, () => this.tickWorker());
    every('lag', o.lagCheckMs ?? AUDIT_WORKER_DEFAULTS.lagCheckMs, () => this.deps.monitor.runOnce(this.deps.now()));
    every('anchor', o.anchorMs ?? MAC_ANCHOR_INTERVAL_MS, () => this.tickAnchor());
  }

  onModuleDestroy(): void {
    for (const t of this.#timers.splice(0)) clearInterval(t);
  }

  async #once(name: string, f: () => Promise<unknown>): Promise<void> {
    if (this.#busy.has(name)) return;
    this.#busy.add(name);
    try {
      await f();
    } catch (err) {
      this.deps.logger?.warn({ event: `audit-chain-${name}-failed`, err: err instanceof Error ? err.name : 'unknown' }, '감사 체인 작업 한 바퀴가 실패했다(다음 바퀴에 다시)');
    } finally {
      this.#busy.delete(name);
    }
  }

  /** 임대를 잡거나 늘린다 */
  async renew(): Promise<boolean> {
    const now = this.deps.now();
    const until = now + (this.deps.options.leaseMs ?? AUDIT_WORKER_DEFAULTS.leaseMs);
    const ok = await this.deps.lease.acquire(AUDIT_CHAIN_LEASE, this.deps.options.holder, now, until);
    this.#leaseUntilMs = ok ? until : 0;
    return ok;
  }

  async tickWorker(): Promise<void> {
    if (!this.leader) return;
    await this.deps.worker.runOnce(this.deps.now());
  }

  async tickAnchor(): Promise<void> {
    if (!this.leader) return;
    await this.deps.anchorer.runOnce(this.deps.now());
  }
}
