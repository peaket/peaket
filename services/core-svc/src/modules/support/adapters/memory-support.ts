// core-svc support 메모리 저장소·화면용 사본(단위 시험·개발).
import type { AppealRow, CaseRequestedRow, FraudAppealViewRow, RestrictionViewRow } from '../domain/appeal.js';
import type { AppealStore, FraudAppealViewStore, RestrictionViewStore } from '../domain/ports.js';

export class MemoryAppealStore implements AppealStore {
  readonly rows = new Map<string, AppealRow>();
  readonly outbox: CaseRequestedRow[] = [];
  #fail: 'saveAppeal' | 'saveResult' | null = null;

  failNext(op: 'saveAppeal' | 'saveResult'): void {
    this.#fail = op;
  }

  async saveAppeal(row: AppealRow, caseRequest: CaseRequestedRow): Promise<void> {
    if (this.#fail === 'saveAppeal') {
      this.#fail = null;
      throw new Error('appeal store down');
    }
    this.rows.set(row.appealId, { ...row });
    this.outbox.push({ ...caseRequest });
  }

  async find(appealId: string): Promise<AppealRow | undefined> {
    const r = this.rows.get(appealId);
    return r ? { ...r } : undefined;
  }

  async listByAccount(accountId: string, limit: number): Promise<AppealRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => b.submittedAtMs - a.submittedAtMs)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async saveResult(appealId: string, patch: { status: AppealRow['status']; result?: string | null; resultNote?: string | null; decidedAtMs: number; caseId?: string | null }): Promise<void> {
    if (this.#fail === 'saveResult') {
      this.#fail = null;
      throw new Error('appeal result store down');
    }
    const cur = this.rows.get(appealId);
    if (!cur) throw new Error('appeal not found');
    this.rows.set(appealId, {
      ...cur,
      status: patch.status,
      result: (patch.result as AppealRow['result']) ?? cur.result,
      resultNote: patch.resultNote ?? cur.resultNote,
      decidedAtMs: patch.decidedAtMs,
      caseId: patch.caseId ?? cur.caseId,
      dispatchState: 'SENT',
      nextDispatchAtMs: null,
    });
  }

  async saveDispatch(appealId: string, patch: { state: AppealRow['dispatchState']; attempts: number; nextAtMs: number | null; dispatchedAtMs: number | null }): Promise<void> {
    const cur = this.rows.get(appealId);
    if (!cur) return;
    this.rows.set(appealId, { ...cur, dispatchState: patch.state, dispatchAttempts: patch.attempts, nextDispatchAtMs: patch.nextAtMs, dispatchedAtMs: patch.dispatchedAtMs });
  }

  async dueDispatch(nowMs: number, limit: number): Promise<AppealRow[]> {
    return [...this.rows.values()]
      .filter((r) => (r.dispatchState === 'PENDING' || r.dispatchState === 'RETRY') && (r.nextDispatchAtMs === null || r.nextDispatchAtMs <= nowMs))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async outboxRows(): Promise<CaseRequestedRow[]> {
    return this.outbox.map((r) => ({ ...r }));
  }
}

export class MemoryRestrictionViewStore implements RestrictionViewStore {
  readonly rows = new Map<string, RestrictionViewRow>();
  readonly #key = (accountId: string, restrictionId: string) => `${accountId}:${restrictionId}`;

  async apply(i: RestrictionViewRow): Promise<{ changed: boolean }> {
    const key = this.#key(i.accountId, i.restrictionId);
    const cur = this.rows.get(key);
    if (cur && cur.version >= i.version) return { changed: false };
    this.rows.set(key, { ...i });
    return { changed: true };
  }

  async get(accountId: string, restrictionId: string): Promise<RestrictionViewRow | undefined> {
    const r = this.rows.get(this.#key(accountId, restrictionId));
    return r ? { ...r } : undefined;
  }

  async list(accountId: string): Promise<RestrictionViewRow[]> {
    return [...this.rows.values()].filter((r) => r.accountId === accountId).map((r) => ({ ...r }));
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }
}

const sanitizeFraud = (i: FraudAppealViewRow): FraudAppealViewRow => ({
  ...(i.party === 'HOLDER'
    ? {
        ...i,
        reasonCategories: [],
        lockedTicketIds: [],
        priorityPurchases: [],
        lockActive: false,
        lockExpiresAtMs: null,
        objectionDueAtMs: null,
        objectionStatus: 'NONE' as const,
        objectionNote: null,
        restrictedUntilMs: null,
      }
    : i),
  actionResult: i.actionResult ?? null,
});

export class MemoryFraudAppealViewStore implements FraudAppealViewStore {
  readonly rows = new Map<string, FraudAppealViewRow>();
  readonly #key = (accountId: string, caseId: string) => `${accountId}:${caseId}`;

  async apply(i: FraudAppealViewRow): Promise<{ changed: boolean }> {
    const key = this.#key(i.accountId, i.caseId);
    const cur = this.rows.get(key);
    if (cur && cur.version >= i.version) return { changed: false };
    this.rows.set(key, sanitizeFraud(i));
    return { changed: true };
  }

  async get(accountId: string, caseId: string): Promise<FraudAppealViewRow | undefined> {
    const r = this.rows.get(this.#key(accountId, caseId));
    return r ? sanitizeFraud(r) : undefined;
  }

  async list(accountId: string): Promise<FraudAppealViewRow[]> {
    return [...this.rows.values()].filter((r) => r.accountId === accountId).map((r) => sanitizeFraud(r));
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }
}
