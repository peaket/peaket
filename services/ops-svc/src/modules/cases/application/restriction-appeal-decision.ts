// 예매 제한 소명 판단(해제·유지) (F-06-4, transfer-refund §7.1, openapi createOpsCaseRestrictionAppealDecision).
// ACCEPT는 제한 엔진의 해제(두 집행 사본)와 core 결과를 적은 뒤에 건을 닫는다.
// 겹친 결정은 건 판 CAS를 먼저 잡아 한쪽만 부수 효과를 내게 한다(IR-06). FRAUD 사유는 이 경로로 풀 수 없다.
import { ProblemError } from '@peaket/platform';
import type { AuditRecord } from '../../audit/audit.js';
import type { CsActor, CsCase, CsCaseStore } from '../domain/cs-case.js';
import { CsCases } from './cs-cases.js';
import type { AppealHolds, AppealNotifier, AppealSource, RestrictionEngineRef } from '../../restrictions/index.js';

const problem = (type: string, status: number, title: string) => new ProblemError({ type, status, title });
const notFound = () => problem('not-found', 404, '찾을 수 없습니다');
const precondition = (title: string) => problem('precondition-failed', 412, title);

export interface RestrictionAppealDecisionDeps {
  readonly cases: CsCases;
  readonly store: CsCaseStore;
  readonly clock: { now(): number };
  readonly restrictions: { readonly engineRef: RestrictionEngineRef; readonly appeals?: AppealSource; readonly notifier?: AppealNotifier; readonly holds?: AppealHolds };
}

const parseIfMatch = (raw: string | undefined): number | null => {
  if (typeof raw !== 'string') return null;
  const m = /^(?:W\/)?"(\d{1,15})"$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const caseUpdateAudit = (prev: CsCase, next: CsCase, actor: CsActor, nowMs: number, decision = 'RESTRICTION_APPEAL'): AuditRecord => ({
  recordType: 'CS_CASE_UPDATED',
  recordId: next.caseId,
  payload: { caseId: next.caseId, kind: next.kind, status: next.status, assignee: next.assignee, previousStatus: prev.status, decision },
  nowMs,
});

export class RestrictionAppealDecision {
  constructor(private readonly d: RestrictionAppealDecisionDeps) {}

  async decide(actor: CsActor, caseId: string, ifMatch: string | undefined, body: { decision: 'ACCEPT' | 'REJECT'; reason: string }): Promise<{ view: Record<string, unknown>; version: number }> {
    const c = await this.d.cases.visible(actor, caseId);
    if (c.kind !== 'APPEAL' || c.category !== 'RESTRICTION') throw problem('case-action-not-applicable', 409, '이 건 종류에는 이 처리가 없습니다');
    // 이미 닫힌 건은 판이 달라도 409다(재시도가 412로 굳지 않게)
    if (c.status === 'RESOLVED') throw problem('case-already-resolved', 409, '이미 해결한 건입니다');
    const version = parseIfMatch(ifMatch);
    if (version === null) throw problem('precondition-required', 428, '고칠 판(If-Match)을 보내 주세요');
    if (version !== c.version) throw precondition('다른 곳에서 이 건을 먼저 고쳤습니다');
    const src = await this.d.restrictions.appeals?.read(c.targetRef);
    if (!src) throw problem('case-action-not-applicable', 409, '이 건 종류에는 이 처리가 없습니다');
    const engine = this.d.restrictions.engineRef.current;
    if (!engine) throw problem('dependency-unavailable', 503, '예매 제한 집행 연결을 사용할 수 없습니다');
    const row = await engine.find(src.targetId);
    if (!row || row.accountId !== src.accountId) throw problem('case-action-not-applicable', 409, '이 건 종류에는 이 처리가 없습니다');
    if (row.reasonCode === 'FRAUD') throw problem('fraud-restriction-requires-approval', 403, '부정 예매 이용 제한은 승인 업무로만 풀 수 있습니다');

    const nowMs = this.d.clock.now();
    // 1) 건 판을 먼저 잡는다. 이 CAS를 진 쪽은 해제·결과·보류를 건드리지 않는다
    const reserved: CsCase = { ...c, updatedAtMs: nowMs, version: c.version + 1 };
    if (!(await this.d.store.update(reserved, c.version, caseUpdateAudit(c, reserved, actor, nowMs, 'RESTRICTION_APPEAL_RESERVED')))) throw precondition('다른 곳에서 이 건을 먼저 고쳤습니다');

    try {
      if (body.decision === 'ACCEPT') {
        await engine.lift(row.restrictionId);
        await this.d.restrictions.appeals?.result(c.targetRef, { status: 'DECIDED', result: 'LIFTED', resultNote: body.reason });
        await this.d.restrictions.notifier?.send({ appealId: c.targetRef, accountId: src.accountId, event: 'DECIDED', result: 'LIFTED' });
      } else {
        await this.d.restrictions.appeals?.result(c.targetRef, { status: 'DECIDED', result: 'KEPT', resultNote: body.reason });
        await this.d.restrictions.notifier?.send({ appealId: c.targetRef, accountId: src.accountId, event: 'DECIDED', result: 'KEPT' });
      }
      // 보류 CLOSE는 건을 닫기 전에 보낸다. 실패하면 건을 OPEN으로 되돌려 다시 결정할 수 있게 한다(IR-11)
      await this.d.restrictions.holds?.set({ accountId: src.accountId, caseId: c.caseId, kind: 'APPEAL', state: 'CLOSED', version: 2 });
    } catch (e) {
      await this.#rollback(reserved, actor, nowMs);
      if (e instanceof ProblemError) throw e;
      throw problem('dependency-unavailable', 503, '소명 결정을 저장하지 못했습니다');
    }

    const cur = await this.d.store.find(c.caseId);
    if (!cur) throw notFound();
    if (cur.status === 'RESOLVED') throw problem('case-already-resolved', 409, '이미 해결한 건입니다');
    if (cur.version !== reserved.version) throw precondition('다른 곳에서 이 건을 먼저 고쳤습니다');
    const next: CsCase = { ...cur, status: 'RESOLVED', resultNote: body.reason, resolvedAtMs: nowMs, updatedAtMs: nowMs, version: cur.version + 1 };
    if (!(await this.d.store.update(next, cur.version, caseUpdateAudit(cur, next, actor, nowMs)))) throw precondition('다른 곳에서 이 건을 먼저 고쳤습니다');
    return { view: this.d.cases.view(next, nowMs) as unknown as Record<string, unknown>, version: next.version };
  }

  /** 부수 효과가 실패했을 때 예약한 판을 되돌린다(다음 결정이 같은 건을 다시 잡을 수 있게). */
  async #rollback(reserved: CsCase, actor: CsActor, nowMs: number): Promise<void> {
    try {
      const cur = await this.d.store.find(reserved.caseId);
      if (!cur || cur.status === 'RESOLVED' || cur.version !== reserved.version) return;
      const back: CsCase = { ...cur, updatedAtMs: nowMs, version: cur.version + 1 };
      await this.d.store.update(back, cur.version, caseUpdateAudit(cur, back, actor, nowMs, 'RESTRICTION_APPEAL_ROLLBACK'));
    } catch {
      // 되돌리기 실패는 원래 오류를 바꾸지 않는다. 다음 결정은 현재 판으로 다시 시도한다
    }
  }
}
