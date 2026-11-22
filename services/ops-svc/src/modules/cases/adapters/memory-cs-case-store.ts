// 시험용 CS 처리함 건 저장소. DB 저장소(drizzle-cs-case-store.ts)와 같은 규칙이다:
// 같은 kind·targetRef의 열린 건은 하나, eventKey는 한 번(cs_case_request), 판 조건부 갱신과 감사는 함께 쓴다.
import type { AuditChain, AuditRecord } from '../../audit/index.js';
import { compareByDue, newCsCase, nextDueOf, type CsCase, type CsCaseKind, type CsCaseListQuery, type CsCaseOpenInput, type CsCaseReceiveResult, type CsCaseStore } from '../domain/cs-case.js';

export class MemoryCsCaseStore implements CsCaseStore {
  readonly cases = new Map<string, CsCase>();
  /** cs_case_request: eventKey → caseId */
  readonly requests = new Map<string, { caseId: string; kind: CsCaseKind; receivedAtMs: number }>();

  constructor(private readonly audit?: AuditChain) {}

  #openOf(kind: CsCaseKind, targetRef: string): CsCase | undefined {
    for (const c of this.cases.values()) if (c.kind === kind && c.targetRef === targetRef && c.status !== 'RESOLVED') return c;
    return undefined;
  }

  async open(input: CsCaseOpenInput): Promise<CsCase> {
    const existing = this.#openOf(input.kind, input.targetRef);
    if (existing) return existing;
    const c = newCsCase(input);
    this.cases.set(c.caseId, c);
    return c;
  }

  async receive(input: CsCaseOpenInput & { readonly eventKey: string }): Promise<{ result: CsCaseReceiveResult; case: CsCase }> {
    const seen = this.requests.get(input.eventKey);
    if (seen) {
      const c = this.cases.get(seen.caseId);
      if (c) return { result: 'duplicate', case: c };
    }
    const existing = this.#openOf(input.kind, input.targetRef);
    const c = existing ?? newCsCase(input);
    if (!existing) this.cases.set(c.caseId, c);
    this.requests.set(input.eventKey, { caseId: c.caseId, kind: input.kind, receivedAtMs: input.nowMs });
    return { result: existing ? 'existing' : 'opened', case: c };
  }

  async find(caseId: string): Promise<CsCase | undefined> {
    return this.cases.get(caseId);
  }

  async findOpen(kind: CsCaseKind, targetRef: string): Promise<CsCase | undefined> {
    return this.#openOf(kind, targetRef);
  }

  async list(q: CsCaseListQuery): Promise<CsCase[]> {
    const rows = [...this.cases.values()]
      .filter((c) => q.statuses.includes(c.status))
      .filter((c) => !q.kinds || q.kinds.includes(c.kind))
      .filter((c) => !q.excludeKinds || !q.excludeKinds.includes(c.kind))
      .filter((c) => {
        if (q.dueAtOrBeforeMs === undefined) return true;
        const due = nextDueOf(c);
        return due !== null && due <= q.dueAtOrBeforeMs;
      })
      .map((c) => ({ c, key: { nextDueMs: nextDueOf(c), caseId: c.caseId } }))
      .filter((r) => !q.after || compareByDue(r.key, q.after) > 0)
      .sort((a, b) => compareByDue(a.key, b.key));
    return rows.slice(0, q.limit).map((r) => r.c);
  }

  async update(next: CsCase, expectedVersion: number, audit?: AuditRecord): Promise<boolean> {
    const cur = this.cases.get(next.caseId);
    if (!cur || cur.version !== expectedVersion) return false;
    // 감사가 실패하면 상태도 바꾸지 않는다(DB 저장소의 한 트랜잭션과 같다)
    if (audit) await this.audit?.append(audit);
    this.cases.set(next.caseId, next);
    return true;
  }

  async markAlerted(caseId: string, marks: { readonly dueSoonForMs?: number; readonly overdueForMs?: number }): Promise<void> {
    const cur = this.cases.get(caseId);
    if (!cur) return;
    this.cases.set(caseId, {
      ...cur,
      ...(marks.dueSoonForMs !== undefined ? { dueSoonAlertedForMs: marks.dueSoonForMs } : {}),
      ...(marks.overdueForMs !== undefined ? { overdueAlertedForMs: marks.overdueForMs } : {}),
    });
  }

  async resolvedWithAlerts(limit: number): Promise<CsCase[]> {
    return [...this.cases.values()].filter((c) => c.status === 'RESOLVED' && (c.dueSoonAlertedForMs !== null || c.overdueAlertedForMs !== null)).slice(0, limit);
  }

  async clearAlerted(caseId: string): Promise<void> {
    const cur = this.cases.get(caseId);
    if (cur) this.cases.set(caseId, { ...cur, dueSoonAlertedForMs: null, overdueAlertedForMs: null });
  }
}
