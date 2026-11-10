// 유스케이스: 판매 정책 규칙 읽기·저장(openapi getPartnerSalePolicy·putPartnerSalePolicy, ADR-0261 결정 1~3·7, BUILD_ORDER HOT-250).
// 저장 차례(먼저 걸린 것으로 답한다): 소속(404, 보안 사건) → 공연 행 잠금 → 판매 중지(409) → 승인 이력이 있는데 실무자(403, 실패한 인가 시도)
// → If-Match(428·412) → 뜻 검사(@peaket/validation/sale-policy, 422 sale-policy-invalid와 errors). 모양이 틀린 본문은 받는 층에서 400이다.
// 승인 이력이 없으면 production.sale_policy를 바로 고치고, 있으면 재승인 대상이라 pending_revision.salePolicy에만 두며 APPROVED는 SUBMITTED로 바꾼다.
// 같은 트랜잭션에서 그 공연 명단의 잠금 시각을 다시 계산한다(규칙은 공개본으로 본다. 지난 잠금은 늦추지 않는다). 기록에는 규칙 수·판·결과 코드만 싣는다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger, RequestValidationError } from '@peaket/platform';
import { parseSalePolicy, type SalePolicyContext, SalePolicyShapeError, type SalePolicyRule, UnsafeKeyError } from '@peaket/validation/sale-policy';
import { destroyTime, lockTime } from '../domain/sale-eligibility.js';
import { SALE_STORE, type SaleState, type SaleStore, type SaleTx } from '../domain/sale-ports.js';
import { versionOfEtag } from '../domain/seatmap-layout.js';
import type { Caller } from './import-seatmap.js';
import { notFound, partnerAdminRequired, preconditionFailed, preconditionRequired, productionSuspended, salePolicyInvalid } from './problems.js';

export interface SalePolicyView {
  rules: SalePolicyRule[];
  version: number;
  pending: boolean;
}

/** 저장 검사의 맥락: event 행(변경분의 고친 1인 한도를 합친 값)과 변경분의 더한 회차, 지금 배치본의 등급 */
export function contextOf(st: SaleState): SalePolicyContext {
  return {
    rounds: [
      ...st.events.map((e) => ({ eventId: e.eventId, perPersonLimit: st.eventChanges[e.eventId]?.perPersonLimit ?? e.perPersonLimit })),
      ...st.addedEvents.map((e) => ({ eventId: e.eventId, perPersonLimit: e.perPersonLimit })),
    ],
    grades: st.grades,
  };
}

/** 지금 고치는 규칙(재승인 대기 변경분이 있으면 그것) */
export const currentRules = (st: SaleState) => st.production.pendingRules ?? st.production.rules;

/**
 * 공개본 규칙과 회차로 명단의 잠금·파기 시각을 다시 계산해 바뀐 것만 쓰고, 사본의 회차·수명이 바뀌었을 수 있으니 그 공연 명단 모두에 새 사본 판을 매긴다
 * (정비 일이 다시 넘긴다, ADR-0261 결정 7·9, 리뷰 H1·D1·D3)
 */
export async function refreshListTimes(tx: SaleTx, st: SaleState, publishedRules: readonly SalePolicyRule[], now: Date): Promise<void> {
  if (st.lists.length === 0) return;
  const rounds = st.events.map((e) => ({ eventId: e.eventId, startsAt: e.startsAt, openAt: e.openAt, status: e.status }));
  const destroy = destroyTime(rounds);
  for (const l of st.lists) {
    const locked = lockTime(publishedRules, l.key, l.lockedAt, now, rounds);
    if (locked?.getTime() !== l.lockedAt?.getTime() || destroy.getTime() !== l.destroyDueAt.getTime()) await tx.setListTimes(l.id, locked, destroy);
  }
  await tx.touchCopies();
}

/** 규칙 읽기: 모양이 틀리면 400(받는 층의 계약 검사와 겹친 가드), 뜻이 틀리면 422 */
export function checkedRules(rules: unknown, ctx: SalePolicyContext): SalePolicyRule[] {
  let parsed;
  try {
    parsed = parseSalePolicy(rules, ctx);
  } catch (e) {
    if (e instanceof SalePolicyShapeError || e instanceof UnsafeKeyError) throw new RequestValidationError('판매 정책 규칙의 모양이 틀렸다');
    throw e;
  }
  if (!parsed.ok) throw salePolicyInvalid(parsed.errors);
  return parsed.rules;
}

@Injectable()
export class SalePolicies {
  constructor(
    @Inject(SALE_STORE) private readonly store: SaleStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
  ) {}

  /** 읽기: 재승인 대기 변경분에 규칙이 있으면 그것과 pending true */
  async read(q: { productionId: string; who: Caller }): Promise<SalePolicyView> {
    const st = await this.store.read(q.productionId, q.who.tenantId);
    if (!st) {
      this.#denied(q.productionId, q.who, 'read');
      throw notFound();
    }
    return { rules: currentRules(st), version: st.production.salePolicyVersion, pending: st.production.pendingRules !== undefined };
  }

  async save(q: { productionId: string; who: Caller; role: string; ifMatch: string | undefined; rules: unknown }): Promise<{ version: number; pending: boolean }> {
    const at = { productionId: q.productionId, accountId: q.who.accountId };
    const owner = await this.store.owner(q.productionId, q.who.tenantId);
    if (!owner) {
      this.#denied(q.productionId, q.who, 'save');
      throw notFound();
    }
    const out = await this.store.withLockedProduction(q.productionId, q.who.tenantId, async (tx) => {
      const st = await tx.state();
      if (st.production.saleReview === 'SUSPENDED') throw this.#rejected(at, 409, 'production-suspended', productionSuspended());
      const approvedBefore = st.production.saleApprovedAt !== null;
      if (approvedBefore && q.role !== 'partner_admin') {
        // 승인 뒤 규칙 변경은 재승인 대상이라 파트너 관리자만 한다(catalog-review 8.2.1, 16.3.2: 실패한 인가 시도로 남긴다)
        this.#denied(q.productionId, q.who, 'save', 'partner_admin_required');
        throw this.#rejected(at, 403, 'partner-admin-required', partnerAdminRequired());
      }
      if (q.ifMatch === undefined) throw this.#rejected(at, 428, 'precondition-required', preconditionRequired());
      if (versionOfEtag(q.ifMatch) !== st.production.salePolicyVersion) throw this.#rejected(at, 412, 'precondition-failed', preconditionFailed());
      let rules: SalePolicyRule[];
      try {
        rules = checkedRules(q.rules, contextOf(st));
      } catch (e) {
        throw e instanceof RequestValidationError ? this.#rejected(at, 400, 'validation-failed', e) : this.#rejected(at, 422, 'sale-policy-invalid', e as Error);
      }
      const version = st.production.salePolicyVersion + 1;
      if (approvedBefore) await tx.saveRules(rules, version, 'pending', st.production.saleReview === 'APPROVED' ? 'SUBMITTED' : st.production.saleReview);
      else await tx.saveRules(rules, version, 'rows', st.production.saleReview);
      // 잠금 시각·사본은 공개본 규칙으로 본다(승인 전이면 지금 저장한 규칙. 승인 뒤의 변경분은 공개본을 바꾸지 않고, 판매 승인 LCH-080이 다시 계산한다)
      if (!approvedBefore) await refreshListTimes(tx, st, rules, new Date(this.clock.now()));
      return { version, pending: approvedBefore, rules: rules.length };
    });
    if (out === 'not-found') {
      this.#denied(q.productionId, q.who, 'save');
      throw notFound();
    }
    this.#info({ event: 'sale_policy_saved', ...at, version: out.version, pending: out.pending, rules: out.rules }, '판매 정책 규칙을 저장했다');
    return { version: out.version, pending: out.pending };
  }

  #rejected<E extends Error>(at: Record<string, unknown>, status: number, code: string, e: E): E {
    this.#info({ event: 'sale_policy_rejected', ...at, status, code }, '판매 정책 규칙을 저장하지 않았다');
    return e;
  }

  /** 소속이 아닌 공연의 규칙 읽기·저장과 실무자의 승인 뒤 저장(실패한 인가 시도, catalog-review 16.3.2) */
  #denied(productionId: string, who: Caller, action: 'read' | 'save', reason?: string): void {
    this.#warn({ kind: 'security', event: 'partner_production_denied', route: 'sale_policy', action, productionId: productionId.slice(0, 64), tenantId: who.tenantId, accountId: who.accountId, ...(reason ? { reason } : {}) }, '판매 정책 요청을 막았다');
  }

  #info(line: Record<string, unknown>, msg: string): void {
    try {
      this.logger?.info(line, msg);
    } catch {
      // 기록 실패는 응답을 바꾸지 않는다
    }
  }

  #warn(line: Record<string, unknown>, msg: string): void {
    try {
      this.logger?.warn(line, msg);
    } catch {
      // 기록 실패는 응답을 바꾸지 않는다
    }
  }
}
