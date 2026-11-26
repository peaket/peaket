// CS 처리함 APPEAL 건을 소명 원본(예매 제한·부정 예매 사건)에 잇는다(F-06-4, transfer-refund §7.1).
// 대상·계정·기한은 ops가 원본으로 확인하고, 맞지 않으면 '대상 아님·기한 경과'로 닫고 팬에게 알린다.
import type { AuditRecord } from '../../audit/audit.js';
import type { CsCase, CsCaseStore } from '../domain/cs-case.js';
import type { AppealHolds, AppealNotifier, AppealSource, BookingRestrictionStore, FraudCaseDirectory, RestrictionEngineRef } from '../../restrictions/index.js';

export interface AppealCasesDeps {
  readonly store: CsCaseStore;
  readonly restrictions: Pick<import('../../restrictions/index.js').OpsRestrictionsWiring, 'store' | 'engineRef' | 'appeals' | 'fraudCases' | 'notifier' | 'holds'>;
  readonly clock: { now(): number };
}

const caseUpdateAudit = (prev: CsCase, next: CsCase, actor: { accountId: string; role: string }, nowMs: number): AuditRecord => ({
  recordType: 'CS_CASE_UPDATED',
  recordId: next.caseId,
  payload: { caseId: next.caseId, kind: next.kind, status: next.status, assignee: next.assignee, previousStatus: prev.status },
  nowMs,
});

export class AppealCases {
  constructor(private readonly d: AppealCasesDeps) {}

  /** 건을 연 직후. 같은 트랜잭션 밖이므로 실패해도 건은 남고, 다음 정비가 다시 볼 수 있게 결과를 남긴다. */
  async onOpened(c: CsCase, nowMs: number): Promise<void> {
    if (c.kind !== 'APPEAL') return;
    const src = await this.d.restrictions.appeals?.read(c.targetRef);
    if (!src) return;
    const ports = this.d.restrictions;
    if (src.kind === 'FRAUD_CASE') {
      await ports.holds?.set({ accountId: src.accountId, caseId: c.caseId, kind: 'APPEAL', state: 'OPEN', version: 1 });
      const investigator = await ports.fraudCases?.investigatorOf(src.targetId);
      if (investigator) await this.#assign(c, investigator.assigneeId, nowMs);
      return;
    }
    const row = await ports.store.find(src.targetId);
    if (!row || row.accountId !== src.accountId) return this.#invalid(c, nowMs, '대상 아님', 'NOT_TARGET');
    if (nowMs >= row.appealDueAtMs) return this.#invalid(c, nowMs, '기한 경과', 'EXPIRED');
    await ports.holds?.set({ accountId: src.accountId, caseId: c.caseId, kind: 'APPEAL', state: 'OPEN', version: 1 });
    if (row.reasonCode === 'FRAUD' && row.fraudCaseId) {
      const investigator = await ports.fraudCases?.investigatorOf(row.fraudCaseId);
      if (investigator) await this.#assign(c, investigator.assigneeId, nowMs);
    }
  }

  async #invalid(c: CsCase, nowMs: number, note: string, reason: string): Promise<void> {
    const src = await this.d.restrictions.appeals?.read(c.targetRef);
    if (!src) return;
    await this.d.restrictions.holds?.set({ accountId: src.accountId, caseId: c.caseId, kind: 'APPEAL', state: 'OPEN', version: 1 });
    await this.d.restrictions.holds?.set({ accountId: src.accountId, caseId: c.caseId, kind: 'APPEAL', state: 'CLOSED', version: 2 });
    await this.d.restrictions.appeals?.result(c.targetRef, { status: 'INVALID', reason, resultNote: note });
    await this.d.restrictions.notifier?.send({ appealId: c.targetRef, accountId: src.accountId, event: 'INVALID' });
    const cur = await this.d.store.find(c.caseId);
    if (!cur || cur.status === 'RESOLVED') return;
    const next: CsCase = { ...cur, status: 'RESOLVED', resultNote: note, resolvedAtMs: nowMs, updatedAtMs: nowMs, version: cur.version + 1 };
    await this.d.store.update(next, cur.version, caseUpdateAudit(cur, next, { accountId: 'system', role: 'system' }, nowMs));
  }

  async #assign(c: CsCase, assignee: string, nowMs: number): Promise<void> {
    const cur = await this.d.store.find(c.caseId);
    if (!cur || cur.status === 'RESOLVED' || cur.assignee === assignee) return;
    const next: CsCase = { ...cur, assignee, updatedAtMs: nowMs, version: cur.version + 1 };
    await this.d.store.update(next, cur.version, caseUpdateAudit(cur, next, { accountId: 'system', role: 'system' }, nowMs));
  }
}
