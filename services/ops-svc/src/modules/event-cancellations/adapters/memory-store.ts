// 회차 취소 요청 메모리 저장소(단위 시험·로컬). 같은 회차의 진행 중 요청 하나(ops 0011 부분 유일 인덱스)와
// 멱등 기록(ops 0014, 계정 × 작업 × 키)을 DB 저장소와 같은 규칙으로 지킨다.
import { timingSafeEqual } from 'node:crypto';
import { idempotencyKeyReused } from '@peaket/platform';
import type { AuditChain, AuditRecord } from '../../audit/audit.js';
import { ACTIVE_EVENT_CANCELLATION_STATUSES, eventCancellationView, type EventCancellationRecord, type EventCancellationStatus, type EventCancellationView } from '../domain/event-cancellation.js';
import type { CoreApplyDue, CoreApplyStore, EventCancellationIdempotency, EventCancellationInsert, EventCancellationStore } from '../domain/ports.js';

const ACTIVE: ReadonlySet<EventCancellationStatus> = new Set(ACTIVE_EVENT_CANCELLATION_STATUSES);
/** core 반영 다시 하기 대상 상태(DB 저장소와 같다) */
const CORE_APPLY_STATUSES: ReadonlySet<EventCancellationStatus> = new Set(['APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED']);

export class MemoryEventCancellationStore implements EventCancellationStore, CoreApplyStore {
  readonly rows = new Map<string, EventCancellationRecord>();
  /** core 반영 표시(ops 0016과 같은 세 칸, 요청 ID별) */
  readonly core = new Map<string, { appliedAtMs?: number; nextAtMs?: number; overdueAtMs?: number; supersededAtMs?: number }>();
  /** 멱등 기록: `계정\n작업\n키` → 지문과 처음 응답 */
  readonly #once = new Map<string, { hash: Buffer; view: EventCancellationView }>();

  constructor(private readonly audit?: AuditChain) {}

  async insert(record: EventCancellationRecord, audit?: AuditRecord, idem?: EventCancellationIdempotency): Promise<EventCancellationInsert> {
    const scope = idem ? `${idem.accountRef}\n${idem.operation}\n${idem.key}` : undefined;
    if (idem && scope !== undefined) {
      const seen = this.#once.get(scope);
      const hash = Buffer.from(idem.requestHash);
      if (seen) {
        if (seen.hash.length !== hash.length || !timingSafeEqual(seen.hash, hash)) throw idempotencyKeyReused();
        return { status: 'REPLAYED', view: seen.view };
      }
    }
    if (ACTIVE.has(record.status)) {
      const active = await this.findActiveByEvent(record.eventId);
      if (active) return { status: 'ACTIVE', requestId: active.requestId };
    }
    this.rows.set(record.requestId, record);
    if (audit) await this.audit?.append(audit);
    if (idem && scope !== undefined) this.#once.set(scope, { hash: Buffer.from(idem.requestHash), view: eventCancellationView(record) });
    return { status: 'INSERTED' };
  }

  async replayOf(idem: EventCancellationIdempotency): Promise<EventCancellationView | undefined> {
    const seen = this.#once.get(`${idem.accountRef}\n${idem.operation}\n${idem.key}`);
    if (!seen) return undefined;
    const hash = Buffer.from(idem.requestHash);
    if (seen.hash.length !== hash.length || !timingSafeEqual(seen.hash, hash)) throw idempotencyKeyReused();
    return seen.view;
  }

  async find(requestId: string): Promise<EventCancellationRecord | undefined> {
    return this.rows.get(requestId);
  }

  async markCoreApplied(requestId: string, nowMs: number): Promise<void> {
    const c = this.core.get(requestId) ?? {};
    if (c.appliedAtMs !== undefined) return;
    this.core.set(requestId, { ...c, appliedAtMs: nowMs });
    // 같은 회차의 앞 요청은 대체한다(DB 저장소와 같다, RV-06)
    const me = this.rows.get(requestId);
    if (!me?.approvedAt) return;
    for (const r of this.rows.values()) {
      if (r.requestId === requestId || r.eventId !== me.eventId || !r.approvedAt || r.approvedAt.getTime() >= me.approvedAt.getTime()) continue;
      const o = this.core.get(r.requestId) ?? {};
      if (o.appliedAtMs === undefined && o.supersededAtMs === undefined) this.core.set(r.requestId, { ...o, supersededAtMs: nowMs });
    }
  }

  async deferCoreApply(requestId: string, untilMs: number): Promise<void> {
    const c = this.core.get(requestId) ?? {};
    if (c.appliedAtMs === undefined) this.core.set(requestId, { ...c, nextAtMs: untilMs });
  }

  async claimCoreApplies(nowMs: number, limit: number, retryAfterMs: number): Promise<readonly CoreApplyDue[]> {
    const due = this.#coreTargets().filter((r) => {
      const next = this.core.get(r.requestId)?.nextAtMs;
      return next === undefined || next <= nowMs;
    });
    // 잡기 차례: 다음 볼 시각이 빈 것 먼저, 그다음 다음 볼 시각 → 확정 시각(DB 저장소와 같다). 돌려주는 차례는 확정 시각 순
    const nextOf = (r: EventCancellationRecord) => this.core.get(r.requestId)?.nextAtMs;
    const picked = [...due]
      .sort((a, b) => {
        const na = nextOf(a);
        const nb = nextOf(b);
        if (na === undefined && nb !== undefined) return -1;
        if (na !== undefined && nb === undefined) return 1;
        return (na ?? 0) - (nb ?? 0) || (a.approvedAt?.getTime() ?? 0) - (b.approvedAt?.getTime() ?? 0) || a.requestId.localeCompare(b.requestId);
      })
      .slice(0, limit);
    return picked
      .map((r) => {
        this.core.set(r.requestId, { ...(this.core.get(r.requestId) ?? {}), nextAtMs: nowMs + retryAfterMs });
        return { requestId: r.requestId, eventId: r.eventId, kind: r.kind, ...(r.newStartsAt ? { newStartsAt: r.newStartsAt } : {}), ...(r.approvedAt ? { approvedAtMs: r.approvedAt.getTime() } : {}) };
      })
      .sort((a, b) => (a.approvedAtMs ?? 0) - (b.approvedAtMs ?? 0) || a.requestId.localeCompare(b.requestId));
  }

  async markCoreApplyOverdue(nowMs: number, overdueAfterMs: number, limit: number): Promise<readonly { requestId: string; eventId: string }[]> {
    const due = this.#coreTargets().filter((r) => this.core.get(r.requestId)?.overdueAtMs === undefined && r.approvedAt !== null && r.approvedAt.getTime() <= nowMs - overdueAfterMs);
    return due.slice(0, limit).map((r) => {
      this.core.set(r.requestId, { ...(this.core.get(r.requestId) ?? {}), overdueAtMs: nowMs });
      return { requestId: r.requestId, eventId: r.eventId };
    });
  }

  /** Start까지 끝냈고(refundJobState 있음) 반영하지 않은 확정 뒤 요청(확정 시각 순) */
  #coreTargets(): EventCancellationRecord[] {
    return [...this.rows.values()]
      .filter((r) => CORE_APPLY_STATUSES.has(r.status) && r.refundJobState !== null && this.core.get(r.requestId)?.appliedAtMs === undefined && this.core.get(r.requestId)?.supersededAtMs === undefined)
      .sort((a, b) => (a.approvedAt?.getTime() ?? 0) - (b.approvedAt?.getTime() ?? 0) || a.requestId.localeCompare(b.requestId));
  }

  async findActiveByEvent(eventId: string): Promise<EventCancellationRecord | undefined> {
    return [...this.rows.values()].find((r) => r.eventId === eventId && ACTIVE.has(r.status));
  }

  async save(record: EventCancellationRecord, audit?: AuditRecord): Promise<boolean> {
    const current = this.rows.get(record.requestId);
    if (!current || current.version !== record.version - 1) return false;
    this.rows.set(record.requestId, record);
    if (audit) await this.audit?.append(audit);
    return true;
  }

  async list(filter: { eventId?: string | undefined; status?: readonly EventCancellationStatus[] | undefined; limit: number }): Promise<EventCancellationRecord[]> {
    return [...this.rows.values()]
      .filter((r) => (filter.eventId === undefined || r.eventId === filter.eventId) && (filter.status === undefined || filter.status.includes(r.status)))
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || (a.requestId < b.requestId ? 1 : -1))
      .slice(0, filter.limit);
  }
}
