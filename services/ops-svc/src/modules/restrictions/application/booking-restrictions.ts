// 일반 남용 예매 제한의 집행·해제·정비(F-06-4, transfer-refund §7.2 T14, queue-admission §6).
// 승인 업무 실행기(executors.restriction)와 CS 소명 판정이 같은 엔진을 쓴다. 사본이 아직 안 끝나면 PENDING으로 두고 다시 보낸다.
import { ProblemError } from '@peaket/platform';
import type { AuditChain, AuditRecord } from '../../audit/audit.js';
import { addOneYear, APPEAL_WINDOW_MS, copyRetryDelayMs, nextVersionOf, restrictionActiveAt, type RestrictionCopyInput, type RestrictionRow } from '../domain/booking-restriction.js';
import type { BookingRestrictionStore, RestrictionClock, RestrictionCopies } from '../domain/ports.js';

export interface BookingRestrictionsDeps {
  readonly store: BookingRestrictionStore;
  readonly copies: RestrictionCopies;
  readonly clock: RestrictionClock;
  readonly audit?: AuditChain;
}

export interface RestrictionExecuteInput {
  readonly approvalId: string;
  readonly targetRef: string;
  readonly reasonCode: string;
  readonly restrictionEndsAtMs: number;
  readonly approvedBy: string | null;
}

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const unavailable = () => new ProblemError({ type: 'dependency-unavailable', status: 503, title: '예매 제한 집행 연결을 사용할 수 없습니다' });

export class BookingRestrictions {
  readonly #store: BookingRestrictionStore;
  readonly #copies: RestrictionCopies;
  readonly #clock: RestrictionClock;
  readonly #audit?: AuditChain;
  #lastResyncMs = Number.NEGATIVE_INFINITY;

  #auditRecord(recordType: string, row: RestrictionRow, nowMs: number): AuditRecord {
    return { recordType, recordId: row.restrictionId, payload: { version: row.version, reasonCode: row.reasonCode }, nowMs };
  }

  constructor(d: BookingRestrictionsDeps) {
    this.#store = d.store;
    this.#copies = d.copies;
    this.#clock = d.clock;
    if (d.audit) this.#audit = d.audit;
  }

  /** 승인 업무 실행기. 같은 승인 ID는 한 행만 만들고, queue·purchase가 모두 반영돼야 DONE이다. */
  async execute(i: RestrictionExecuteInput): Promise<{ status: 'DONE' | 'PENDING' }> {
    const nowMs = this.#clock.now();
    let row = await this.#store.findByApproval(i.approvalId);
    if (!row) {
      const rows = await this.#store.rows();
      row = {
        restrictionId: i.approvalId,
        approvalId: i.approvalId,
        accountId: i.targetRef,
        reasonCode: i.reasonCode,
        fraudCaseId: null,
        confirmedBy: i.approvedBy,
        startsAtMs: nowMs,
        endsAtMs: Math.min(i.restrictionEndsAtMs, addOneYear(nowMs)),
        appealDueAtMs: nowMs + APPEAL_WINDOW_MS,
        status: 'ACTIVE',
        version: nextVersionOf(rows, i.targetRef),
        deliveryDone: false,
        copyNextAtMs: nowMs,
        copyAttempts: 0,
      };
      await this.#store.insert(row);
    }
    if (row.status !== 'ACTIVE') return { status: 'DONE' };
    if (row.copyNextAtMs !== null && nowMs < row.copyNextAtMs) return { status: 'PENDING' };
    const active: RestrictionCopyInput = {
      accountId: row.accountId,
      restrictionId: row.restrictionId,
      state: 'ACTIVE',
      endsAtMs: row.endsAtMs,
      version: row.version,
    };
    try {
      await this.#copies.queue(active);
      await this.#copies.purchase(active);
    } catch {
      const failed: RestrictionRow = { ...row, copyAttempts: row.copyAttempts + 1, copyNextAtMs: nowMs + copyRetryDelayMs(row.copyAttempts + 1) };
      await this.#store.update(failed);
      return { status: 'PENDING' };
    }
    const applied: RestrictionRow = { ...row, deliveryDone: true, copyNextAtMs: null, copyAttempts: 0 };
    await this.#store.update(applied, this.#auditRecord('RESTRICTION_APPLIED', row, nowMs));
    // 화면용 사본은 집행이 아니다. 실패해도 Done을 막지 않는다
    try {
      await this.#copies.view({ ...active, reasonCode: row.reasonCode, startsAtMs: row.startsAtMs, appealDueAtMs: row.appealDueAtMs });
    } catch {
      // 다음 정비가 다시 보낸다
    }
    this.#lastResyncMs = nowMs;
    return { status: 'DONE' };
  }

  /** 예매 제한 소명 인정. 일반 사유만 이 경로로 풀 수 있고 FRAUD는 FRAUD_ACTION 승인 뒤에만 엔진이 부른다. */
  async lift(restrictionId: string): Promise<RestrictionRow> {
    const row = await this.#store.find(restrictionId);
    if (!row) throw notFound();
    if (row.reasonCode === 'FRAUD') throw new ProblemError({ type: 'fraud-restriction-requires-approval', status: 403, title: '부정 예매 이용 제한은 승인 업무로만 풀 수 있습니다' });
    if (row.status === 'LIFTED') return row;
    // 이미 끝난 제한은 풀 것이 없다. 소명 건은 닫을 수 있게 현재 행을 그대로 돌려준다
    if (row.status === 'EXPIRED') return row;
    const nextVersion = row.version + 1;
    const input = { accountId: row.accountId, restrictionId: row.restrictionId, state: 'LIFTED' as const, version: nextVersion };
    try {
      await this.#copies.queue(input);
      await this.#copies.purchase(input);
    } catch {
      throw unavailable();
    }
    const lifted: RestrictionRow = { ...row, status: 'LIFTED', version: nextVersion };
    await this.#store.update(lifted, this.#auditRecord('RESTRICTION_LIFTED', lifted, this.#clock.now()));
    try {
      await this.#copies.view({ ...input, reasonCode: row.reasonCode, startsAtMs: row.startsAtMs, appealDueAtMs: row.appealDueAtMs });
    } catch {
      // 화면용 사본 실패는 해제를 막지 않는다
    }
    return lifted;
  }

  /** 10분 정비·다시 보내기(IR-02). 끝난 행을 EXPIRED로, 실패한 사본을 다시, 잃은 사본을 같은 판으로 다시 세운다. */
  async maintain(nowMs = this.#clock.now()): Promise<{ expired: number; retried: number; resent: number }> {
    const expired = await this.expireDue(nowMs);
    const retried = await this.retryPending(nowMs);
    const resent = await this.resyncIfDue(nowMs);
    return { expired, retried, resent };
  }

  /** 사본 보내기가 실패해 다음 시각이 된 ACTIVE 행을 같은 승인 ID로 다시 실행한다. */
  async retryPending(nowMs = this.#clock.now()): Promise<number> {
    let retried = 0;
    for (const row of await this.#store.rows()) {
      if (row.status !== 'ACTIVE' || row.deliveryDone || row.approvalId === null) continue;
      if (row.copyNextAtMs === null || nowMs < row.copyNextAtMs) continue;
      const result = await this.execute({
        approvalId: row.approvalId,
        targetRef: row.accountId,
        reasonCode: row.reasonCode,
        restrictionEndsAtMs: row.endsAtMs ?? addOneYear(nowMs),
        approvedBy: row.confirmedBy,
      });
      if (result.status === 'DONE') retried += 1;
    }
    return retried;
  }

  /** 끝이 지난 ACTIVE를 EXPIRED로 바꾼다(집행 사본은 끝 시각으로 판정하므로 지우지 않는다). */
  async expireDue(nowMs = this.#clock.now()): Promise<number> {
    let expired = 0;
    for (const row of await this.#store.rows()) {
      if (row.status === 'ACTIVE' && !restrictionActiveAt(row, nowMs)) {
        await this.#store.update({ ...row, status: 'EXPIRED', copyNextAtMs: null });
        expired += 1;
      }
    }
    return expired;
  }

  /** 10분마다 ACTIVE 행의 사본을 같은 판으로 다시 보낸다. 사본 저장소가 잃어도 다시 선다. */
  async resyncIfDue(nowMs = this.#clock.now()): Promise<number> {
    if (nowMs - this.#lastResyncMs < 600_000) return 0;
    this.#lastResyncMs = nowMs;
    let sent = 0;
    for (const row of await this.#store.rows()) {
      if (row.status !== 'ACTIVE' || !row.deliveryDone) continue;
      const active = { accountId: row.accountId, restrictionId: row.restrictionId, state: 'ACTIVE' as const, endsAtMs: row.endsAtMs, version: row.version };
      try {
        await this.#copies.queue(active);
        await this.#copies.purchase(active);
        await this.#copies.view({ ...active, reasonCode: row.reasonCode, startsAtMs: row.startsAtMs, appealDueAtMs: row.appealDueAtMs });
        sent += 1;
      } catch {
        // 다음 바퀴에 다시 한다
      }
    }
    return sent;
  }

  async find(restrictionId: string): Promise<RestrictionRow | undefined> {
    return this.#store.find(restrictionId);
  }

  async rows(): Promise<RestrictionRow[]> {
    return this.#store.rows();
  }
}
