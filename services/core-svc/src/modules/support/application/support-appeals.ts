// F-04-15 support 응용. 소명 저장·멱등·ops 연결·화면 사본 조회.
import { ProblemError } from '@peaket/platform';
import { appealResponse, fraudAppealViewResponse, newAppeal, normalizeFraudAppealView, validateAppealBody, type AppealKind, type AppealRecord, type FraudAppealViewRecord } from '../domain/appeal.js';
import type { AppealTargets, FraudAppealViews, FraudCaseAppeals, IdempotentWrite, SupportAppealStore } from '../domain/ports.js';

const problem = (type: string, status: number, title: string) => new ProblemError({ type, status, title });

export interface SupportAppealsDeps {
  readonly store: SupportAppealStore;
  readonly views: FraudAppealViews;
  readonly fraudCases?: FraudCaseAppeals;
  readonly targets?: AppealTargets;
  readonly now: () => number;
}

export class SupportAppeals {
  constructor(private readonly d: SupportAppealsDeps) {}

  async submit(actor: { accountId: string }, idem: IdempotentWrite, body: { kind: AppealKind; targetId: string; body: string }): Promise<Record<string, unknown>> {
    const checked = validateAppealBody(body.body);
    if ('status' in checked) throw problem(checked.type, checked.status, checked.title);

    const found = await this.d.store.findIdempotent(idem);
    if (found.kind === 'reused') throw problem('idempotency-key-reused', 422, '같은 멱등 키를 다른 요청에 썼습니다');
    if (found.kind === 'in_progress') throw problem('idempotency-request-in-progress', 409, '같은 요청을 아직 처리하고 있습니다');
    if (found.kind === 'replay') return (found.result ?? {}) as Record<string, unknown>;

    const nowMs = this.d.now();
    // 사본은 캐시다. 읽지 못하면 PAYER로 보고, HOLDER 판정은 ops가 다시 한다.
    const party = (await this.d.views.list(actor.accountId).catch(() => [])).find((v) => v.caseId === body.targetId)?.party === 'HOLDER' ? 'HOLDER' : 'PAYER';
    let record: AppealRecord = newAppeal({ accountId: actor.accountId, kind: body.kind, targetId: body.targetId, body: checked.body, nowMs });

    if (body.kind === 'FRAUD_CASE') {
      if (!this.d.fraudCases) throw problem('dependency-unavailable', 503, '조사 사건 연결을 쓸 수 없습니다');
      let result: 'SUBMITTED' | 'OBJECTION_SUBMITTED' | 'EXPIRED' | 'INVALID';
      try {
        result = (await this.d.fraudCases.submit({ caseId: body.targetId, appealId: record.id, accountId: actor.accountId, party, submittedAt: new Date(nowMs).toISOString() })).result;
      } catch (e) {
        const p = e as { type?: string; status?: number };
        if (p && typeof p.status === 'number') throw e;
        throw problem('dependency-unavailable', 503, '조사 사건 연결을 쓸 수 없습니다');
      }
      if (result === 'INVALID' || result === 'EXPIRED') record = { ...record, status: 'INVALID', decidedAtMs: nowMs };
    } else if (this.d.targets) {
      try {
        await this.d.targets.submit({ appealId: record.id, kind: body.kind, targetId: body.targetId, accountId: actor.accountId });
      } catch {
        // 대상 연결은 닫힌 대역이다. 소명 저장은 유지한다.
      }
    }

    const result = appealResponse(record);
    await this.d.store.put(record, { idem, result });
    return result;
  }

  async list(actor: { accountId: string }, q: { cursor?: string; limit: number }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
    const page = await this.d.store.listByAccount(actor.accountId, q);
    return { items: page.items.map((a) => appealResponse(a)), nextCursor: page.nextCursor };
  }

  async get(actor: { accountId: string }, appealId: string): Promise<Record<string, unknown>> {
    const a = await this.d.store.get(appealId);
    if (!a || a.accountId !== actor.accountId) throw problem('not-found', 404, '소명을 찾을 수 없습니다');
    return appealResponse(a);
  }

  async fraudViews(actor: { accountId: string }): Promise<{ items: Record<string, unknown>[]; nextCursor: null }> {
    const nowMs = this.d.now();
    const all = await this.d.views.list(actor.accountId);
    const items = all.filter((v) => v.state === 'OPEN' || nowMs - v.updatedAtMs <= 30 * 24 * 60 * 60 * 1000).map((v) => fraudAppealViewResponse(v));
    return { items, nextCursor: null };
  }

  async applyDecision(appealId: string, result: AppealRecord['result'], nowMs: number): Promise<void> {
    const a = await this.d.store.get(appealId);
    if (!a) return;
    await this.d.store.update({ ...a, status: 'DECIDED', result, decidedAtMs: nowMs });
  }
}

/** gRPC 처리기와 시험이 같은 정규화를 쓰게 한다. */
export async function applyFraudAppealView(views: FraudAppealViews, request: Record<string, any>, nowMs: number): Promise<FraudAppealViewRecord> {
  const normalized = normalizeFraudAppealView(request, nowMs);
  await views.set({ ...normalized, updatedAtMs: normalized.updatedAtMs ?? nowMs });
  return normalized;
}
