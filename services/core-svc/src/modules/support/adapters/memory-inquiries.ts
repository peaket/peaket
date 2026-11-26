// core-svc support 문의 메모리 저장소(F-06-5, 단위 시험·개발). 쓰기는 실패 주입 때 반쪽 행을 남기지 않는다.
import type { InquiryCaseRequestRow, InquiryMessageRow, InquiryRow, InquiryStatus } from '../domain/inquiry.js';
import type { InquiryStore } from '../domain/inquiry-ports.js';

export class MemoryInquiryStore implements InquiryStore {
  readonly rows = new Map<string, InquiryRow>();
  readonly messageRows: InquiryMessageRow[] = [];
  readonly outbox: InquiryCaseRequestRow[] = [];
  readonly #seq = new Map<string, number>();
  #fail: 'saveInquiry' | 'saveMessage' | 'saveOutbox' | 'saveReply' | 'saveClose' | null = null;

  failNext(op: 'saveInquiry' | 'saveMessage' | 'saveOutbox' | 'saveReply' | 'saveClose'): void {
    this.#fail = op;
  }

  async create(inquiry: InquiryRow, message: InquiryMessageRow, caseRequest: InquiryCaseRequestRow): Promise<void> {
    if (this.#fail === 'saveInquiry') {
      this.#fail = null;
      throw new Error('inquiry store down');
    }
    if (this.#fail === 'saveMessage') {
      this.#fail = null;
      throw new Error('inquiry message store down');
    }
    if (this.#fail === 'saveOutbox') {
      this.#fail = null;
      throw new Error('inquiry outbox down');
    }
    this.rows.set(inquiry.inquiryId, { ...inquiry });
    this.messageRows.push({ ...message });
    this.outbox.push({ ...caseRequest });
  }

  async find(inquiryId: string): Promise<InquiryRow | undefined> {
    const r = this.rows.get(inquiryId);
    return r ? { ...r } : undefined;
  }

  async findByRequestKey(accountId: string, requestKey: string): Promise<InquiryRow | undefined> {
    const r = [...this.rows.values()].find((x) => x.accountId === accountId && x.requestKey === requestKey);
    return r ? { ...r } : undefined;
  }

  async listByAccount(accountId: string, statuses: readonly InquiryStatus[] | undefined, limit: number, offset: number): Promise<InquiryRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.accountId === accountId && (!statuses || statuses.includes(r.status)))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(offset, offset + limit)
      .map((r) => ({ ...r }));
  }

  async countByAccount(accountId: string, statuses: readonly InquiryStatus[] | undefined): Promise<number> {
    return [...this.rows.values()].filter((r) => r.accountId === accountId && (!statuses || statuses.includes(r.status))).length;
  }

  async countSince(accountId: string, sinceMs: number): Promise<number> {
    return [...this.rows.values()].filter((r) => r.accountId === accountId && r.createdAtMs >= sinceMs).length;
  }

  async nextSequence(ym: string): Promise<number> {
    const n = (this.#seq.get(ym) ?? 0) + 1;
    this.#seq.set(ym, n);
    return n;
  }

  async messages(inquiryId: string): Promise<InquiryMessageRow[]> {
    return this.messageRows.filter((m) => m.inquiryId === inquiryId).sort((a, b) => a.createdAtMs - b.createdAtMs).map((m) => ({ ...m }));
  }

  async findMessageByRequestKey(inquiryId: string, requestKey: string): Promise<InquiryMessageRow | undefined> {
    const m = this.messageRows.find((x) => x.inquiryId === inquiryId && x.requestKey === requestKey);
    return m ? { ...m } : undefined;
  }

  async addFanMessage(message: InquiryMessageRow, status: InquiryStatus, caseRequest: InquiryCaseRequestRow): Promise<void> {
    if (this.#fail === 'saveReply' || this.#fail === 'saveMessage') {
      this.#fail = null;
      throw new Error('inquiry message store down');
    }
    const row = this.rows.get(message.inquiryId);
    if (!row) throw new Error('inquiry not found');
    this.messageRows.push({ ...message });
    this.rows.set(message.inquiryId, { ...row, status });
    this.outbox.push({ ...caseRequest });
  }

  async addAgentMessage(message: InquiryMessageRow, status: InquiryStatus, answeredAtMs: number | null): Promise<void> {
    if (this.#fail === 'saveReply') {
      this.#fail = null;
      throw new Error('inquiry reply store down');
    }
    const row = this.rows.get(message.inquiryId);
    if (!row) throw new Error('inquiry not found');
    this.messageRows.push({ ...message });
    this.rows.set(message.inquiryId, { ...row, status, answeredAtMs: answeredAtMs ?? row.answeredAtMs });
  }

  async markViewed(inquiryId: string, nowMs: number): Promise<void> {
    const row = this.rows.get(inquiryId);
    if (row) this.rows.set(inquiryId, { ...row, fanViewedAtMs: nowMs });
  }

  async setCaseId(inquiryId: string, caseId: string): Promise<boolean> {
    const row = this.rows.get(inquiryId);
    if (!row) return false;
    this.rows.set(inquiryId, { ...row, caseId });
    return true;
  }

  async close(inquiryId: string, nowMs: number, purgeAtMs: number): Promise<void> {
    if (this.#fail === 'saveClose') {
      this.#fail = null;
      throw new Error('inquiry close store down');
    }
    const row = this.rows.get(inquiryId);
    if (!row) throw new Error('inquiry not found');
    this.rows.set(inquiryId, { ...row, status: 'CLOSED', closedAtMs: nowMs, purgeAtMs });
  }

  async closeIdle(nowMs: number, idleMs: number, purgeYears: number): Promise<number> {
    let closed = 0;
    for (const [id, row] of this.rows) {
      if (row.status !== 'ANSWERED' || row.answeredAtMs === null || row.answeredAtMs + idleMs >= nowMs) continue;
      const purge = (() => {
        const d = new Date(nowMs);
        return Date.UTC(d.getUTCFullYear() + purgeYears, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
      })();
      this.rows.set(id, { ...row, status: 'CLOSED', closedAtMs: nowMs, purgeAtMs: purge });
      closed += 1;
    }
    return closed;
  }

  async outboxRows(): Promise<InquiryCaseRequestRow[]> {
    return this.outbox.map((r) => ({ ...r }));
  }
}
