// 메모리 저장소(시험·로컬 시제품용). 트랜잭션은 한 번에 하나씩 돌고 실패하면 되돌린다(PostgreSQL 저장소와 같은 규칙).
import type { ConflictAttempt, VerificationRecord, VerificationStore, VerificationTx } from '../domain/ports.js';
import { type Attempt, CiAlreadyLinked } from '../domain/verification.js';

interface State {
  attempts: Map<string, Attempt>;
  verifications: Map<string, VerificationRecord>;
  conflicts: ConflictAttempt[];
}

const clone = (s: State): State => ({
  attempts: new Map([...s.attempts].map(([k, v]) => [k, { ...v }])),
  verifications: new Map([...s.verifications].map(([k, v]) => [k, { ...v }])),
  conflicts: s.conflicts.map((c) => ({ ...c })),
});

export class MemoryVerificationStore implements VerificationStore {
  #state: State = { attempts: new Map(), verifications: new Map(), conflicts: [] };
  #queue: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: VerificationTx) => Promise<T>): Promise<T> {
    const run = async () => {
      const s = clone(this.#state);
      const out = await fn({
        insertAttempt: async (a) => {
          s.attempts.set(a.id, { ...a });
        },
        attemptForUpdate: async (id) => {
          const a = s.attempts.get(id);
          return a ? { ...a } : null;
        },
        completeAttempt: async (id, status, now) => {
          const a = s.attempts.get(id);
          if (a) Object.assign(a, { status, completedAt: now });
        },
        verificationOf: async (accountId) => {
          const v = s.verifications.get(accountId);
          return v ? { ...v } : null;
        },
        accountByCiHmac: async (hs, except) => {
          const hits = [...s.verifications].filter(([, v]) => hs.some((h) => v.ciHmac.equals(h))).map(([id]) => id);
          return hits.find((id) => id !== except) ?? hits[0] ?? null;
        },
        saveVerification: async (v) => {
          if ([...s.verifications].some(([id, x]) => id !== v.accountId && x.ciHmac.equals(v.ciHmac))) throw new CiAlreadyLinked();
          s.verifications.set(v.accountId, { ciHmac: v.ciHmac, ciHmacKeyVersion: v.ciHmacKeyVersion, pid: v.pid });
        },
        updateCiHmac: async (accountId, ciHmac, ciHmacKeyVersion) => {
          const v = s.verifications.get(accountId);
          if (v) Object.assign(v, { ciHmac, ciHmacKeyVersion });
        },
        insertConflictAttempt: async (c) => {
          s.conflicts.push({ ...c });
        },
      });
      this.#state = s;
      return out;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  async attempt(id: string): Promise<Attempt | null> {
    const a = this.#state.attempts.get(id);
    return a ? { ...a } : null;
  }

  async isVerified(accountId: string): Promise<boolean> {
    return this.#state.verifications.has(accountId);
  }

  async claimsOf(accountId: string): Promise<{ pid: string } | null> {
    const v = this.#state.verifications.get(accountId);
    return v ? { pid: v.pid.toString('base64url') } : null;
  }

  async recentlyReverified(accountId: string, sessionId: string, since: number): Promise<boolean> {
    return [...this.#state.attempts.values()].some(
      (a) => a.accountId === accountId && a.sessionId === sessionId && a.purpose === 'REVERIFY' && a.status === 'VERIFIED' && a.completedAt !== null && a.completedAt >= since,
    );
  }

  async purgeConflictAttempts(before: number): Promise<number> {
    const n = this.#state.conflicts.length;
    this.#state.conflicts = this.#state.conflicts.filter((c) => c.attemptedAt >= before);
    return n - this.#state.conflicts.length;
  }

  async ciKeyVersionsInUse(): Promise<number[]> {
    return [...new Set([...this.#state.verifications.values()].map((v) => v.ciHmacKeyVersion))].sort((a, b) => a - b);
  }

  /** 시험이 보는 값: 그 계정이 시도한 다른 계정 시도 기록 */
  async conflictAttempts(accountId: string): Promise<ConflictAttempt[]> {
    return this.#state.conflicts.filter((c) => c.attemptedAccountId === accountId).map((c) => ({ ...c }));
  }

  /** 시험이 보는 값: 그 계정의 본인확인 기록 */
  async recordOf(accountId: string): Promise<VerificationRecord | null> {
    const v = this.#state.verifications.get(accountId);
    return v ? { ...v } : null;
  }
}
