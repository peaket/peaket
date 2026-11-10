// 유스케이스: 회차 고치기(openapi PATCH /v1/partner/events/{eventId} updatePartnerEvent, ADR-0261 결정 4, ADR-0198 결정 2·3, BUILD_ORDER HOT-250).
// 보낸 칸만 바꾼다. 판정 차례(먼저 걸린 것으로 답한다): 소속(404, 보안 사건) → 공연 행 잠금 → 판매 중지(409) → 승인 이력이 있는데 실무자(403)
// → If-Match(428·412, event.version) → 오픈 뒤 잠금(409 sale-setting-locked: 지금 ≥ 오픈 시각에 정렬 두 값·배정 방식·오픈·공연 시각을 바꿈, 경계 포함)
// → 일정·정렬(422, 회차 더하기와 같은 규칙을 바뀌는 값으로. 지금 < 오픈은 오픈 시각을 바꿀 때만 본다) → 정비 창·오픈 간격(409, 오픈 시각을 바꿀 때만)
// → 1인 한도가 그 회차에 걸린 판매 정책 규칙의 한도보다 작아짐(422 sale-policy-invalid).
// 승인 이력이 없으면 event 행을 바로 고치고 판을 올리며 같은 트랜잭션에서 그 공연 명단의 잠금·파기 시각을 다시 계산하고 새 사본 판을 매긴다. 있으면 재승인 대상이라
// event 행은 판만 올리고 바뀐 칸만 pending_revision.eventChanges[회차 ID]에 합쳐 두며 APPROVED는 SUBMITTED로 바꾼다. 응답 ETag는 새 판이다.
// 지금 값과 같은 칸만 보낸 고치기는 아무것도 바꾸지 않고 판도 올리지 않는다(리뷰 A5).
// 승인 뒤 더한 회차(변경분에만 있는 회차)는 event 행이 없어 이 경로로 고치지 않는다(없는 회차와 같은 404, BAT-157 [가정]).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { parseSalePolicy } from '@peaket/validation/sale-policy';
import { checkEventDraft, type EventDraft } from '../domain/registration.js';
import { type EventEditable, SALE_STORE, type SaleState, type SaleStore } from '../domain/sale-ports.js';
import { versionOfEtag } from '../domain/seatmap-layout.js';
import type { Caller } from './import-seatmap.js';
import { eventScheduleInvalid, notFound, partnerAdminRequired, preconditionFailed, preconditionRequired, productionSuspended, queueOrderInvalid, saleSettingLocked, salePolicyInvalid } from './problems.js';
import { contextOf, currentRules, refreshListTimes } from './sale-policy.js';
import { assertOpenSlot } from './schedule-checks.js';

export interface EventUpdated {
  eventId: string;
  version: number;
  pending: boolean;
  warnings: never[];
}

/** 오픈 뒤(지금 ≥ 오픈 시각)에는 바꾸지 못하는 칸(SCR-021, POL-035 예외 열, ADR-0261 결정 4) */
const LOCKED_AFTER_OPEN: readonly (keyof EventEditable)[] = ['lobbyShuffle', 'openBatch', 'seatAssignment', 'openAt', 'startsAt'];

const same = (a: unknown, b: unknown) => (a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime() === (b as Date | null)?.getTime() : a === b);

/** 1인 한도를 바꾼 뒤 상태 전체의 규칙 한도 넘김(전후를 견주지 않는다: 앞서 있던 넘김도 고친 뒤 상태에 남으면 거절한다, 리뷰 A5) */
function limitIssues(st: SaleState, eventId: string, perPersonLimit: number) {
  const rules = currentRules(st);
  if (rules.length === 0) return [];
  const before = contextOf(st);
  const after = { ...before, rounds: before.rounds.map((r) => (r.eventId === eventId ? { ...r, perPersonLimit } : r)) };
  const r = parseSalePolicy(rules, after);
  return r.ok ? [] : r.errors.filter((e) => e.code === 'LIMIT_ABOVE_EVENT');
}

@Injectable()
export class UpdateProductionEvent {
  constructor(
    @Inject(SALE_STORE) private readonly store: SaleStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: Pick<PlatformLogger, 'info' | 'warn'>,
  ) {}

  async run(q: { eventId: string; who: Caller; role: string; ifMatch: string | undefined; patch: Partial<EventEditable> }): Promise<EventUpdated> {
    const at = { eventId: q.eventId, accountId: q.who.accountId };
    const productionId = await this.store.eventProduction(q.eventId, q.who.tenantId);
    if (!productionId) {
      this.#denied(q.eventId, q.who);
      throw notFound();
    }
    const out = await this.store.withLockedProduction(productionId, q.who.tenantId, async (tx): Promise<EventUpdated> => {
      const st = await tx.state();
      const row = st.events.find((e) => e.eventId === q.eventId);
      if (!row) throw notFound();
      if (st.production.saleReview === 'SUSPENDED') throw this.#rejected(at, 409, 'production-suspended', productionSuspended());
      const approvedBefore = st.production.saleApprovedAt !== null;
      if (approvedBefore && q.role !== 'partner_admin') {
        this.#denied(q.eventId, q.who, 'partner_admin_required');
        throw this.#rejected(at, 403, 'partner-admin-required', partnerAdminRequired());
      }
      if (q.ifMatch === undefined) throw this.#rejected(at, 428, 'precondition-required', preconditionRequired());
      if (versionOfEtag(q.ifMatch) !== row.version) throw this.#rejected(at, 412, 'precondition-failed', preconditionFailed());
      const now = new Date(this.clock.now());
      const current: EventEditable = { ...pickEditable(row), ...st.eventChanges[q.eventId] };
      const changed = (Object.keys(q.patch) as (keyof EventEditable)[]).filter((k) => !same(q.patch[k], current[k]));
      // 오픈 뒤 잠금은 공개본의 오픈 시각으로 본다(경계 포함)
      const locked = changed.filter((k) => LOCKED_AFTER_OPEN.includes(k));
      if (locked.length > 0 && now.getTime() >= row.openAt.getTime()) {
        this.#warn({ kind: 'security', event: 'sale_setting_locked_attempt', ...at, tenantId: q.who.tenantId, fields: locked }, '오픈 뒤 바꿀 수 없는 회차 칸을 바꾸려 했다');
        throw this.#rejected(at, 409, 'sale-setting-locked', saleSettingLocked());
      }
      // 같은 값만 보냈으면 아무것도 바꾸지 않는다(판도 그대로)
      if (changed.length === 0) return { eventId: q.eventId, version: row.version, pending: approvedBefore && st.eventChanges[q.eventId] !== undefined, warnings: [] };
      const delta = Object.fromEntries(changed.map((k) => [k, q.patch[k]])) as Partial<EventEditable>;
      const next: EventEditable = { ...current, ...delta };
      const openChanged = changed.includes('openAt');
      const draft: EventDraft = { ...next, entryOpensAt: next.entryOpensAt ?? undefined, reentryAllowed: false };
      // 지금 < 오픈은 오픈 시각을 바꿀 때만 본다(오픈 뒤에도 잠기지 않은 칸은 고친다)
      const problem = checkEventDraft(draft, openChanged ? now : new Date(-8.64e15));
      if (problem === 'event-schedule-invalid') throw this.#rejected(at, 422, problem, eventScheduleInvalid(0));
      if (problem === 'queue-order-invalid') throw this.#rejected(at, 422, problem, queueOrderInvalid(0));
      if (openChanged) await assertOpenSlot(tx, draft, 0, st.production.id);
      if (changed.includes('perPersonLimit')) {
        const issues = limitIssues(st, q.eventId, next.perPersonLimit);
        if (issues.length > 0) throw this.#rejected(at, 422, 'sale-policy-invalid', salePolicyInvalid(issues));
      }
      const version = row.version + 1;
      if (approvedBefore) {
        // 바뀐 칸만 변경분에 합친다(리뷰 A5)
        await tx.savePendingEventChange(q.eventId, delta, version, st.production.saleReview === 'APPROVED' ? 'SUBMITTED' : st.production.saleReview);
      } else {
        await tx.updateEvent(q.eventId, delta, version);
        const events = st.events.map((e) => (e.eventId === q.eventId ? { ...e, ...delta } : e));
        await refreshListTimes(tx, { ...st, events }, st.production.rules, now);
      }
      return { eventId: q.eventId, version, pending: approvedBefore, warnings: [] };
    });
    if (out === 'not-found') {
      this.#denied(q.eventId, q.who);
      throw notFound();
    }
    this.#info({ event: 'partner_event_updated', ...at, version: out.version, pending: out.pending, fields: Object.keys(q.patch) }, '회차를 고쳤다');
    return out;
  }

  #rejected<E extends Error>(at: Record<string, unknown>, status: number, code: string, e: E): E {
    this.#info({ event: 'partner_event_update_rejected', ...at, status, code }, '회차를 고치지 않았다');
    return e;
  }

  #denied(eventId: string, who: Caller, reason?: string): void {
    this.#warn({ kind: 'security', event: 'partner_production_denied', route: 'event_update', eventId: eventId.slice(0, 64), tenantId: who.tenantId, accountId: who.accountId, ...(reason ? { reason } : {}) }, '회차 고치기를 막았다');
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

function pickEditable(e: EventEditable): EventEditable {
  return { openAt: e.openAt, lobbyMinutes: e.lobbyMinutes, entryOpensAt: e.entryOpensAt, startsAt: e.startsAt, endsAt: e.endsAt, lobbyShuffle: e.lobbyShuffle, openBatch: e.openBatch, seatAssignment: e.seatAssignment, perPersonLimit: e.perPersonLimit };
}
