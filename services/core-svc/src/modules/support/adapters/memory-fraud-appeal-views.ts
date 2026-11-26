// F-04-15 support 화면용 사본 메모리 저장소(local·ci·시험).
import type { FraudAppealViewRecord } from '../domain/appeal.js';
import type { FraudAppealViews } from '../domain/ports.js';

export class MemoryFraudAppealViews implements FraudAppealViews {
  readonly rows = new Map<string, FraudAppealViewRecord>();
  private readonly keyOf = (v: { accountId: string; caseId: string }): string => `${v.accountId}:${v.caseId}`;

  async set(v: FraudAppealViewRecord): Promise<void> {
    const k = this.keyOf(v);
    const prev = this.rows.get(k);
    if (prev && prev.version >= v.version) return;
    this.rows.set(k, { ...v, updatedAtMs: v.updatedAtMs ?? Date.now() });
  }

  async list(accountId: string): Promise<readonly FraudAppealViewRecord[]> {
    return [...this.rows.values()].filter((v) => v.accountId === accountId).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }
}
