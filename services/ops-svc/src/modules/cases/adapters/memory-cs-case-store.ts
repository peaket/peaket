// 시험용 CS 처리함 건 저장소. DB 저장소(drizzle-cs-case-store.ts)와 같은 규칙이다:
// 같은 kind·targetRef의 열린 건은 하나, eventKey는 한 번(cs_case_request), 판 조건부 갱신과 감사는 함께 쓴다.
// 추가 검증 이의(F-06-7): 건을 처음 열 때 이의 행과 보낼 호출 둘을 같이 넣고, 같은 이의 ID의 다른 eventKey는 그 건으로 적는다(duplicate).
// 결정은 판 확인·건 해결·이의 결과·보낼 호출·멱등 기록을 한꺼번에 바꾸고, 감사가 실패하면 모두 되돌린다(DB 저장소의 한 트랜잭션과 같다).
import { idempotencyKeyReused, idempotencyRequestInProgress } from '@peaket/platform';
import type { AuditChain, AuditRecord } from '../../audit/index.js';
import { compareByDue, newCsCase, nextDueOf, type CsCase, type CsCaseKind, type CsCaseListQuery, type CsCaseOpenInput, type CsCaseReceiveResult, type CsCaseStore } from '../domain/cs-case.js';
import {
  DISPATCH_CALLS,
  VERIFICATION_APPEAL_KIND,
  newDispatchRow,
  newVerificationCase,
  type AppealContent,
  type AppealDecisionResult,
  type AppealDecisionWrite,
  type BlockListChange,
  type CsAppealStore,
  type CsCaseDispatchRow,
  type DispatchCall,
  type VerificationCase,
  type VerificationCaseStatus,
} from '../domain/verification-appeal.js';

const callOrder = (c: DispatchCall): number => DISPATCH_CALLS.indexOf(c);
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const idemKeyOf = (i: AppealDecisionWrite['idem']): string => `${i.accountRef}|${i.operation}|${i.key}`;

export class MemoryCsCaseStore implements CsCaseStore, CsAppealStore {
  readonly cases = new Map<string, CsCase>();
  /** cs_case_request: eventKey → caseId */
  readonly requests = new Map<string, { caseId: string; kind: CsCaseKind; receivedAtMs: number }>();
  /** verification_case: 건 ID → 이의 행 */
  readonly appeals = new Map<string, VerificationCase>();
  /** cs_case_dispatch: 건 ID → 호출 → 행 */
  readonly dispatch = new Map<string, Map<DispatchCall, CsCaseDispatchRow>>();
  /** 결정 멱등 기록(caseId null은 처리 중) */
  readonly #decisions = new Map<string, { hash: string; requestHash: Uint8Array; caseId: string | null }>();

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
    // 이의 ID마다 건 하나: 해결된 건이어도 그 건을 돌려주고 eventKey를 그 건으로 적는다(보낼 호출은 더하지 않는다)
    if (input.kind === VERIFICATION_APPEAL_KIND) {
      const known = [...this.appeals.values()].find((a) => a.appealId === input.targetRef);
      const c = known ? this.cases.get(known.caseId) : undefined;
      if (c) {
        this.requests.set(input.eventKey, { caseId: c.caseId, kind: input.kind, receivedAtMs: input.nowMs });
        return { result: 'duplicate', case: c };
      }
    }
    const existing = this.#openOf(input.kind, input.targetRef);
    const c = existing ?? newCsCase(input);
    if (!existing) this.cases.set(c.caseId, c);
    if (input.kind === VERIFICATION_APPEAL_KIND && !this.appeals.has(c.caseId)) {
      this.appeals.set(c.caseId, newVerificationCase(input.targetRef, c.caseId, input.nowMs));
      this.dispatch.set(
        c.caseId,
        new Map<DispatchCall, CsCaseDispatchRow>([
          ['APPEAL_COPY', newDispatchRow(c.caseId, 'APPEAL_COPY', c.version, input.nowMs)],
          ['ACCOUNT_HOLD_OPEN', newDispatchRow(c.caseId, 'ACCOUNT_HOLD_OPEN', c.version, input.nowMs)],
        ]),
      );
    }
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
      .filter((c) => !q.excludeCategories || !(c.kind === q.excludeCategories.kind && q.excludeCategories.categories.includes(c.category)))
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

  // ---- 추가 검증 이의(F-06-7) ----

  async appealOf(caseId: string): Promise<VerificationCase | undefined> {
    return this.appeals.get(caseId);
  }

  async dispatchRowsOf(caseId: string): Promise<CsCaseDispatchRow[]> {
    return [...(this.dispatch.get(caseId)?.values() ?? [])].sort((a, b) => callOrder(a.call) - callOrder(b.call));
  }

  async copyAppealContent(caseId: string, c: AppealContent, nowMs: number): Promise<void> {
    const a = this.appeals.get(caseId);
    if (!a || a.eventId !== null) return;
    this.appeals.set(caseId, {
      ...a,
      eventId: c.eventId,
      accountId: c.accountId,
      pid: c.pid,
      text: c.text,
      reasonCategory: c.reasonCategory,
      receivedAtMs: c.receivedAtMs,
      status: a.status === 'SKIPPED' ? 'PENDING' : a.status,
      updatedAtMs: nowMs,
    });
  }

  async updateAppeal(caseId: string, patch: { readonly status?: VerificationCaseStatus; readonly blockListChange?: BlockListChange }, nowMs: number): Promise<void> {
    const a = this.appeals.get(caseId);
    if (!a) return;
    this.appeals.set(caseId, {
      ...a,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.blockListChange !== undefined ? { blockListChange: patch.blockListChange } : {}),
      updatedAtMs: nowMs,
    });
  }

  async findDecisionRecord(idem: AppealDecisionWrite['idem']): Promise<{ readonly requestHash: Uint8Array; readonly caseId: string | null } | undefined> {
    const r = this.#decisions.get(idemKeyOf(idem));
    return r ? { requestHash: r.requestHash, caseId: r.caseId } : undefined;
  }

  async decide(w: AppealDecisionWrite): Promise<AppealDecisionResult> {
    const k = idemKeyOf(w.idem);
    const hash = hexOf(w.idem.requestHash);
    const rec = this.#decisions.get(k);
    if (rec) {
      if (rec.hash !== hash) throw idempotencyKeyReused();
      if (rec.caseId === null) throw idempotencyRequestInProgress();
      return { kind: 'replay', caseId: rec.caseId };
    }
    const caseId = w.next.caseId;
    const cur = this.cases.get(caseId);
    if (!cur || cur.version !== w.expectedVersion) return { kind: 'stale' };
    // 판 확인과 쓰기를 기다림 없이 한꺼번에 한다(동시 결정 둘 가운데 하나만 이긴다). 감사가 실패하면 되돌린다.
    // 내용이 없는 이의(SKIPPED)는 그 표시를 남겨 결정 직후 보내기가 라벨·병합 막기를 APPEAL_CONTENT_MISSING으로 끝내게 한다(그 뒤 상태는 보낼 호출로 다시 센다)
    const prevAppeal = this.appeals.get(caseId);
    const prevRows = this.dispatch.get(caseId);
    this.#decisions.set(k, { hash, requestHash: w.idem.requestHash, caseId: null });
    this.cases.set(caseId, w.next);
    if (prevAppeal) {
      this.appeals.set(caseId, { ...prevAppeal, appealResult: w.outcome, decidedBy: w.decidedBy, decidedAtMs: w.decidedAtMs, status: prevAppeal.status === 'SKIPPED' ? 'SKIPPED' : 'RUNNING', updatedAtMs: w.decidedAtMs });
    }
    const rows = new Map(prevRows ?? []);
    for (const call of w.calls) if (!rows.has(call)) rows.set(call, newDispatchRow(caseId, call, w.next.version, w.decidedAtMs));
    this.dispatch.set(caseId, rows);
    try {
      await this.audit?.append(w.audit);
    } catch (err) {
      this.cases.set(caseId, cur);
      if (prevAppeal) this.appeals.set(caseId, prevAppeal);
      if (prevRows) this.dispatch.set(caseId, prevRows);
      else this.dispatch.delete(caseId);
      this.#decisions.delete(k);
      throw err;
    }
    this.#decisions.set(k, { hash, requestHash: w.idem.requestHash, caseId });
    return { kind: 'decided' };
  }

  #claimable(r: CsCaseDispatchRow, nowMs: number): boolean {
    return r.state !== 'APPLIED' && r.nextAttemptAtMs !== null && (r.claimedUntilMs === null || r.claimedUntilMs < nowMs);
  }

  #claim(rows: readonly CsCaseDispatchRow[], nowMs: number, claimMs: number): CsCaseDispatchRow[] {
    return rows.map((r) => {
      const claimed = { ...r, claimedUntilMs: nowMs + claimMs };
      this.dispatch.get(r.caseId)?.set(r.call, claimed);
      return claimed;
    });
  }

  async claimDue(nowMs: number, limit: number, claimMs: number): Promise<CsCaseDispatchRow[]> {
    const due = [...this.dispatch.values()]
      .flatMap((m) => [...m.values()])
      .filter((r) => this.#claimable(r, nowMs) && (r.nextAttemptAtMs ?? Number.POSITIVE_INFINITY) <= nowMs)
      .sort((a, b) => (a.nextAttemptAtMs ?? 0) - (b.nextAttemptAtMs ?? 0) || (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0))
      .slice(0, limit);
    return this.#claim(due, nowMs, claimMs);
  }

  async claimCase(caseId: string, nowMs: number, claimMs: number): Promise<CsCaseDispatchRow[]> {
    const rows = [...(this.dispatch.get(caseId)?.values() ?? [])].filter((r) => this.#claimable(r, nowMs));
    return this.#claim(rows, nowMs, claimMs);
  }

  async saveDispatch(row: CsCaseDispatchRow): Promise<void> {
    const m = this.dispatch.get(row.caseId);
    if (m) m.set(row.call, { ...row, claimedUntilMs: null });
  }
}
