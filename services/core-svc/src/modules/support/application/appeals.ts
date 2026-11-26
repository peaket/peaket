// core-svc support 소명 유스케이스(F-06-4, transfer-refund §7.1).
// 접수(한 트랜잭션에 appeal+Outbox), 내 목록·화면용 사본, 내부 읽기·결과 기록, FRAUD 사건 입구 보내기와 1분→10분 다시 보내기.
import { ProblemError } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { APPEAL_BODY_MAX, bodyLength, dispatchRetryDelayMs, isAppealKind, normalizeBody, type AppealRow, type FraudAppealViewRow, type RestrictionViewRow } from '../domain/appeal.js';
import type { AppealCaseSink, AppealStore, FanNotifier, FraudAppealClient, FraudAppealViewStore, RestrictionViewStore } from '../domain/ports.js';

export interface AppealsDeps {
  readonly store: AppealStore;
  readonly restrictionViews: RestrictionViewStore;
  readonly fraudViews: FraudAppealViewStore;
  readonly fraudAppeals?: FraudAppealClient;
  readonly caseSink?: AppealCaseSink;
  readonly notifier?: FanNotifier;
  readonly clock: { now(): number };
}

const problem = (type: string, status: number, title: string) => new ProblemError({ type, status, title });
const iso = (ms: number) => new Date(ms).toISOString();

export class Appeals {
  constructor(private readonly d: AppealsDeps) {}

  async submit(accountId: string, input: { kind: string; targetId: string; body: string }): Promise<Record<string, unknown>> {
    if (!isAppealKind(input.kind)) throw problem('appeal-kind-not-supported', 422, '지금 받지 않는 소명 종류입니다');
    if (!input.targetId || input.targetId.length > 64) throw problem('invalid-body', 400, '소명 대상이 올바르지 않습니다');
    const body = normalizeBody(input.body ?? '');
    const len = bodyLength(body);
    if (len < 1 || len > APPEAL_BODY_MAX) throw problem('invalid-body', 400, '소명 글은 1~2,000자입니다');
    const now = this.d.clock.now();
    let dueBaseAt: string | undefined;
    if (input.kind === 'RESTRICTION') {
      const view = await this.d.restrictionViews.get(accountId, input.targetId);
      if (view && view.state === 'ACTIVE' && now >= view.appealDueAtMs) throw problem('appeal-deadline-passed', 409, '소명 기한이 지났습니다');
    } else {
      const view = await this.d.fraudViews.get(accountId, input.targetId);
      if (view) dueBaseAt = iso(view.dueAtMs);
    }
    const row: AppealRow = {
      appealId: randomUUID(),
      accountId,
      kind: input.kind,
      targetId: input.targetId,
      body,
      status: 'SUBMITTED',
      result: null,
      resultNote: null,
      caseId: null,
      submittedAtMs: now,
      decidedAtMs: null,
      dispatchState: 'PENDING',
      dispatchAttempts: 0,
      nextDispatchAtMs: now,
      dispatchedAtMs: null,
    };
    await this.d.store.saveAppeal(row, { eventKey: row.appealId, kind: 'APPEAL', sourceId: row.appealId, category: row.kind, createdAt: iso(now), ...(dueBaseAt ? { dueBaseAt } : {}) });
    return this.#view(row);
  }

  async listMine(accountId: string): Promise<{ items: Array<Record<string, unknown>>; nextCursor: null }> {
    const rows = await this.d.store.listByAccount(accountId, 100);
    return { items: rows.map((r) => this.#view(r)), nextCursor: null };
  }

  async restrictionOf(accountId: string): Promise<Record<string, unknown>> {
    const now = this.d.clock.now();
    const active = (await this.d.restrictionViews.list(accountId)).find((r) => r.state === 'ACTIVE' && (r.endsAtMs === null || r.endsAtMs > now));
    if (!active) return { status: 'NONE' };
    return {
      status: 'ACTIVE',
      restrictionId: active.restrictionId,
      reasonCode: active.reasonCode,
      startsAt: iso(active.startsAtMs),
      endsAt: active.endsAtMs === null ? null : iso(active.endsAtMs),
      appealDueAt: iso(active.appealDueAtMs),
    };
  }

  async fraudAppealsOf(accountId: string): Promise<{ items: Array<Record<string, unknown>>; nextCursor: null }> {
    const rows = await this.d.fraudViews.list(accountId);
    return { items: rows.map((r) => this.#fraudView(r)), nextCursor: null };
  }

  async internalGet(appealId: string): Promise<Record<string, unknown>> {
    const row = await this.d.store.find(appealId);
    if (!row) throw problem('not-found', 404, '찾을 수 없습니다');
    return { appealId: row.appealId, accountId: row.accountId, kind: row.kind, targetId: row.targetId, body: row.body, submittedAt: iso(row.submittedAtMs), status: row.status, caseId: row.caseId };
  }

  async recordResult(appealId: string, input: { status: string; result?: string; resultNote?: string; reason?: string; caseId?: string }): Promise<Record<string, unknown>> {
    const row = await this.d.store.find(appealId);
    if (!row) throw problem('not-found', 404, '찾을 수 없습니다');
    if (input.status !== 'DECIDED' && input.status !== 'INVALID') throw problem('invalid-body', 400, '결과 상태가 올바르지 않습니다');
    if (row.status !== 'SUBMITTED') {
      const same = row.status === input.status && (row.result ?? null) === (input.result ?? null);
      if (same) return this.#view(row);
      throw problem('appeal-result-conflict', 409, '같은 소명에 다른 결과가 왔습니다');
    }
    await this.d.store.saveResult(appealId, {
      status: input.status,
      ...(input.result ? { result: input.result } : {}),
      ...(input.resultNote !== undefined ? { resultNote: input.resultNote } : input.reason !== undefined ? { resultNote: input.reason } : {}),
      decidedAtMs: this.d.clock.now(),
      ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
    });
    const next = await this.d.store.find(appealId);
    return this.#view(next!);
  }

  /** Outbox(F-06-4: support.cases-requested)와 FRAUD_CASE 사건 입구를 보낸다. RESTRICTION은 Outbox만이다. */
  async dispatchOnce(nowMs = this.d.clock.now()): Promise<{ sent: number; retry: number; invalid: number }> {
    const rows = await this.d.store.dueDispatch(nowMs, 100);
    let sent = 0;
    let retry = 0;
    let invalid = 0;
    for (const row of rows) {
      if (row.kind === 'RESTRICTION') {
        await this.d.store.saveDispatch(row.appealId, { state: 'SENT', attempts: row.dispatchAttempts + 1, nextAtMs: null, dispatchedAtMs: nowMs });
        sent += 1;
        continue;
      }
      const view = await this.d.fraudViews.get(row.accountId, row.targetId);
      const party = view?.party ?? 'PAYER';
      const answer = this.d.fraudAppeals
        ? await this.d.fraudAppeals.send({ caseId: row.targetId, appealId: row.appealId, accountId: row.accountId, party, submittedAtMs: row.submittedAtMs })
        : ({ result: 'RETRY' } as const);
      if (answer.result === 'ACCEPTED') {
        await this.d.store.saveDispatch(row.appealId, { state: 'SENT', attempts: row.dispatchAttempts + 1, nextAtMs: null, dispatchedAtMs: nowMs });
        sent += 1;
      } else if (answer.result === 'EXPIRED' || answer.result === 'NOT_TARGET') {
        const reason = answer.result === 'EXPIRED' ? '기한 경과' : '대상 아님';
        await this.d.store.saveResult(row.appealId, { status: 'INVALID', resultNote: reason, decidedAtMs: nowMs });
        try { await this.d.caseSink?.invalid({ appealId: row.appealId, reason }); } catch { /* ops 건 닫기는 다시 보낼 수 있게 삼킨다 */ }
        try { await this.d.notifier?.send({ appealId: row.appealId, accountId: row.accountId, event: 'INVALID' }); } catch { /* 알림 실패는 결과를 되돌리지 않는다 */ }
        invalid += 1;
      } else {
        const attempts = row.dispatchAttempts + 1;
        await this.d.store.saveDispatch(row.appealId, { state: 'RETRY', attempts, nextAtMs: nowMs + dispatchRetryDelayMs(attempts), dispatchedAtMs: nowMs });
        retry += 1;
      }
    }
    return { sent, retry, invalid };
  }

  #view(r: AppealRow): Record<string, unknown> {
    return {
      appealId: r.appealId,
      kind: r.kind,
      targetId: r.targetId,
      status: r.status,
      result: r.result,
      resultNote: r.resultNote,
      reasonCode: null,
      dueAt: null,
      resultDueAt: null,
      submittedAt: iso(r.submittedAtMs),
      decidedAt: r.decidedAtMs === null ? null : iso(r.decidedAtMs),
    };
  }

  #fraudView(r: FraudAppealViewRow): Record<string, unknown> {
    const actionResult =
      r.party === 'HOLDER'
        ? null
        : r.actionResult ?? (r.cancelledTicketIds.length > 0 || r.restrictedUntilMs !== null
            ? { cancelledTicketIds: r.cancelledTicketIds, restrictedUntil: r.restrictedUntilMs === null ? null : iso(r.restrictedUntilMs) }
            : null);
    return {
      caseId: r.caseId,
      eventId: r.eventId,
      party: r.party,
      heldTicketIds: r.heldTicketIds,
      excludedTicketIds: r.excludedTicketIds,
      reasonCategories: r.reasonCategories,
      dueAt: iso(r.dueAtMs),
      objectionDueAt: r.objectionDueAtMs === null ? null : iso(r.objectionDueAtMs),
      objectionStatus: r.objectionStatus,
      objectionNote: r.objectionNote,
      actionResult,
      priorityPurchases: r.priorityPurchases.map((p) => ({ grantId: p.grantId, seatLabel: p.seatLabel, price: p.price, expiresAt: iso(p.expiresAtMs), status: p.status })),
      lockExpiresAt: r.lockExpiresAtMs === null ? null : iso(r.lockExpiresAtMs),
      lockActive: r.lockActive,
    };
  }
}
